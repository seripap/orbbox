import { Buffer } from "node:buffer";
import type { Sandbox, SpawnHandle } from "../sandbox.js";

/**
 * Bytes-typed sandbox session compatible with Vercel AI SDK's
 * `Experimental_SandboxSession` (`@ai-sdk/provider-utils`) AND the slice
 * of it that Vercel Eve's `SandboxSession` picks
 * (`run | spawn | readFile | readBinaryFile | readTextFile | writeFile |
 * writeBinaryFile | writeTextFile`).
 *
 * We do not declare `implements Experimental_SandboxSession` because the
 * `ai` package is a peer dep (not a hard dep) — keeping this structural
 * means consumers without the AI SDK still get type-checked code, and
 * consumers WITH it can assign this value to that interface freely.
 *
 * Conventions:
 * - relative paths anchor at `/workspace` (matches Eve)
 * - readBinaryFile returns `null` for missing files
 * - readFile returns a ReadableStream (web stream) of bytes, or `null`
 * - spawn returns ReadableStreams for stdout/stderr and a wait/kill API
 */
export class OrbStackAiSandboxSession {
  readonly id: string;
  readonly description: string;

  constructor(private readonly sandbox: Sandbox, opts: { id?: string; description?: string } = {}) {
    this.id = opts.id ?? sandbox.name;
    this.description = opts.description ?? defaultDescription(sandbox);
  }

  resolvePath(path: string): string {
    return this.sandbox.resolvePath(path);
  }

  async run(options: {
    command: string;
    workingDirectory?: string;
    env?: Record<string, string>;
    abortSignal?: AbortSignal;
  }): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    options.abortSignal?.throwIfAborted();
    const result = await this.sandbox.exec(options.command, {
      shell: true,
      workdir: options.workingDirectory ?? this.sandbox.workspace,
      env: options.env,
      throwOnNonZero: false,
    });
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  }

  async spawn(options: {
    command: string;
    workingDirectory?: string;
    env?: Record<string, string>;
    abortSignal?: AbortSignal;
  }): Promise<AiSandboxProcess> {
    options.abortSignal?.throwIfAborted();
    const handle = this.sandbox.spawn(options.command, {
      shell: true,
      workdir: options.workingDirectory ?? this.sandbox.workspace,
      env: options.env,
      throwOnNonZero: false,
    });
    if (options.abortSignal) {
      const onAbort = () => handle.kill("SIGTERM");
      if (options.abortSignal.aborted) onAbort();
      else options.abortSignal.addEventListener("abort", onAbort, { once: true });
    }
    return new AiSandboxProcess(handle, options.abortSignal);
  }

  async readFile(options: { path: string; abortSignal?: AbortSignal }): Promise<ReadableStream<Uint8Array> | null> {
    const bytes = await this.readBinaryFile(options);
    if (bytes == null) return null;
    return bytesToStream(bytes);
  }

  async readBinaryFile(options: { path: string; abortSignal?: AbortSignal }): Promise<Uint8Array | null> {
    options.abortSignal?.throwIfAborted();
    const buf = await this.sandbox.readFile(options.path);
    if (buf == null) return null;
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  async readTextFile(options: {
    path: string;
    encoding?: string;
    startLine?: number;
    endLine?: number;
    abortSignal?: AbortSignal;
  }): Promise<string | null> {
    const bytes = await this.readBinaryFile({ path: options.path, abortSignal: options.abortSignal });
    if (bytes == null) return null;
    const text = Buffer.from(bytes).toString((options.encoding as BufferEncoding) ?? "utf8");
    if (options.startLine == null && options.endLine == null) return text;
    return sliceLines(text, options.startLine, options.endLine);
  }

  async writeFile(options: { path: string; content: ReadableStream<Uint8Array>; abortSignal?: AbortSignal }): Promise<void> {
    const bytes = await collectStream(options.content);
    await this.writeBinaryFile({ path: options.path, content: bytes, abortSignal: options.abortSignal });
  }

  async writeBinaryFile(options: { path: string; content: Uint8Array; abortSignal?: AbortSignal }): Promise<void> {
    options.abortSignal?.throwIfAborted();
    await this.sandbox.writeFile(options.path, Buffer.from(options.content));
  }

  async writeTextFile(options: { path: string; content: string; encoding?: string; abortSignal?: AbortSignal }): Promise<void> {
    options.abortSignal?.throwIfAborted();
    const buf = Buffer.from(options.content, (options.encoding as BufferEncoding) ?? "utf8");
    await this.sandbox.writeFile(options.path, buf);
  }

  async removePath(options: { path: string; force?: boolean; recursive?: boolean; abortSignal?: AbortSignal }): Promise<void> {
    options.abortSignal?.throwIfAborted();
    await this.sandbox.removePath(options.path, { force: options.force, recursive: options.recursive });
  }

  /**
   * Eve-required setNetworkPolicy hook. OrbStack's network isolation is
   * fixed at create-time via `--isolate-network`, so post-creation policy
   * changes other than `"deny-all"` (already true if isolated) aren't
   * representable. We accept `"allow-all"` / `"deny-all"` as no-ops where
   * they match the current state, and throw otherwise so callers get a
   * loud signal instead of silent non-enforcement.
   */
  async setNetworkPolicy(policy: unknown): Promise<void> {
    if (policy === "allow-all") {
      if (this.sandbox.isolated) {
        throw new Error(
          "OrbStack sandbox was created with --isolate-network; cannot relax to allow-all without recreating the machine.",
        );
      }
      return;
    }
    if (policy === "deny-all") {
      if (!this.sandbox.isolated) {
        throw new Error(
          "OrbStack sandbox was not created isolated; cannot enforce deny-all without recreating the machine. Create with { isolated: true, isolateNetwork: true }.",
        );
      }
      return;
    }
    throw new Error(
      "OrbStack backend supports only \"allow-all\" / \"deny-all\" network policies. Fine-grained policies require a firewall sidecar — open an issue if you need this.",
    );
  }
}

