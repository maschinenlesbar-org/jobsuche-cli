// I/O seam for the CLI. Everything the CLI writes goes through a CliIO object so
// tests can capture output instead of hitting the real stdout/stderr/filesystem.

import type { JobsucheClient, JobsucheClientOptions } from "../client/client.js";
import type { Transport } from "../client/http.js";
import { JobsucheError } from "../client/errors.js";
import type { CredentialStore } from "./credentials.js";

export interface CliIO {
  out(text: string): void;
  err(text: string): void;
  /**
   * Read a secret for `jobsuche config set`: typed at a prompt without echo, or piped in.
   * Optional: without it, `config set` refuses rather than reading the command line.
   */
  readSecret?(prompt: string): Promise<string>;
}

export interface CliDeps {
  io: CliIO;
  /** Build a client from the resolved global options (injectable for tests). */
  createClient(options: JobsucheClientOptions): JobsucheClient;
  /**
   * Environment variables the CLI reads (e.g. JOBSUCHE_API_KEY). Injectable so
   * the env path is testable in-process; defaults to the real `process.env`.
   */
  env?: Record<string, string | undefined>;
  /**
   * Transport for requests made *outside* the API client — currently only
   * `obtain-key`, which runs before a key (and therefore a client) exists.
   * Defaults to the built-in node:http/https transport.
   */
  transport?: Transport;
  /**
   * The credentials file (`jobsuche config`), consulted for the API key when neither
   * `--api-key` nor `JOBSUCHE_API_KEY` gives one. Optional: deps without it — every test
   * that does not ask for it — never read a credentials file, the user's least of all.
   */
  credentials?: () => CredentialStore;
}

/** The two process streams, as far as `handleOutputErrors` needs them. */
export interface OutputStreams {
  stdout: Pick<NodeJS.WriteStream, "on">;
  stderr: Pick<NodeJS.WriteStream, "on">;
}

/**
 * Handle write errors on stdout/stderr, which Node otherwise reports as an
 * unhandled 'error' event: a raw stack trace and exit 1.
 *
 * A reader that stops early — `| head`, `| jq` exiting on the first match, a closed
 * pager — closes the pipe while the CLI is still writing, and the next write fails
 * with EPIPE (ENOTCONN when stdout is a socket whose peer has gone, as when a Node
 * parent spawns the CLI with piped stdio on macOS). That is ordinary use, so the
 * process exits 0 at once, quietly. Any
 * other stdout error prints one `Output error: <message>` line to stderr and exits
 * 1. On stderr an EPIPE is ignored, so a failed run keeps its exit code; any other
 * stderr error exits 1 silently (there is nowhere left to report it).
 * The bin shim installs this once, before `run()`.
 */
export function handleOutputErrors(
  streams: OutputStreams = process,
  exit: (code: number) => void = (code) => process.exit(code),
): void {
  streams.stdout.on("error", (err: NodeJS.ErrnoException) => {
    if (readerGone(err)) return exit(0);
    process.stderr.write(`Output error: ${err.message}\n`);
    exit(1);
  });
  // stderr's reader going away doesn't make a failed run a success: ignore EPIPE there and
  // let the run's own exit code stand (`2>&1 | head` used to turn a usage error into 0).
  streams.stderr.on("error", (err: NodeJS.ErrnoException) => {
    if (!readerGone(err)) exit(1);
  });
}

/** True for the write errors that mean the reader has gone: EPIPE, or ENOTCONN on a socket. */
function readerGone(err: NodeJS.ErrnoException): boolean {
  return err.code === "EPIPE" || err.code === "ENOTCONN";
}

export const defaultIO: CliIO = {
  out: (text) => process.stdout.write(text + "\n"),
  err: (text) => process.stderr.write(text + "\n"),
  readSecret: (prompt) => readSecretFrom(process.stdin, process.stderr, prompt),
};

/**
 * `CliIO.readSecret` over real streams. From a pipe or a file (`< key.txt`,
 * `jobsuche obtain-key | jobsuche config set api-key`) the whole input, one trailing
 * newline dropped. On a terminal the input is read in raw mode, so nothing is echoed:
 * Enter ends it, Backspace takes a character back, Ctrl-C stops (nothing stored) and
 * Ctrl-D ends it like Enter.
 */
export async function readSecretFrom(
  stdin: NodeJS.ReadStream | NodeJS.ReadableStream,
  stderr: Pick<NodeJS.WriteStream, "write">,
  prompt: string,
): Promise<string> {
  const tty = stdin as NodeJS.ReadStream;
  if (tty.isTTY !== true || typeof tty.setRawMode !== "function") {
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
  }
  stderr.write(prompt);
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (error?: Error): void => {
      tty.removeListener("data", onData);
      tty.setRawMode(false);
      tty.pause();
      stderr.write("\n");
      if (error === undefined) resolve(value);
      else reject(error);
    };
    const onData = (chunk: Buffer | string): void => {
      for (const ch of chunk.toString()) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") return finish();
        if (ch === "\u0003") return finish(new JobsucheError("Interrupted; nothing was stored."));
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else if (ch >= " ") value += ch;
      }
    };
    tty.setRawMode(true);
    tty.resume();
    tty.on("data", onData);
  });
}
