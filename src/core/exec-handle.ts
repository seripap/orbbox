import type { ExecResult, SpawnHandle } from "./driver.js";
import { runCli, spawnCli } from "./process.js";

export interface CliExecRequest {
  stdin?: string | Buffer;
  timeoutMs?: number;
  throwOnNonZero?: boolean;
  /** Host-process env overlay (e.g. orbctl's ORBENV). Apple injects env via argv. */
  env?: Record<string, string>;
  signal?: AbortSignal;
}

/** Buffered exec of a fully-built backend CLI command line. */
export async function bufferedExec(bin: string, args: readonly string[], req: CliExecRequest): Promise<ExecResult> {
  const result = await runCli(bin, args, {
    stdin: req.stdin,
    timeoutMs: req.timeoutMs,
    env: req.env,
    signal: req.signal,
    throwOnNonZero: req.throwOnNonZero ?? true,
  });
  return { ...result, args };
}

/** Streaming exec of a fully-built backend CLI command line. */
export function streamingExec(bin: string, args: readonly string[], req: CliExecRequest): SpawnHandle {
  const proc = spawnCli(bin, args, { env: req.env, timeoutMs: req.timeoutMs, signal: req.signal });

  if (req.stdin !== undefined) proc.writeStdin(req.stdin);
  else proc.stdin.end();

  const done: Promise<ExecResult> = proc.done.then((r) => ({ ...r, args }));
  const handle: SpawnHandle = {
    process: proc,
    pid: proc.pid,
    stdout: proc.stdout,
    stderr: proc.stderr,
    stdin: proc.stdin,
    done,
    kill: (sig) => proc.kill(sig),
    on(event, listener) {
      proc.on(event, listener);
      return this;
    },
  };
  return handle;
}
