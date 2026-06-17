import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { EventEmitter } from "node:events";
import {
  ExecKilledError,
  OrbCommandError,
  OrbNotInstalledError,
  OrbNotRunningError,
} from "./errors.js";

/** Where the orb CLI lives. Overridable for tests / nonstandard installs. */
export const ORB_BIN = process.env["ORBBOX_ORB_BIN"] || "orbctl";

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  signal: NodeJS.Signals | null;
  durationMs: number;
}

export interface RunOptions {
  /** Bytes/string written to the child's stdin then closed. */
  stdin?: string | Buffer;
  /** Kill the process after this many ms. */
  timeoutMs?: number;
  /** Don't throw on non-zero exit — return the RunResult anyway. */
  throwOnNonZero?: boolean;
  /** Extra env on top of process.env. */
  env?: Record<string, string>;
  /** AbortSignal for cooperative cancellation. */
  signal?: AbortSignal;
}

/**
 * Streaming handle returned by `spawnOrb`. Mirrors child_process semantics but
 * with a typed `exit` promise and convenience event hooks.
 *
 *   stdout/stderr are Readable streams (pipe, async iterate, .on('data'), ...).
 *   stdin is a Writable. Close it with .end() when done.
 *   `done` resolves with the final RunResult once the process exits.
 */
export class StreamingProcess extends EventEmitter {
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly stdin: Writable;
  readonly pid: number | undefined;
  readonly args: readonly string[];
  readonly done: Promise<RunResult>;

  private child: ChildProcessWithoutNullStreams;
  private killed = false;
  private timeoutHandle: NodeJS.Timeout | null = null;

  constructor(child: ChildProcessWithoutNullStreams, args: readonly string[], timeoutMs?: number, abort?: AbortSignal) {
    super();
    this.child = child;
    this.args = args;
    this.pid = child.pid;
    this.stdout = child.stdout;
    this.stderr = child.stderr;
    this.stdin = child.stdin;

    let stdoutBuf = "";
    let stderrBuf = "";
    const start = performance.now();

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBuf += chunk;
      this.emit("stdout", chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderrBuf += chunk;
      this.emit("stderr", chunk);
    });

    if (timeoutMs) {
      this.timeoutHandle = setTimeout(() => {
        this.killed = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 2000).unref();
      }, timeoutMs);
      this.timeoutHandle.unref();
    }
    if (abort) {
      const onAbort = () => {
        this.killed = true;
        child.kill("SIGTERM");
      };
      if (abort.aborted) onAbort();
      else abort.addEventListener("abort", onAbort, { once: true });
    }

    this.done = new Promise<RunResult>((resolve, reject) => {
      child.on("error", (err) => {
        if (this.timeoutHandle) clearTimeout(this.timeoutHandle);
        reject(mapSpawnError(err, args));
      });
      child.on("close", (code, signal) => {
        if (this.timeoutHandle) clearTimeout(this.timeoutHandle);
        const result: RunResult = {
          stdout: stdoutBuf,
          stderr: stderrBuf,
          exitCode: code ?? -1,
          signal,
          durationMs: performance.now() - start,
        };
        if (this.killed && (signal || code !== 0)) {
          reject(new ExecKilledError(signal));
          return;
        }
        resolve(result);
      });
    });
  }

  /** Write to stdin and close. Convenience for one-shot input. */
  writeStdin(payload: string | Buffer): void {
    this.stdin.write(payload);
    this.stdin.end();
  }

  /** SIGTERM by default, escalates to SIGKILL after 2s. */
  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    this.killed = true;
    this.child.kill(signal);
    if (signal !== "SIGKILL") {
      setTimeout(() => {
        if (!this.child.killed) this.child.kill("SIGKILL");
      }, 2000).unref();
    }
  }
}

/**
 * Run orbctl and buffer the output. Throws OrbCommandError on non-zero unless
 * throwOnNonZero is false. Suitable for fast/short commands; use spawnOrb for
 * anything where you want progressive output.
 */
