import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import type { DriverHandle, ExecResult, SandboxDriver, SandboxRecord, SpawnHandle, DriverExecOptions } from "./driver.js";
import {
  type CreateConfig,
  type ExecOptions,
  type ExecOptionsResolved,
  parseCreateConfig,
  parseExecOptions,
} from "./schema.js";
import { resolveDriver } from "./registry.js";
import { SandboxNotFoundError } from "./errors.js";

export type { ExecResult, SpawnHandle } from "./driver.js";

export interface FileOptions {
  /** Run the underlying read/write as this user. Defaults to default sandbox user. */
  user?: string;
}

const DEFAULT_WORKSPACE = "/workspace";

/**
 * High-level, backend-agnostic handle to one sandbox.
 *
 * The façade owns everything that is pure POSIX (command assembly, `/workspace`
 * provisioning, base64 file IO, path resolution) and delegates everything
 * backend-specific (provisioning, exec invocation, file copy, lifecycle) to a
 * `SandboxDriver` chosen at create-time.
 *
 * Lifecycle: `Sandbox.create()` provisions a fresh sandbox, `Sandbox.attach()`
 * wraps an existing one, `destroy()` deletes it.
 *
 * Workspace convention: every sandbox has `/workspace` created and owned by the
 * default user. Relative paths in file IO resolve against it (matches Vercel
 * Eve and the AI SDK's sandbox surface).
 */
export class Sandbox {
  readonly name: string;
  readonly user: string;
  readonly workspace: string;
  readonly isolated: boolean;
  readonly driver: string;

  private readonly handle: DriverHandle;
  private destroyed = false;

  private constructor(handle: DriverHandle, driverName: string, workspace: string) {
    this.handle = handle;
    this.name = handle.id;
    this.user = handle.user;
    this.isolated = handle.isolated;
    this.driver = driverName;
    this.workspace = workspace;
  }

  /** Provision a brand-new sandbox and prep `/workspace`. */
  static async create(config: CreateConfig = {}): Promise<Sandbox> {
    const cfg = parseCreateConfig(config);
    const driver = await resolveDriver(cfg.driver);
    await driver.preflight();
    const name = cfg.name ?? `spawnbox-${randomUUID().slice(0, 8)}`;
    const handle = await driver.create(name, cfg);
    const sb = new Sandbox(handle, driver.name, DEFAULT_WORKSPACE);
    await sb.ensureWorkspace();
    return sb;
  }

  /** Wrap an existing sandbox. Throws SandboxNotFoundError if absent. */
  static async attach(name: string, options: { driver?: string } = {}): Promise<Sandbox> {
    const driver = await resolveDriver(options.driver ?? "auto");
    await driver.preflight();
    const handle = await driver.attach(name);
    const sb = new Sandbox(handle, driver.name, DEFAULT_WORKSPACE);
    await sb.ensureWorkspace();
    return sb;
  }

  /**
   * Clone an existing sandbox to a new name. The source remains untouched.
   * Throws DriverUnsupportedError on drivers without cheap snapshots (Apple,
   * Docker) — check `capabilities.clone` first or fall back to `create`.
   */
  static async clone(source: string, newName?: string, options: { driver?: string } = {}): Promise<Sandbox> {
    const driver = await resolveDriver(options.driver ?? "auto");
    await driver.preflight();
    const name = newName ?? `spawnbox-${randomUUID().slice(0, 8)}`;
    const handle = await driver.clone(source, name);
    const sb = new Sandbox(handle, driver.name, DEFAULT_WORKSPACE);
    await sb.ensureWorkspace();
    return sb;
  }

  static async list(options: { driver?: string } = {}): Promise<SandboxRecord[]> {
    const driver = await resolveDriver(options.driver ?? "auto");
    await driver.preflight();
    return driver.list();
  }

  // ----- runtime --------------------------------------------------------

  /** Run a command and buffer its output. */
  async exec(command: string | readonly string[], options: ExecOptions = {}): Promise<ExecResult> {
    this.assertAlive();
    const opts = parseExecOptions(options);
    const { argv, execOpts } = this.buildExec(command, opts, opts.throwOnNonZero ?? true);
    return this.handle.exec(argv, execOpts);
  }

  /** Run a command and stream stdout/stderr. Caller awaits `.done`. */
  spawn(command: string | readonly string[], options: ExecOptions = {}): SpawnHandle {
    this.assertAlive();
    const opts = parseExecOptions(options);
    const { argv, execOpts } = this.buildExec(command, opts, opts.throwOnNonZero ?? false);
    return this.handle.spawn(argv, execOpts);
  }

  // ----- file IO --------------------------------------------------------

