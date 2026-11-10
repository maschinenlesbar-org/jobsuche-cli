// HTTP transport built on Node's built-in `http`/`https` modules — no axios,
// no fetch polyfill, no third-party HTTP client.
//
// The transport is a plain function so it can be trivially swapped out in tests
// (inject a `mock.fn()` returning a canned HttpResponse) without touching the
// network. The default implementation below is exercised against a real local
// `http.createServer` in the test-suite.

import http from "node:http";
import https from "node:https";
import { JobsucheNetworkError, JobsucheResponseTooLargeError, redactUrl, credentialsIn, redactCredentials } from "./errors.js";

export interface HttpRequest {
  method: string;
  /** Fully-qualified absolute URL. */
  url: string;
  headers?: Record<string, string>;
  /** Optional request body (already serialised). */
  body?: string | Buffer;
  /** Per-request timeout in milliseconds, whole response included. */
  timeoutMs?: number;
  /** Hard cap on the response body size in bytes; the request aborts if exceeded. */
  maxResponseBytes?: number;
  /**
   * Always `"manual"` from the engine: a transport must not follow redirects but
   * return the 3xx as it came (`fetch(url, { redirect: req.redirect })`). The engine
   * follows them itself and decides per hop where credentials may go; a response
   * whose `url` shows the transport went to another origin is rejected.
   */
  redirect?: "manual";
  /**
   * Aborted when the engine's time limit (`timeoutMs`) passes. A transport should stop
   * the request then (`fetch(url, { signal })`); the engine rejects at the deadline
   * either way, and enforces `maxResponseBytes` on the body it gets back, so neither
   * limit depends on the transport.
   */
  signal?: AbortSignal;
}

/**
 * What a transport resolves with. The engine is lenient about the shapes custom
 * transports naturally return: `headers` may be a plain object with names in any
 * case, a `Headers` instance or a `Map`; `body` may be a Buffer, any other
 * ArrayBuffer view (a `Uint8Array` from fetch, a DataView), an ArrayBuffer or a
 * string (read as UTF-8). Anything else — a missing status, no body — is a
 * JobsucheNetworkError.
 */
export interface HttpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  /**
   * The URL that answered, if the transport knows it (fetch's `response.url`). When it
   * is on another origin than the request's, the transport followed a redirect itself
   * and the engine fails the request (`JobsucheNetworkError`).
   */
  url?: string;
}

export type Transport = (request: HttpRequest) => Promise<HttpResponse>;

/** The message for a body over the size cap, naming the option on both sides. */
export function sizeLimitMessage(maxBytes: number): string {
  return `Response exceeded maxResponseBytes (${maxBytes} bytes; --max-response-bytes on the CLI)`;
}

/**
 * The longest delay Node's timers support (2^31 - 1 ms, about 24.8 days). A longer one
 * prints a TimeoutOverflowWarning and fires after 1 ms, so timeouts are capped here.
 */
export const MAX_TIMEOUT_MS = 2_147_483_647;

/** The most received chunks the default transport keeps unjoined. */
const COALESCE_CHUNKS = 1024;
/** The bytes of unjoined chunks at which the default transport joins them into one Buffer. */
const COALESCE_BYTES = 64 * 1024;

/**
 * `url` for a message, its userinfo redacted; one typed without its scheme (`user:pw@host`,
 * `TOKEN:@host`) is read as if it had one, since `redactUrl` finds a userinfo only after a scheme.
 */
function shownUrl(url: string): string {
  return credentialsIn(url).length > 0 ? redactUrl(url) : redactCredentials(url, credentialsIn(`http://${url}`));
}

/**
 * Default transport. Resolves with the raw response (including non-2xx) — status
 * interpretation is the client's job. Rejects only on transport-level failures
 * (connection errors, timeouts, malformed URLs). Small chunks of a body are joined as they
 * arrive (COALESCE_CHUNKS of them or COALESCE_BYTES), so its memory follows the bytes, not
 * the number of chunks a server sends.
 */
