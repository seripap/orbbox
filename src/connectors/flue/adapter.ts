import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { Sandbox } from "../../core/sandbox.js";
import type { CreateConfig } from "../../core/schema.js";
import { resolveDriver } from "../../core/registry.js";
import type { SandboxDriver } from "../../core/driver.js";

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
  /** Underlying create options for per-session sandboxes (includes `driver`). */
  create?: CreateConfig;
  /**
   * Name prefix for spawnbox-managed sandboxes. Defaults to "flue". Lets you
   * distinguish Flue sessions from Eve sessions in the backend's list.
   */
  namePrefix?: string;
  /** Optional log sink for prewarm progress. */
  log?: (msg: string) => void;
  /**
   * When true (default), session sandboxes are cloned from a prewarmed template
   * for fast startup on drivers that support cheap snapshots. On drivers without
   * clone support, or when false, every `createSessionEnv` provisions fresh.
   */
  useTemplates?: boolean;
  /**
   * Template key. When `useTemplates` is true, the first `createSessionEnv`
   * provisions and snapshots a template under this key; subsequent calls
   * clone it. Defaults to the namePrefix.
   */
  templateKey?: string;
  /**
   * One-time setup run inside the template before it's snapshotted. Use this to
   * install dependencies, seed files, etc. Receives the underlying spawnbox
   * `Sandbox` so you have full access.
   */
  bootstrap?: (sandbox: Sandbox) => Promise<void> | void;
}

const templateCache = new Map<string, string>();

class FlueSandboxFactoryImpl implements FlueSandboxFactory {
  private driverPromise: Promise<SandboxDriver> | null = null;

  constructor(private readonly config: FlueAdapterConfig) {}

  private driver(): Promise<SandboxDriver> {
    if (!this.driverPromise) this.driverPromise = resolveDriver(this.config.create?.driver ?? "auto");
    return this.driverPromise;
  }

  async createSessionEnv(options: { id: string }): Promise<FlueSessionEnv> {
    const driver = await this.driver();
    await driver.preflight();
    const sessionName = this.sessionMachineName(options.id);
    const sandbox = await this.acquireSandbox(driver, sessionName);
    const api = new SandboxFlueApi(sandbox);
    const dispose = async () => {
      await sandbox.destroy();
    };

    if (this.config.createSessionEnv) {
      return this.config.createSessionEnv<FlueSessionEnv>({ id: options.id, api, dispose });
    }
    return { id: options.id, api, dispose };
  }

  private async acquireSandbox(driver: SandboxDriver, sessionName: string): Promise<Sandbox> {
    if (this.config.useTemplates === false || !driver.capabilities.clone) {
      return Sandbox.create({ ...this.config.create, name: sessionName });
    }
    const key = this.config.templateKey ?? this.prefix;
    const templateName = await this.ensureTemplate(driver, key);
    if (templateName) {
      return Sandbox.clone(templateName, sessionName, { driver: driver.name });
    }
    return Sandbox.create({ ...this.config.create, name: sessionName });
  }

  private async ensureTemplate(driver: SandboxDriver, key: string): Promise<string | null> {
    const log = this.config.log ?? (() => {});
    const templateName = this.templateMachineName(key);
    const cached = templateCache.get(key);
    if (cached && (await driver.exists(cached))) return cached;
    if (await driver.exists(templateName)) {
      templateCache.set(key, templateName);
      return templateName;
    }
    log(`[spawnbox/flue] prewarming template ${templateName}`);
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
 * Flue `SandboxApi` over a spawnbox `Sandbox`. Maps Flue's filesystem and exec
 * surface onto the active driver. Path resolution follows spawnbox's
 * `/workspace` anchoring for relative paths.
 *
 * Exposed publicly so callers running a single shared sandbox (no
 * session-per-id provisioning) can wrap one directly:
 * `new SandboxFlueApi(sandbox)`.
 */
export class SandboxFlueApi implements FlueSandboxApi {
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
 * Build a Flue `SandboxFactory` backed by spawnbox. The driver is chosen by
 * `create.driver` (defaults to auto-detection). Wire it into your Flue provider
 * entrypoint:
 *
 * ```ts
 * import { createSandboxSessionEnv } from "@flue/runtime";
 * import { flue } from "spawnbox";
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
  return new FlueSandboxFactoryImpl(config);
}

/** List spawnbox-managed Flue sandboxes (template + sessions) for a driver. */
export async function listFlueMachines(prefix = "flue", driverName = "auto"): Promise<string[]> {
  const driver = await resolveDriver(driverName);
  const all = await driver.list();
  return all.filter((m) => m.name.startsWith(`${prefix}-`)).map((m) => m.name);
}

/** Delete all spawnbox-managed Flue sandboxes. Useful in tests/CI. */
export async function purgeFlueMachines(prefix = "flue", driverName = "auto"): Promise<void> {
  const driver = await resolveDriver(driverName);
  const names = await listFlueMachines(prefix, driverName);
  for (const n of names) {
    const handle = await driver.attach(n).catch(() => null);
    if (handle) await handle.destroy().catch(() => {});
  }
}

/** @deprecated renamed to `SandboxFlueApi`. */
export const OrbboxFlueSandboxApi = SandboxFlueApi;
/** @deprecated renamed to `SandboxFlueApi`. */
export type OrbboxFlueSandboxApi = SandboxFlueApi;

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
