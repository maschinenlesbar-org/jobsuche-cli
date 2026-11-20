// Test helpers of this server's own tests and the adapters of the conformance tests: a mock of
// the Jobsuche API on its own paths (the search and the details endpoints) answering with the
// client's recorded answers (recorded.ts, live on 2026-11-20), and the client's transport helpers.
// The generic harness (a connection, a config, a log recorder, the HTTP server) is harness.ts; it
// gives the server TEST_ENV, so no test reads a credentials file or obtains a key.

import { jsonResponse, makeMockTransport, type MockTransport } from "@maschinenlesbar.org/jobsuche-client/test/helpers";
import { DETAILS_10000_1183204759_S, HUNT_DATA_ENGINEER_MUENCHEN } from "@maschinenlesbar.org/jobsuche-client/test/recorded";

export * from "@maschinenlesbar.org/jobsuche-client/test/helpers";
export * from "@maschinenlesbar.org/jobsuche-client/test/recorded";

/** The test key the server finds in its environment (harness.ts); never a real one. */
export const TEST_KEY = "test-key-only";

/** The environment every server of these tests sees, unless a test passes its own. */
export const TEST_ENV: Record<string, string> = { JOBSUCHE_API_KEY: TEST_KEY };

/** No match: no ergebnisliste, no facetten. */
export const NO_MATCH = { maxErgebnisse: 0, page: 1, size: 100 };

/**
 * The Jobsuche API: `/pc/v6/jobs` answered by `search` (default: the recorded Data Engineer
 * search), `/pc/v4/jobdetails/<code>` by `details` with the decoded refnr (default: the recorded
 * listing; undefined is a 404), anything else 404.
 */
export function jobsucheApi(options: { search?: (query: URLSearchParams) => unknown; details?: (refnr: string) => unknown } = {}): MockTransport {
  return makeMockTransport((request) => {
    const url = new URL(request.url);
    const code = url.pathname.match(/\/pc\/v4\/jobdetails\/([^/]+)$/)?.[1];
    if (code !== undefined) {
      const refnr = Buffer.from(decodeURIComponent(code), "base64").toString("utf8");
      const answer = options.details === undefined ? DETAILS_10000_1183204759_S : options.details(refnr);
      return answer === undefined ? jsonResponse({ message: "not found" }, 404) : jsonResponse(answer);
    }
    if (url.pathname.endsWith("/pc/v6/jobs")) return jsonResponse(options.search === undefined ? HUNT_DATA_ENGINEER_MUENCHEN : options.search(url.searchParams));
    return jsonResponse({ message: "no such path" }, 404);
  });
}