/**
 * Process handle returned by `spawn`. Mirrors `Experimental_SandboxProcess`:
 * web ReadableStream stdout/stderr, `wait()` → exitCode, `kill()`.
 */
export class AiSandboxProcess {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;

  private readonly handle: SpawnHandle;
  private readonly abortSignal: AbortSignal | undefined;

  constructor(handle: SpawnHandle, abortSignal: AbortSignal | undefined) {
    this.handle = handle;
    this.abortSignal = abortSignal;
    const encoder = new TextEncoder();
    let stdoutCtrl: ReadableStreamDefaultController<Uint8Array> | null = null;
    let stderrCtrl: ReadableStreamDefaultController<Uint8Array> | null = null;

    this.stdout = new ReadableStream<Uint8Array>({
      start(c) {
        stdoutCtrl = c;
      },
    });
    this.stderr = new ReadableStream<Uint8Array>({
      start(c) {
        stderrCtrl = c;
      },
    });

    handle.on("stdout", (chunk) => stdoutCtrl?.enqueue(encoder.encode(chunk)));
    handle.on("stderr", (chunk) => stderrCtrl?.enqueue(encoder.encode(chunk)));
    handle.done
      .finally(() => {
        stdoutCtrl?.close();
        stderrCtrl?.close();
      })
      .catch(() => {
        /* errors surface via .wait() */
      });
  }

  async wait(): Promise<{ exitCode: number }> {
    try {
      const r = await this.handle.done;
      if (this.abortSignal?.aborted) {
        throw this.abortSignal.reason ?? new DOMException("Aborted", "AbortError");
      }
      return { exitCode: r.exitCode };
    } catch (err) {
      if (this.abortSignal?.aborted) {
        throw this.abortSignal.reason ?? new DOMException("Aborted", "AbortError");
      }
      throw err;
    }
  }

  async kill(): Promise<void> {
    this.handle.kill("SIGTERM");
  }
}

// ---- helpers ----

function defaultDescription(sandbox: Sandbox): string {
  return [
    `OrbStack sandbox (name: ${sandbox.name}).`,
    `Working directory: ${sandbox.workspace}. Filesystem changes persist for the lifetime of the sandbox.`,
    sandbox.isolated ? "Network is isolated from host and other machines." : "Network shares host networking.",
  ].join("\n");
}

function bytesToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(bytes);
      c.close();
    },
  });
}

async function collectStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

function sliceLines(text: string, startLine?: number, endLine?: number): string {
  const lines = text.split(/\r?\n/);
  const start = Math.max(0, (startLine ?? 1) - 1);
  const end = endLine == null ? lines.length : Math.min(lines.length, endLine);
  return lines.slice(start, end).join("\n");
}

/**
 * Adapter helper: wrap a Sandbox in the AI-SDK-shaped session. Equivalent
 * to `new OrbStackAiSandboxSession(sandbox)`; provided as a function form
 * because that's how the AI SDK ecosystem tends to spell it.
 */
export function toAiSandbox(sandbox: Sandbox, opts: { id?: string; description?: string } = {}): OrbStackAiSandboxSession {
  return new OrbStackAiSandboxSession(sandbox, opts);
}
