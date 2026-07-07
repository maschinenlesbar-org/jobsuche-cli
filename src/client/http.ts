// HTTP transport built on Node's built-in `http`/`https` modules — no axios,
// no fetch polyfill, no third-party HTTP client.
//
// The transport is a plain function so it can be trivially swapped out in tests
// (inject a `mock.fn()` returning a canned HttpResponse) without touching the
// network. The default implementation below is exercised against a real local
// `http.createServer` in the test-suite.

import http from "node:http";
import https from "node:https";
import { JobsucheNetworkError } from "./errors.js";

export interface HttpRequest {
  method: string;
  /** Fully-qualified absolute URL. */
  url: string;
  headers?: Record<string, string>;
  /** Optional request body (already serialised). */
  body?: string | Buffer;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
  /** Hard cap on the response body size in bytes; the request aborts if exceeded. */
  maxResponseBytes?: number;
}

export interface HttpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

export type Transport = (request: HttpRequest) => Promise<HttpResponse>;

/**
 * Default transport. Resolves with the raw response (including non-2xx) — status
 * interpretation is the client's job. Rejects only on transport-level failures
 * (connection errors, timeouts, malformed URLs).
 */
export const nodeHttpTransport: Transport = (request) =>
  new Promise<HttpResponse>((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      reject(new JobsucheNetworkError(`Invalid URL: ${request.url}`));
      return;
    }

    // Only http/https are supported. Reject anything else up front with a clear,
    // typed error instead of letting Node throw an opaque ERR_INVALID_PROTOCOL
    // (and so this never reaches the file:/ftp:/etc. drivers).
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      reject(new JobsucheNetworkError(`Unsupported protocol "${url.protocol}" in URL: ${request.url}`));
      return;
    }

    const isHttps = url.protocol === "https:";
    const driver = isHttps ? https : http;
    const maxBytes = request.maxResponseBytes;
    const timeoutMs = request.timeoutMs;

    // Wall-clock deadline for the whole request. `req.setTimeout()` alone is an
    // *idle-socket* timeout that resets on every byte, so a slow-drip server that
    // sends one byte just under the idle window (and stays under maxResponseBytes)
    // could keep the request alive indefinitely. A single fixed timer bounds the
    // total time from request start to `end`, independent of the byte cadence.
    let deadline: NodeJS.Timeout | undefined;
    const clearDeadline = (): void => {
      if (deadline !== undefined) {
        clearTimeout(deadline);
        deadline = undefined;
      }
    };

    const req = driver.request(
      url,
      {
        method: request.method,
        headers: request.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let received = 0;
        let aborted = false;

        res.on("data", (chunk: Buffer) => {
          if (aborted) return;
          received += chunk.length;
          if (maxBytes !== undefined && received > maxBytes) {
            aborted = true;
            clearDeadline();
            res.destroy();
            reject(new JobsucheNetworkError(`Response exceeded maxResponseBytes (${maxBytes})`));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          if (aborted) return;
          clearDeadline();
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
        res.on("error", (err) => {
          if (aborted) return; // we already rejected with the size-cap error
          clearDeadline();
          reject(new JobsucheNetworkError(`Response stream error: ${err.message}`, { cause: err }));
        });
      },
    );

    if (timeoutMs && timeoutMs > 0) {
      // Idle-socket timeout (resets on activity)...
      req.setTimeout(timeoutMs, () => {
        req.destroy(new JobsucheNetworkError(`Request timed out after ${timeoutMs}ms`));
      });
      // ...plus a hard wall-clock deadline (does not reset) so a slow drip cannot
      // outlast the caller's timeout budget.
      deadline = setTimeout(() => {
        req.destroy(new JobsucheNetworkError(`Request exceeded the ${timeoutMs}ms deadline`));
      }, timeoutMs);
      // Don't let the deadline timer keep the event loop alive on its own.
      deadline.unref?.();
    }

    req.on("error", (err) => {
      clearDeadline();
      // A timeout destroy already passes an JobsucheNetworkError; don't double-wrap.
      reject(err instanceof JobsucheNetworkError ? err : new JobsucheNetworkError(err.message, { cause: err }));
    });

    if (request.body !== undefined) req.write(request.body);
    req.end();
  });