export const nodeHttpTransport: Transport = (request) =>
  new Promise<HttpResponse>((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      reject(new JobsucheNetworkError(`Invalid URL: ${shownUrl(request.url)}`));
      return;
    }

    // Only http/https are supported. Reject anything else up front with a clear,
    // typed error instead of letting Node throw an opaque ERR_INVALID_PROTOCOL
    // (and so this never reaches the file:/ftp:/etc. drivers).
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      // `user:password@host` without a scheme parses with the user name as the scheme: name a
      // scheme only when the value spells one (`<scheme>://`).
      const named = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(request.url) ? ` "${url.protocol}"` : "";
      reject(new JobsucheNetworkError(`Unsupported protocol${named} in URL: ${shownUrl(request.url)}`));
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

    // driver.request throws synchronously for a header value Node cannot send (CR/LF,
    // a character above U+00FF); surface that as a typed error, not a raw TypeError.
    let req: http.ClientRequest;
    try {
      req = driver.request(
        url,
        {
          method: request.method,
          headers: request.headers,
        },
        (res) => {
          // Small chunks are joined as they arrive (`pending`, at most COALESCE_CHUNKS of them
          // or COALESCE_BYTES), so the Buffers kept follow the bytes, not the number of chunks
          // a server chooses to send: a Buffer per one-byte chunk held ~210 bytes of heap each.
          const chunks: Buffer[] = [];
          let pending: Buffer[] = [];
          let pendingBytes = 0;
          let received = 0;
          let aborted = false;

          res.on("data", (chunk: Buffer) => {
            if (aborted) return;
            received += chunk.length;
            if (maxBytes !== undefined && received > maxBytes) {
              aborted = true;
              clearDeadline();
              res.destroy();
              reject(new JobsucheResponseTooLargeError(sizeLimitMessage(maxBytes), maxBytes));
              return;
            }
            pending.push(chunk);
            pendingBytes += chunk.length;
            if (pending.length >= COALESCE_CHUNKS || pendingBytes >= COALESCE_BYTES) {
              chunks.push(pending.length === 1 ? chunk : Buffer.concat(pending, pendingBytes));
              pending = [];
              pendingBytes = 0;
            }
          });
          res.on("end", () => {
            if (aborted) return;
            clearDeadline();
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat([...chunks, ...pending]),
            });
          });
          res.on("error", (err) => {
            if (aborted) return; // we already rejected with the size-cap error
            clearDeadline();
            reject(new JobsucheNetworkError(`Response stream error: ${err.message}`, { cause: err }));
          });
        },
      );
    } catch (err) {
      clearDeadline();
      reject(
        new JobsucheNetworkError(`Invalid request: ${err instanceof Error ? err.message : String(err)}`, {
          cause: err,
        }),
      );
      return;
    }

    if (timeoutMs && timeoutMs > 0) {
      const delayMs = Math.min(timeoutMs, MAX_TIMEOUT_MS);
      // Idle-socket timeout (resets on activity)...
      req.setTimeout(delayMs, () => {
        req.destroy(new JobsucheNetworkError(`Request timed out after ${timeoutMs}ms`));
      });
      // ...plus a hard wall-clock deadline (does not reset) so a slow drip cannot
      // outlast the caller's timeout budget.
      deadline = setTimeout(() => {
        req.destroy(new JobsucheNetworkError(`Request exceeded the ${timeoutMs}ms deadline`));
      }, delayMs);
      // Don't let the deadline timer keep the event loop alive on its own.
      deadline.unref?.();
    }

    if (request.signal !== undefined) {
      const signal = request.signal;
      const abort = (): void => {
        const reason: unknown = signal.reason;
        req.destroy(reason instanceof JobsucheNetworkError ? reason : new JobsucheNetworkError("Request aborted"));
      };
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    }

    req.on("error", (err) => {
      clearDeadline();
      // A timeout destroy already passes an JobsucheNetworkError; don't double-wrap.
      reject(err instanceof JobsucheNetworkError ? err : new JobsucheNetworkError(err.message, { cause: err }));
    });

    if (request.body !== undefined) req.write(request.body);
    req.end();
  });
