import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { Sandbox } from "../sandbox.js";
import type { CreateConfig } from "../schema.js";
import { listMachines, machineExists, runOrb, assertOrbStackRunning } from "../orb.js";

/**
 * Structural shapes for Flue's sandbox adapter contract. We don't import
 * from `@flue/runtime` (it's an optional peer dep); these types match the
 * surface documented at https://flueframework.com/docs/api/sandbox-api/.
 *
 * The consumer wires their `provider(sandbox)` function with our `flue()`
 * factory, passing Flue's `createSandboxSessionEnv` in. Doing it this way
 * keeps `orbbox` consumable in projects that don't use Flue.
 */

export interface FlueExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface FlueExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface FlueFileStat {
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink?: boolean;
  size?: number;
  mtime?: Date;
}

export interface FlueSandboxApi {
  readFile(path: string): Promise<string>;
  readFileBuffer(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
  stat(path: string): Promise<FlueFileStat>;
  readdir(path: string): Promise<string[]>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  exec(command: string, options?: FlueExecOptions): Promise<FlueExecResult>;
}

export interface FlueSessionEnv {
  readonly id: string;
  readonly api: FlueSandboxApi;
  dispose?(): Promise<void>;
}

export interface FlueSandboxFactory {
  createSessionEnv(options: { id: string }): Promise<FlueSessionEnv>;
}

/**
 * Shape of Flue's `createSandboxSessionEnv` helper. We don't construct
 * `SessionEnv` ourselves — the runtime owns it. Callers pass the helper
 * in so we can hand it our `FlueSandboxApi` and return whatever Flue
 * wraps around it.
 */
export type FlueCreateSessionEnv = <T>(input: { id: string; api: FlueSandboxApi; dispose?: () => Promise<void> }) => T;

export class SandboxOperationUnsupportedError extends Error {
  constructor(operation: string, detail?: string) {
    super(detail ? `${operation}: ${detail}` : `Operation not supported by orbbox: ${operation}`);
    this.name = "SandboxOperationUnsupportedError";
  }
}

export class FileNotFoundError extends Error {
  readonly code = "ENOENT";
  constructor(path: string) {
    super(`No such file or directory: ${path}`);
    this.name = "FileNotFoundError";
  }
}

export interface FlueAdapterConfig {
  /**
   * Flue's `createSandboxSessionEnv` from `@flue/runtime`. Optional — if
   * omitted, `createSessionEnv()` returns a plain `{ id, api, dispose }`
   * object that satisfies Flue's `SessionEnv` structurally. Pass the real
   * runtime helper when you have it; the contract is identical either way.
   */
  createSessionEnv?: FlueCreateSessionEnv;
  /** Underlying create options for per-session machines. */
  create?: CreateConfig;
  /**
   * Name prefix for orbbox-managed machines. Defaults to "flue". Lets you
   * distinguish Flue sessions from Eve sessions in `orbctl list`.
   */
  namePrefix?: string;
  /** Optional log sink for prewarm progress. */
  log?: (msg: string) => void;
  /**
   * When true (default), session machines are cloned from a prewarmed
   * template via `orbctl clone` for fast startup. When false, every
   * `createSessionEnv` provisions from scratch.
   */
  useTemplates?: boolean;
  /**
   * Template key. When `useTemplates` is true, the first `createSessionEnv`
   * provisions and snapshots a template under this key; subsequent calls
   * clone it. Defaults to the namePrefix.
   */
  templateKey?: string;
  /**
   * One-time setup run inside the template before it's snapshotted. Use
   * this to install dependencies, seed files, etc. Receives the underlying
   * orbbox `Sandbox` so you have full access.
   */
  bootstrap?: (sandbox: Sandbox) => Promise<void> | void;
}

const templateCache = new Map<string, string>();

class FlueOrbstackFactory implements FlueSandboxFactory {
  constructor(private readonly config: FlueAdapterConfig) {}