  /**
   * Read a file from the sandbox as bytes. Resolves to null if missing.
   * base64 round-trip preserves bytes; piping raw `cat` through the backend
   * CLI's line-buffered stdout corrupts non-utf8 bytes (e.g. 0xFF).
   */
  async readFile(path: string, options: FileOptions = {}): Promise<Buffer | null> {
    this.assertAlive();
    const resolved = this.resolvePath(path);
    const result = await this.exec(["sh", "-c", `if [ -e "$1" ]; then base64 < "$1"; else exit 7; fi`, "sh", resolved], {
      user: options.user,
      throwOnNonZero: false,
    });
    if (result.exitCode === 0) {
      return Buffer.from(result.stdout.replace(/\s+/g, ""), "base64");
    }
    if (result.exitCode === 7 || /No such file|cannot open/i.test(result.stderr)) return null;
    throw new Error(`readFile ${resolved} failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
  }

  async readTextFile(path: string, options: FileOptions & { encoding?: BufferEncoding } = {}): Promise<string | null> {
    const buf = await this.readFile(path, options);
    if (buf == null) return null;
    return buf.toString(options.encoding ?? "utf8");
  }

  /**
   * Write a file into the sandbox. Parent directories are created.
   * Streams content over stdin via `tee` for arbitrary size and bytes.
   */
  async writeFile(path: string, content: string | Buffer | Uint8Array, options: FileOptions = {}): Promise<void> {
    this.assertAlive();
    const resolved = this.resolvePath(path);
    const parent = posixDirname(resolved);
    const payload =
      typeof content === "string"
        ? Buffer.from(content, "utf8")
        : Buffer.isBuffer(content)
          ? content
          : Buffer.from(content);

    await this.exec(["mkdir", "-p", parent], { user: options.user });
    // `tee` is safer than shell redirection for binary content and avoids
    // injection concerns since the path is an argv, not a shell expansion.
    await this.exec(["tee", resolved], { user: options.user, stdin: payload });
  }

  /** Remove a path. `recursive`/`force` mirror `rm -rf` semantics. */
  async removePath(path: string, opts: FileOptions & { recursive?: boolean; force?: boolean } = {}): Promise<void> {
    this.assertAlive();
    const resolved = this.resolvePath(path);
    const flags: string[] = [];
    if (opts.recursive) flags.push("-r");
    if (opts.force) flags.push("-f");
    const args = ["rm", ...flags, "--", resolved];
    await this.exec(args, { user: opts.user, throwOnNonZero: !(opts.force ?? false) });
  }

  /**
   * Anchor a relative path under `/workspace`. Absolute paths pass through.
   * Same semantics as Eve's `SandboxSession.resolvePath`.
   */
  resolvePath(path: string): string {
    if (path.startsWith("/")) return path;
    return posixJoin(this.workspace, path);
  }

  // ----- host <-> sandbox file copy ------------------------------------

  /** Copy a file from the host into the sandbox. */
  async push(hostPath: string, sandboxPath: string): Promise<void> {
    this.assertAlive();
    await this.handle.pushFile(hostPath, sandboxPath);
  }

  /** Copy a file out of the sandbox to the host. */
  async pull(sandboxPath: string, hostPath: string): Promise<void> {
    this.assertAlive();
    await this.handle.pullFile(sandboxPath, hostPath);
  }

  // ----- lifecycle -----------------------------------------------------

  async info(): Promise<SandboxRecord> {
    this.assertAlive();
    return this.handle.info();
  }

  async start(): Promise<void> {
    this.assertAlive();
    await this.handle.start();
  }

  async stop(): Promise<void> {
    this.assertAlive();
    await this.handle.stop();
  }

  async restart(): Promise<void> {
    this.assertAlive();
    await this.handle.restart();
  }

  /** Delete the sandbox. Idempotent within a process — second call is a no-op. */
  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    await this.handle.destroy();
  }

  get isDestroyed(): boolean {
    return this.destroyed;
  }

  // ----- internals -----------------------------------------------------

  private assertAlive(): void {
    if (this.destroyed) throw new SandboxNotFoundError(this.name);
  }

  private async ensureWorkspace(): Promise<void> {
    await this.exec(
      ["sh", "-c", `mkdir -p ${shellQuote(this.workspace)} && chown ${shellQuote(this.user)}:${shellQuote(this.user)} ${shellQuote(this.workspace)}`],
      { user: "root" },
    );
  }

  /**
   * Turn a command (string or argv) + parsed exec options into the inner argv
   * the driver will run inside the sandbox, plus the driver-level options.
   * Shell-wrapping and string splitting are pure POSIX, so they live here; the
   * driver only decides how to invoke that argv and inject env.
   */
  private buildExec(
    command: string | readonly string[],
    opts: ExecOptionsResolved,
    throwOnNonZero: boolean,
  ): { argv: string[]; execOpts: DriverExecOptions } {
    let argv: string[];
    if (typeof command === "string") {
      argv = opts.shell ? ["sh", "-lc", command] : command.trim().split(/\s+/);
    } else {
      argv = [...command];
    }
    const execOpts: DriverExecOptions = {
      user: opts.user ?? this.user,
      workdir: opts.workdir,
      env: opts.env,
      timeoutMs: opts.timeoutMs,
      throwOnNonZero,
      stdin: opts.stdin,
    };
    return { argv, execOpts };
  }
}

// ----- helpers ----------------------------------------------------------

function posixJoin(a: string, b: string): string {
  if (a.endsWith("/")) return a + b.replace(/^\/+/, "");
  return `${a}/${b.replace(/^\/+/, "")}`;
}

function posixDirname(p: string): string {
  const idx = p.lastIndexOf("/");
  if (idx <= 0) return "/";
  return p.slice(0, idx);
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