export async function runOrb(args: readonly string[], opts: RunOptions = {}): Promise<RunResult> {
  const proc = spawnOrb(args, opts);
  if (opts.stdin !== undefined) proc.writeStdin(opts.stdin);
  else proc.stdin.end();
  try {
    const result = await proc.done;
    if (result.exitCode !== 0 && opts.throwOnNonZero !== false) {
      throw new OrbCommandError(
        `orbctl ${args.join(" ")} exited ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim()}`,
        args,
        result.exitCode,
        result.signal,
        result.stdout,
        result.stderr,
      );
    }
    return result;
  } catch (err) {
    if (err instanceof OrbCommandError) throw err;
    if (err instanceof ExecKilledError) throw err;
    throw mapSpawnError(err, args);
  }
}

/**
 * Spawn orbctl and return a StreamingProcess handle. Caller is responsible for
 * closing stdin and awaiting `.done`.
 */
export function spawnOrb(args: readonly string[], opts: RunOptions = {}): StreamingProcess {
  const env = { ...process.env, ...(opts.env ?? {}) };
  const child = spawn(ORB_BIN, args, { env, stdio: ["pipe", "pipe", "pipe"] });
  return new StreamingProcess(child, args, opts.timeoutMs, opts.signal);
}

function mapSpawnError(err: unknown, args: readonly string[]): Error {
  if (err instanceof OrbCommandError) return err;
  const e = err as NodeJS.ErrnoException;
  if (e?.code === "ENOENT") {
    return new OrbNotInstalledError(
      `orbctl binary not found (looked for "${ORB_BIN}"). Is OrbStack installed? See https://orbstack.dev`,
      { cause: err },
    );
  }
  return new OrbCommandError(
    `failed to spawn orbctl ${args.join(" ")}: ${e?.message ?? String(err)}`,
    args,
    null,
    null,
    "",
    "",
  );
}

/** True if `orbctl status` reports a running service. */
export async function isOrbStackRunning(): Promise<boolean> {
  const r = await runOrb(["status"], { throwOnNonZero: false });
  return r.exitCode === 0 && r.stdout.trim().toLowerCase().includes("running");
}

/** Throws OrbNotRunningError if the service is stopped. */
export async function assertOrbStackRunning(): Promise<void> {
  if (!(await isOrbStackRunning())) {
    throw new OrbNotRunningError("OrbStack is not running. Start it from the menu bar or via `orb start`.");
  }
}

/**
 * Machine record as returned by `orbctl list -f json`. Fields are documented
 * from observed output; unknown fields are passed through.
 */
export interface OrbMachineRecord {
  id?: string;
  name: string;
  state?: string;
  status?: string;
  image?: { distro?: string; version?: string; arch?: string };
  config?: Record<string, unknown>;
  [k: string]: unknown;
}

export async function listMachines(): Promise<OrbMachineRecord[]> {
  const r = await runOrb(["list", "-f", "json"]);
  return parseListJson(r.stdout);
}

/** Exposed for unit tests. */
export function parseListJson(stdout: string): OrbMachineRecord[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed);
  if (!Array.isArray(parsed)) {
    throw new OrbCommandError(
      `orbctl list returned non-array JSON: ${trimmed.slice(0, 200)}`,
      ["list", "-f", "json"],
      0,
      null,
      stdout,
      "",
    );
  }
  return parsed as OrbMachineRecord[];
}

export async function infoMachine(name: string): Promise<OrbMachineRecord> {
  const r = await runOrb(["info", name, "-f", "json"]);
  const parsed = JSON.parse(r.stdout.trim()) as { record?: OrbMachineRecord } & OrbMachineRecord;
  // `orbctl info` wraps the machine in `{ record: {...}, disk_size, ip4, ip6 }`.
  // `orbctl list` returns the record at the top level. Normalize to a flat record
  // with the wrapper's extras merged in (disk_size, ip4, ip6) for convenience.
  if (parsed.record && typeof parsed.record === "object") {
    const { record, ...rest } = parsed;
    return { ...record, ...rest };
  }
  return parsed;
}

export async function machineExists(name: string): Promise<boolean> {
  const machines = await listMachines();
  return machines.some((m) => m.name === name);
}