  async createSessionEnv(options: { id: string }): Promise<FlueSessionEnv> {
    await assertOrbStackRunning();
    const sessionName = this.sessionMachineName(options.id);
    const sandbox = await this.acquireSandbox(sessionName);
    const api = new OrbboxFlueSandboxApi(sandbox);
    const dispose = async () => {
      await sandbox.destroy();
    };

    if (this.config.createSessionEnv) {
      return this.config.createSessionEnv<FlueSessionEnv>({ id: options.id, api, dispose });
    }
    return { id: options.id, api, dispose };
  }

  private async acquireSandbox(sessionName: string): Promise<Sandbox> {
    if (this.config.useTemplates === false) {
      return Sandbox.create({ ...this.config.create, name: sessionName });
    }
    const key = this.config.templateKey ?? this.prefix;
    const templateName = await this.ensureTemplate(key);
    if (templateName) {
      return Sandbox.clone(templateName, sessionName);
    }
    return Sandbox.create({ ...this.config.create, name: sessionName });
  }

  private async ensureTemplate(key: string): Promise<string | null> {
    const log = this.config.log ?? (() => {});
    const templateName = this.templateMachineName(key);
    const cached = templateCache.get(key);
    if (cached && (await machineExists(cached))) return cached;
    if (await machineExists(templateName)) {
      templateCache.set(key, templateName);
      return templateName;
    }
    log(`[orbbox/flue] prewarming template ${templateName}`);
    const sandbox = await Sandbox.create({ ...this.config.create, name: templateName });
    try {
      if (this.config.bootstrap) await this.config.bootstrap(sandbox);
      // Quiescent snapshot so clones don't inherit transient state.
      await sandbox.stop();
    } catch (err) {
      await sandbox.destroy().catch(() => {});
      throw err;
    }
    templateCache.set(key, templateName);
    return templateName;
  }

  private templateMachineName(key: string): string {
    return `${this.prefix}-tpl-${sanitize(key)}`;
  }

  private sessionMachineName(id: string): string {
    const rand = randomUUID().slice(0, 6);
    return `${this.prefix}-${sanitize(id)}-${rand}`;
  }

  private get prefix(): string {
    return this.config.namePrefix ?? "flue";
  }
}

/**
 * Flue `SandboxApi` over an orbbox `Sandbox`. Maps Flue's filesystem and
 * exec surface onto orbbox/orbctl. Path resolution follows orbbox's
 * `/workspace` anchoring for relative paths.
 *
 * Exposed publicly so callers running a single shared sandbox (no
 * session-per-id provisioning) can wrap one directly:
 * `new OrbboxFlueSandboxApi(sandbox)`.
 */
export class OrbboxFlueSandboxApi implements FlueSandboxApi {
  constructor(private readonly sandbox: Sandbox) {}

  async readFile(path: string): Promise<string> {
    const text = await this.sandbox.readTextFile(path);
    if (text == null) throw new FileNotFoundError(this.sandbox.resolvePath(path));
    return text;
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    const buf = await this.sandbox.readFile(path);
    if (buf == null) throw new FileNotFoundError(this.sandbox.resolvePath(path));
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    const payload = typeof content === "string" ? content : Buffer.from(content);
    await this.sandbox.writeFile(path, payload);
  }

  async stat(path: string): Promise<FlueFileStat> {
    const resolved = this.sandbox.resolvePath(path);
    // `%s %Y %F` works on both GNU coreutils and BusyBox `stat`.
    const r = await this.sandbox.exec(["stat", "-c", "%s\t%Y\t%F", resolved], { throwOnNonZero: false });
    if (r.exitCode !== 0) {
      if (/No such file|cannot stat|not found/i.test(r.stderr)) throw new FileNotFoundError(resolved);
      throw new Error(`stat ${resolved} failed (exit ${r.exitCode}): ${r.stderr.trim()}`);
    }
    return parseStatLine(r.stdout.trim());
  }

  async readdir(path: string): Promise<string[]> {
    const resolved = this.sandbox.resolvePath(path);
    const r = await this.sandbox.exec(["ls", "-1A", "--", resolved], { throwOnNonZero: false });
    if (r.exitCode !== 0) {
      if (/No such file|cannot access|not found/i.test(r.stderr)) throw new FileNotFoundError(resolved);
      throw new Error(`readdir ${resolved} failed (exit ${r.exitCode}): ${r.stderr.trim()}`);
    }
    return r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  }

