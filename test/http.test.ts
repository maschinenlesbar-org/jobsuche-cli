import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { nodeHttpTransport } from "../src/client/http.js";
import { JobsucheNetworkError } from "../src/client/errors.js";

/** Start a throwaway loopback server for one test and return its base URL. */
async function withServer(
  handler: http.RequestListener,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no address");
  try {
    await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("performs a real GET and returns status, headers and body", async () => {
  await withServer(
    (req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ path: req.url }));
    },
    async (baseUrl) => {
      const resp = await nodeHttpTransport({ method: "GET", url: `${baseUrl}/jobboerse/jobsuche-service/` });
      assert.equal(resp.status, 200);
      assert.equal(resp.headers["content-type"], "application/json");
      assert.deepEqual(JSON.parse(resp.body.toString("utf8")), { path: "/jobboerse/jobsuche-service/" });
    },
  );
});

test("rejects an unsupported protocol with JobsucheNetworkError", async () => {
  await assert.rejects(
    () => nodeHttpTransport({ method: "GET", url: "ftp://example.test/x" }),
    JobsucheNetworkError,
  );
});

test("enforces maxResponseBytes", async () => {
  await withServer(
    (_req, res) => res.end("x".repeat(1000)),
    async (baseUrl) => {
      await assert.rejects(
        () => nodeHttpTransport({ method: "GET", url: baseUrl, maxResponseBytes: 10 }),
        JobsucheNetworkError,
      );
    },
  );
});

test("a timeoutMs beyond Node's timer range is capped, not fired after 1 ms", async () => {
  const warnings: string[] = [];
  const onWarning = (warning: Error) => void warnings.push(warning.name);
  process.on("warning", onWarning);
  try {
    await withServer(
      (_req, res) => void setTimeout(() => res.end("{}"), 50),
      async (baseUrl) => {
        const resp = await nodeHttpTransport({ method: "GET", url: baseUrl, timeoutMs: 3_000_000_000 });
        assert.equal(resp.body.toString("utf8"), "{}");
      },
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(warnings.filter((name) => name === "TimeoutOverflowWarning"), []);
  } finally {
    process.off("warning", onWarning);
  }
});

test("a slow-drip response is bounded by the wall-clock deadline", async () => {
  // The server dribbles one byte every 20ms and never ends. Each byte resets the
  // idle-socket timeout, so without a separate wall-clock deadline the request
  // would hang forever while staying under maxResponseBytes. The deadline must
  // still fire and surface a JobsucheNetworkError.
  const timers: NodeJS.Timeout[] = [];
  await withServer(
    (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      const t = setInterval(() => res.write("x"), 20);
      timers.push(t);
      res.on("close", () => clearInterval(t));
    },
    async (baseUrl) => {
      await assert.rejects(
        () => nodeHttpTransport({ method: "GET", url: baseUrl, timeoutMs: 80 }),
        (err: unknown) => {
          assert.ok(err instanceof JobsucheNetworkError);
          // The wall-clock deadline, not the idle timeout, is what caught it.
          assert.match(err.message, /deadline/);
          return true;
        },
      );
    },
  );
  for (const t of timers) clearInterval(t);
});

test("a header Node cannot send is a JobsucheNetworkError, not a raw TypeError", async () => {
  await assert.rejects(
    () => nodeHttpTransport({ method: "GET", url: "http://127.0.0.1:1/", headers: { "User-Agent": "a\r\nb" } }),
    (err: unknown) => err instanceof JobsucheNetworkError && /^Invalid request: /.test(err.message),
  );
});
