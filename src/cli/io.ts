// I/O seam for the CLI. Everything the CLI writes goes through a CliIO object so
// tests can capture output instead of hitting the real stdout/stderr/filesystem.

import type { JobsucheClient, JobsucheClientOptions } from "../client/client.js";

export interface CliIO {
  out(text: string): void;
  err(text: string): void;
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
}

export const defaultIO: CliIO = {
  out: (text) => process.stdout.write(text + "\n"),
  err: (text) => process.stderr.write(text + "\n"),
};