  async exists(path: string): Promise<boolean> {
    const resolved = this.sandbox.resolvePath(path);
    const r = await this.sandbox.exec(["sh", "-c", `if [ -e "$1" ]; then exit 0; else exit 1; fi`, "sh", resolved], {
      throwOnNonZero: false,
    });
    return r.exitCode === 0;
  }

  async mkdir(path: string, options: { recursive?: boolean } = {}): Promise<void> {
    const resolved = this.sandbox.resolvePath(path);
    const args = ["mkdir"];
    if (options.recursive) args.push("-p");
    args.push("--", resolved);
    await this.sandbox.exec(args);
  }

  async rm(path: string, options: { recursive?: boolean; force?: boolean } = {}): Promise<void> {
    await this.sandbox.removePath(path, { recursive: options.recursive, force: options.force });
  }

  async exec(command: string, options: FlueExecOptions = {}): Promise<FlueExecResult> {
    options.signal?.throwIfAborted();
    // Use spawn when an abort signal is present so we can kill mid-flight.
    if (options.signal) {
      const handle = this.sandbox.spawn(command, {
        shell: true,
        workdir: options.cwd,
        env: options.env,
        timeoutMs: options.timeoutMs,
        throwOnNonZero: false,
      });
      const onAbort = () => handle.kill("SIGTERM");
      options.signal.addEventListener("abort", onAbort, { once: true });
      try {
        const r = await handle.done;
        options.signal.throwIfAborted();
        return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
      } finally {
        options.signal.removeEventListener("abort", onAbort);
      }
    }
    const r = await this.sandbox.exec(command, {
      shell: true,
      workdir: options.cwd,
      env: options.env,
      timeoutMs: options.timeoutMs,
      throwOnNonZero: false,
    });
    return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
  }
}

/**
 * Build a Flue `SandboxFactory` backed by OrbStack VMs. Wire it into your
 * Flue provider entrypoint:
 *
 * ```ts
 * import { createSandboxSessionEnv } from "@flue/runtime";
 * import { flue } from "orbbox";
 *
 * export function provider(_sandbox: unknown) {
 *   return flue({
 *     createSessionEnv: createSandboxSessionEnv,
 *     create: { distro: "ubuntu", isolated: true, isolateNetwork: true },
 *     bootstrap: async (sb) => {
 *       await sb.exec("apt-get update && apt-get install -y ripgrep", { shell: true });
 *     },
 *   });
 * }
 * ```
 */
export function flue(config: FlueAdapterConfig = {}): FlueSandboxFactory {
  return new FlueOrbstackFactory(config);
}

/** List orbbox-managed Flue machines (template + sessions). */
export async function listFlueMachines(prefix = "flue"): Promise<string[]> {
  const all = await listMachines();
  return all.filter((m) => m.name.startsWith(`${prefix}-`)).map((m) => m.name);
}

/** Delete all orbbox-managed Flue machines. Useful in tests/CI. */
export async function purgeFlueMachines(prefix = "flue"): Promise<void> {
  const names = await listFlueMachines(prefix);
  for (const n of names) {
    await runOrb(["delete", "-f", n], { throwOnNonZero: false });
  }
}

// ---- helpers ----

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 24).toLowerCase() || "anon";
}

export function parseStatLine(line: string): FlueFileStat {
  const [sizeStr, mtimeStr, ...rest] = line.split("\t");
  const kind = rest.join("\t").toLowerCase();
  const size = sizeStr ? Number.parseInt(sizeStr, 10) : NaN;
  const mtimeSec = mtimeStr ? Number.parseInt(mtimeStr, 10) : NaN;
  const stat: FlueFileStat = {
    isFile: /regular (empty )?file/.test(kind),
    isDirectory: /directory/.test(kind),
  };
  if (/symbolic link/.test(kind)) stat.isSymbolicLink = true;
  if (Number.isFinite(size)) stat.size = size;
  if (Number.isFinite(mtimeSec)) stat.mtime = new Date(mtimeSec * 1000);
  return stat;
}
