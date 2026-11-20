// How the MCP server reaches this repository's client. The server's generic files (server.ts,
// limiter.ts, config.ts, run.ts, result.ts, credentials.ts: the kit, the same in every
// repository) import the client only through this file, under the names below; the names on the
// right are this client's. Per repository, like tools.ts: a client whose names or functions differ
// adapts here.
//
// The Jobsuche API needs its public X-API-Key. No key is bundled: `findCredentials` (the kit's
// hook, credentials.ts) takes it, at the first tool call, from JOBSUCHE_API_KEY, else from the
// credentials file `jobsuche config set api-key` writes, else obtains the published key with the
// client's obtainKey, as `jobsuche obtain-key` does. Never from argv.

import { CredentialStore, API_KEY_CREDENTIAL } from "@maschinenlesbar.org/jobsuche-client/internal/credentials";
import { DEFAULT_BASE_URL } from "@maschinenlesbar.org/jobsuche-client";
import { API_KEY_ENV_VAR, obtainKey } from "@maschinenlesbar.org/jobsuche-client/internal/obtain-key";
import { JobsucheValidationError } from "@maschinenlesbar.org/jobsuche-client/internal/errors";
import { headerValueProblem } from "@maschinenlesbar.org/jobsuche-client/internal/validate";
import type { CredentialContext, FoundCredentials } from "./credentials.js";

export {
  JobsucheClient as Client,
  JobsucheError as ClientError,
  JobsucheNetworkError as NetworkError,
  baseUrlProblem,
  DEFAULT_BASE_URL,
  MAX_TIMEOUT_MS,
  nodeHttpTransport,
  type HttpRequest,
  type HttpResponse,
  type Transport,
} from "@maschinenlesbar.org/jobsuche-client";
export { sizeLimitMessage } from "@maschinenlesbar.org/jobsuche-client/internal/http";
export { cutText, toWellFormed } from "@maschinenlesbar.org/jobsuche-client/internal/errors";

/** The service's path under the host: every endpoint is below it. */
export const SERVICE_PATH = "/jobboerse/jobsuche-service";

/** The API's base URL as a result's `source` starts with it (`--base-url`, else the default, and the service's path). */
export function apiBase(baseUrl: string | undefined): string {
  return `${(baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "")}${SERVICE_PATH}`;
}

/**
 * The API key, in this order: JOBSUCHE_API_KEY from the server's environment (what an MCP
 * client's config sets), the credentials file (`jobsuche config set api-key`; only when the
 * server runs from its bin), or the public key obtained from the document that publishes it.
 * A JOBSUCHE_API_KEY no header can carry, and a credentials file `jobsuche config` would refuse
 * (others can read it, a hand-edited value), are errors naming the fix: never silently skipped.
 * Every form of the key is a secret of the server from here on.
 */
export async function findCredentials(context: CredentialContext): Promise<FoundCredentials> {
  const fromEnv = context.env[API_KEY_ENV_VAR];
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    const key = fromEnv.trim();
    const problem = headerValueProblem(key);
    if (problem !== undefined) throw new JobsucheValidationError(`Invalid ${API_KEY_ENV_VAR} in the server's environment: ${problem}`);
    return { clientOptions: { apiKey: key }, secrets: [fromEnv, key], source: `the API key from the ${API_KEY_ENV_VAR} environment variable` };
  }
  if (context.credentialsFile) {
    const store = CredentialStore.fromEnv(context.env);
    const raw = store.get(API_KEY_CREDENTIAL);
    const stored = store.usable(API_KEY_CREDENTIAL);
    if (stored !== undefined) {
      return { clientOptions: { apiKey: stored }, secrets: [raw ?? stored, stored], source: `the API key stored in ${store.path} (jobsuche config)` };
    }
  }
  const obtained = await obtainKey({
    transport: context.transport,
    timeoutMs: context.timeoutMs,
    userAgent: context.userAgent,
    maxResponseBytes: context.maxResponseBytes,
  });
  return {
    clientOptions: { apiKey: obtained.key },
    secrets: [obtained.key],
    source: `the public API key obtained from ${obtained.sourceUrl} (${API_KEY_ENV_VAR} is not set${context.credentialsFile ? " and no key is stored" : ""})`,
  };
}
