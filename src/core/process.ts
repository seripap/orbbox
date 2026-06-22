import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { EventEmitter } from "node:events";
import { CommandError, DriverNotInstalledError, ExecKilledError, SpawnboxError } from "./errors.js";

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
 * Streaming handle returned by `spawnCli`. Mirrors child_process semantics but
 * with a typed `done` promise and convenience event hooks.
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

  constructor(
    child: ChildProcessWithoutNullStreams,
    args: readonly string[],
    private readonly binName: string,
    timeoutMs?: number,
    abort?: AbortSignal,
  ) {
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
        reject(mapSpawnError(err, args, this.binName));
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
 * Run a backend CLI and buffer the output. Throws CommandError on non-zero
 * unless throwOnNonZero is false. Suitable for fast/short commands; use
 * spawnCli for anything where you want progressive output.
 */
export async function runCli(bin: string, args: readonly string[], opts: RunOptions = {}): Promise<RunResult> {
  const proc = spawnCli(bin, args, opts);
  if (opts.stdin !== undefined) proc.writeStdin(opts.stdin);
  else proc.stdin.end();
  try {
    const result = await proc.done;
    if (result.exitCode !== 0 && opts.throwOnNonZero !== false) {
      throw new CommandError(
        `${bin} ${args.join(" ")} exited ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim()}`,
        args,
        result.exitCode,
        result.signal,
        result.stdout,
        result.stderr,
      );
    }
    return result;
  } catch (err) {
    // proc.done already maps spawn errors; don't double-wrap them.
    if (err instanceof SpawnboxError) throw err;
    throw mapSpawnError(err, args, bin);
  }
}

/**
 * Spawn a backend CLI and return a StreamingProcess handle. Caller is
 * responsible for closing stdin and awaiting `.done`.
 */
export function spawnCli(bin: string, args: readonly string[], opts: RunOptions = {}): StreamingProcess {
  const env = { ...process.env, ...(opts.env ?? {}) };
  const child = spawn(bin, args, { env, stdio: ["pipe", "pipe", "pipe"] });
  return new StreamingProcess(child, args, bin, opts.timeoutMs, opts.signal);
}

function mapSpawnError(err: unknown, args: readonly string[], bin: string): Error {
  if (err instanceof CommandError) return err;
  const e = err as NodeJS.ErrnoException;
  if (e?.code === "ENOENT") {
    return new DriverNotInstalledError(`"${bin}" not found on PATH. Is the backend installed?`, { cause: err });
  }
  return new CommandError(`failed to spawn ${bin} ${args.join(" ")}: ${e?.message ?? String(err)}`, args, null, null, "", "");
}
