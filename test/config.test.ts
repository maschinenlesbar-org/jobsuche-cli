// `jobsuche config` and the credentials file: the API key kept apart from argv and the
// environment, the same mechanism as openka-cli's `ka config`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { run } from "../src/cli/run.js";
import { JobsucheClient } from "../src/client/client.js";
import type { CliDeps } from "../src/cli/io.js";
import { readSecretFrom } from "../src/cli/io.js";
import { CredentialStore, maskCredential, resolveCredentialsPath } from "../src/cli/credentials.js";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";
import { makeMockTransport, okResponse, rawResponse, untimed } from "./helpers.js";

const KEY = "jobboerse-jobsuche-0123456789";

/** A CLI whose credentials file lives in a temporary directory, and whose secret prompt answers `secret`. */
function makeCli(
  options: {
    env?: Record<string, string | undefined>;
    secret?: string;
    credentials?: boolean;
    responder?: (req: HttpRequest) => HttpResponse;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "jobsuche-config-"));
  const store = new CredentialStore(join(dir, "jobsuche", "credentials"));
  const out: string[] = [];
  const err: string[] = [];
  const mt = makeMockTransport(options.responder ?? okResponse);
  const deps: CliDeps = {
    io: {
      out: (s) => out.push(s),
      err: (s) => err.push(s),
      ...(options.secret === undefined ? {} : { readSecret: async () => options.secret as string }),
    },
    createClient: (opts) => new JobsucheClient({ ...opts, transport: mt.transport }),
    env: options.env ?? {},
    ...(options.credentials === false ? {} : { credentials: () => store }),
  };
  return { deps, out, err, mt, store, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("config set stores the key from the prompt, mode 0600 in a 0700 directory, and shows it masked", async () => {
  const cli = makeCli({ secret: `${KEY}\n` });
  try {
    assert.equal(await run(["config", "set", "api-key"], cli.deps), 0);
    assert.equal(cli.store.get("api-key"), KEY);
    assert.equal(statSync(cli.store.path).mode & 0o777, 0o600);
    assert.equal(statSync(join(cli.dir, "jobsuche")).mode & 0o777, 0o700);
    assert.match(untimed(cli.err.join("\n")), /^INFO  \[jobsuche\.config\] Stored api-key \(jobb…6789\) in /);
    assert.doesNotMatch(cli.err.join("\n") + cli.out.join("\n"), new RegExp(KEY));

    cli.out.length = 0;
    assert.equal(await run(["config", "get", "api-key"], cli.deps), 0);
    assert.deepEqual(cli.out, ["jobb…6789"]);
    cli.out.length = 0;
    assert.equal(await run(["config", "get", "api-key", "--reveal"], cli.deps), 0);
    assert.deepEqual(cli.out, [KEY]);
    cli.out.length = 0;
    cli.err.length = 0;
    assert.equal(await run(["config", "list"], cli.deps), 0);
    assert.deepEqual(cli.out, ["api-key  jobb…6789"]);
    assert.deepEqual(cli.err.map(untimed), [`INFO  [jobsuche.config] Credentials file: ${cli.store.path}`]);

    assert.equal(await run(["config", "unset", "api-key"], cli.deps), 0);
    assert.equal(cli.store.get("api-key"), undefined);
    assert.equal(await run(["config", "unset", "api-key"], cli.deps), 1);
    assert.equal(await run(["config", "get", "api-key"], cli.deps), 1);
  } finally {
    cli.cleanup();
  }
});

test("config set never takes the value from the command line, and never repeats it", async () => {
  const cli = makeCli({ secret: KEY });
  try {
    assert.equal(await run(["config", "set", "api-key", KEY], cli.deps), 2);
    assert.match(cli.err.join("\n"), /takes the name only/);
    assert.doesNotMatch(cli.err.join("\n") + cli.out.join("\n"), new RegExp(KEY));
    assert.equal(cli.store.get("api-key"), undefined);
    assert.equal(await run(["config", "set", "password"], cli.deps), 2, "an unknown name");
  } finally {
    cli.cleanup();
  }
});

test("config set refuses a blank value, one with whitespace inside or one no header can carry, and stores nothing", async () => {
  for (const secret of ["", "   ", "two words", "schlüssel€"]) {
    const cli = makeCli({ secret });
    try {
      assert.equal(await run(["config", "set", "api-key"], cli.deps), 2, JSON.stringify(secret));
      assert.match(cli.err.join("\n"), /Nothing was stored/);
      assert.equal(cli.store.get("api-key"), undefined);
    } finally {
      cli.cleanup();
    }
  }
});

test("the stored key is sent when neither --api-key nor JOBSUCHE_API_KEY gives one, and only then", async () => {
  const cli = makeCli({ secret: KEY });
  const fromEnv = makeCli({ env: { JOBSUCHE_API_KEY: "env-key-1234" } });
  try {
    await run(["config", "set", "api-key"], cli.deps);
    assert.equal(await run(["search", "--was", "x"], cli.deps), 0);
    assert.equal(cli.mt.last().headers?.["X-API-Key"], KEY);
    // The env var and the flag come first.
    const viaEnv = { ...fromEnv.deps, credentials: () => cli.store };
    assert.equal(await run(["search", "--was", "x"], viaEnv), 0);
    assert.equal(fromEnv.mt.last().headers?.["X-API-Key"], "env-key-1234");
    assert.equal(await run(["--api-key", "flag-key-1234", "search", "--was", "x"], viaEnv), 0);
    assert.equal(fromEnv.mt.last().headers?.["X-API-Key"], "flag-key-1234");
  } finally {
    fromEnv.cleanup();
    cli.cleanup();
  }
});

test("a credentials file others can read is refused, and only when it is needed", async () => {
  const cli = makeCli();
  try {
    cli.store.set("api-key", KEY);
    chmodSync(cli.store.path, 0o644);
    assert.equal(await run(["search", "--was", "x"], cli.deps), 1);
    assert.match(cli.err.join("\n"), /can be read by others \(mode 644\).*chmod 600/);
    assert.equal(cli.mt.calls.length, 0, "no request without the key it was meant to carry");
    // A key given another way does not read the file at all.
    assert.equal(await run(["--api-key", "flag-key-1234", "search", "--was", "x"], cli.deps), 0);
    const viaEnv = { ...cli.deps, env: { JOBSUCHE_API_KEY: "env-key-1234" } };
    assert.equal(await run(["search", "--was", "x"], viaEnv), 0);
  } finally {
    cli.cleanup();
  }
});

test("an empty 403 with a stored key gets the wrong-key hint, not the no-key one", async () => {
  const cli = makeCli({ secret: KEY, responder: () => rawResponse(" ", "text/plain", 403) });
  try {
    await run(["config", "set", "api-key"], cli.deps);
    assert.equal(await run(["search", "--was", "x"], cli.deps), 3);
    assert.equal(cli.mt.last().headers?.["X-API-Key"], KEY);
    assert.match(cli.err.join("\n"), /jobsuche config set api-key/);
    assert.match(cli.err.join("\n"), /Check the key/);
    assert.doesNotMatch(cli.err.join("\n"), /no X-API-Key was sent/);
  } finally {
    cli.cleanup();
  }
});

test("deps without a credentials store never read a credentials file", async () => {
  const cli = makeCli({ credentials: false, env: { XDG_CONFIG_HOME: "/nonexistent" } });
  try {
    assert.equal(await run(["search", "--was", "x"], cli.deps), 0);
    assert.equal(cli.mt.last().headers?.["X-API-Key"], undefined);
    assert.equal(await run(["config", "list"], cli.deps), 1);
  } finally {
    cli.cleanup();
  }
});

test("the credentials file: where it is, what it refuses, and how it masks", () => {
  assert.equal(resolveCredentialsPath({ XDG_CONFIG_HOME: "/x" }), "/x/jobsuche/credentials");
  assert.equal(resolveCredentialsPath({ XDG_CONFIG_HOME: "relative", HOME: "/home/me" }), "/home/me/.config/jobsuche/credentials");
  assert.equal(resolveCredentialsPath({ HOME: "/home/me" }), "/home/me/.config/jobsuche/credentials");
  assert.equal(maskCredential("short"), "****");
  const dir = mkdtempSync(join(tmpdir(), "jobsuche-store-"));
  try {
    const path = join(dir, "credentials");
    writeFileSync(path, "{ not json", { mode: 0o600 });
    assert.throws(() => new CredentialStore(path).get("api-key"), /not valid JSON/);
    writeFileSync(path, JSON.stringify({ "api-key": 5 }), { mode: 0o600 });
    assert.throws(() => new CredentialStore(path).get("api-key"), /not an object of names and strings/);
    mkdirSync(join(dir, "real"));
    writeFileSync(join(dir, "real", "credentials"), JSON.stringify({ "api-key": KEY }), { mode: 0o600 });
    symlinkSync(join(dir, "real", "credentials"), join(dir, "link"));
    assert.throws(() => new CredentialStore(join(dir, "link")).get("api-key"), /not a regular file/);
    const store = new CredentialStore(join(dir, "fresh", "credentials"));
    store.set("api-key", KEY);
    assert.deepEqual(JSON.parse(readFileSync(store.path, "utf8")), { "api-key": KEY });
    assert.throws(() => store.set("API KEY", KEY), /Not a credential name/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a secret piped in is read whole, one trailing newline dropped", async () => {
  assert.equal(await readSecretFrom(Readable.from([`${KEY}\n`]), { write: () => true }, "api-key: "), KEY);
});

test("an unwritable config location names the credentials file, for set and for the last unset (C4)", async (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) return t.skip("needs POSIX permissions and a non-root user");
  const cli = makeCli({ secret: KEY });
  try {
    // The parent of the program's directory cannot be written: mkdir fails.
    const parent = join(cli.dir, "jobsuche");
    mkdirSync(cli.dir, { recursive: true });
    chmodSync(cli.dir, 0o500);
    assert.equal(await run(["config", "set", "api-key"], cli.deps), 1);
    assert.match(cli.err.join("\n"), /Could not write the credentials file .*credentials: EACCES/);
    assert.doesNotMatch(cli.err.join("\n"), /Unexpected error/);
    chmodSync(cli.dir, 0o700);

    // The last name removed from a file in a directory that cannot be written: rm fails.
    cli.err.length = 0;
    cli.store.set("api-key", KEY);
    chmodSync(parent, 0o500);
    assert.equal(await run(["config", "unset", "api-key"], cli.deps), 1);
    assert.match(cli.err.join("\n"), /Could not write the credentials file .*credentials: EACCES/);
    assert.doesNotMatch(cli.err.join("\n"), /Unexpected error/);
    // The path once, in the sentence; not again in the system's reason (rm repeated it twice).
    assert.equal(cli.err.join("\n").split(cli.store.path).length - 1, 1, cli.err.join("\n"));
    chmodSync(parent, 0o700);
    assert.equal(cli.store.get("api-key"), KEY, "nothing was lost");
  } finally {
    chmodSync(cli.dir, 0o700);
    if (existsSync(join(cli.dir, "jobsuche"))) chmodSync(join(cli.dir, "jobsuche"), 0o700);
    cli.cleanup();
  }
});
