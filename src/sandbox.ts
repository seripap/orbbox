import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import {
  runOrb,
  spawnOrb,
  type StreamingProcess,
  type RunResult,
  type OrbMachineRecord,
  listMachines,
  infoMachine,
  machineExists,
  assertOrbStackRunning,
} from "./orb.js";
import {
  type CreateConfig,
  type CreateConfigResolved,
  type ExecOptions,
  parseCreateConfig,
  parseExecOptions,
  normalizeMount,
} from "./schema.js";
import { SandboxExistsError, SandboxNotFoundError } from "./errors.js";

export interface ExecResult extends RunResult {
  /** Final command line that was sent to orbctl (debug aid). */
  args: readonly string[];
}

export interface SpawnHandle {
  readonly process: StreamingProcess;
  readonly pid: number | undefined;
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr: NodeJS.ReadableStream;
  readonly stdin: NodeJS.WritableStream;
  readonly done: Promise<ExecResult>;
  kill(signal?: NodeJS.Signals): void;
  on(event: "stdout" | "stderr", listener: (chunk: string) => void): SpawnHandle;
}

export interface FileOptions {
  /** Run the underlying read/write as this user. Defaults to default machine user. */
  user?: string;
}

const DEFAULT_WORKSPACE = "/workspace";

/**
 * High-level handle to one OrbStack VM used as an AI sandbox.
 *
 * Lifecycle: `Sandbox.create()` provisions a fresh machine,
 * `Sandbox.attach()` wraps an existing one, `destroy()` deletes it.
 *
 * Workspace convention: every sandbox has `/workspace` created and owned by
 * the default user. Relative paths in file IO resolve against it. This
 * matches Vercel Eve's sandbox seeding convention.
 */
export class Sandbox {
  readonly name: string;
  readonly user: string;
  readonly workspace: string;
  readonly isolated: boolean;

  private destroyed = false;

  private constructor(opts: { name: string; user: string; workspace: string; isolated: boolean }) {
    this.name = opts.name;
    this.user = opts.user;
    this.workspace = opts.workspace;
    this.isolated = opts.isolated;
  }

  /**
   * Provision a brand-new OrbStack machine and prep `/workspace`. Throws
   * SandboxExistsError if `name` is already taken.
   */
  static async create(config: CreateConfig = {}): Promise<Sandbox> {
    await assertOrbStackRunning();
    const cfg = parseCreateConfig(config);
    const name = cfg.name ?? `orbbox-${randomUUID().slice(0, 8)}`;
    if (await machineExists(name)) throw new SandboxExistsError(name);

    const args = buildCreateArgs(name, cfg);
    await runOrb(args, { timeoutMs: 5 * 60_000 });

    const user = cfg.user ?? process.env["USER"] ?? "root";
    const sb = new Sandbox({ name, user, workspace: DEFAULT_WORKSPACE, isolated: cfg.isolated });
    await sb.ensureWorkspace();
    return sb;
  }

  /** Wrap an existing machine. Throws SandboxNotFoundError if absent. */
  static async attach(name: string): Promise<Sandbox> {
    await assertOrbStackRunning();
    if (!(await machineExists(name))) throw new SandboxNotFoundError(name);
    const info = await infoMachine(name);
    const user = readUserFromInfo(info) ?? process.env["USER"] ?? "root";
    const isolated = readIsolatedFromInfo(info);
    const sb = new Sandbox({ name, user, workspace: DEFAULT_WORKSPACE, isolated });
    await sb.ensureWorkspace();
    return sb;
  }

  /**
   * Clone an existing machine to a new name. The source remains untouched.
   * Useful for taking a "golden template" and cheaply branching per-session
   * sandboxes from it (OrbStack snapshots data, so it's near-free on disk).
   */
  static async clone(source: string, newName?: string): Promise<Sandbox> {
    await assertOrbStackRunning();
    if (!(await machineExists(source))) throw new SandboxNotFoundError(source);
    const name = newName ?? `orbbox-${randomUUID().slice(0, 8)}`;
    if (await machineExists(name)) throw new SandboxExistsError(name);
    await runOrb(["clone", source, name], { timeoutMs: 2 * 60_000 });
    await runOrb(["start", name], { timeoutMs: 60_000 });
    return Sandbox.attach(name);
  }

  static async list(): Promise<OrbMachineRecord[]> {
    await assertOrbStackRunning();
    return listMachines();
  }

  // ----- runtime --------------------------------------------------------

  /** Run a command and buffer its output. */
  async exec(command: string | readonly string[], options: ExecOptions = {}): Promise<ExecResult> {
    this.assertAlive();
    const opts = parseExecOptions(options);
    const { args, env } = this.buildRunArgs(command, opts);
    const result = await runOrb(args, {
      stdin: opts.stdin,
      timeoutMs: opts.timeoutMs,
      env,
      throwOnNonZero: opts.throwOnNonZero ?? true,
    });
    return { ...result, args };
  }

  /** Run a command and stream stdout/stderr. Caller awaits `.done`. */
  spawn(command: string | readonly string[], options: ExecOptions = {}): SpawnHandle {
    this.assertAlive();
    const opts = parseExecOptions(options);
    const { args, env } = this.buildRunArgs(command, opts);
    const proc = spawnOrb(args, { env, timeoutMs: opts.timeoutMs });

    if (opts.stdin !== undefined) proc.writeStdin(opts.stdin);
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

  // ----- file IO --------------------------------------------------------

  /**
   * Read a file from the sandbox as bytes. Resolves to null if missing.
   * Streams over stdin to avoid bouncing through a tmp file; safe for
   * binary content.
   */
  async readFile(path: string, options: FileOptions = {}): Promise<Buffer | null> {
    this.assertAlive();
    const resolved = this.resolvePath(path);
    // base64 round-trip preserves bytes; piping raw `cat` through orbctl's
    // line-buffered stdout corrupts non-utf8 bytes (e.g. 0xFF).
    const result = await this.exec(["sh", "-c", `if [ -e "$1" ]; then base64 < "$1"; else exit 7; fi`, "sh", resolved], {
      user: options.user,
      throwOnNonZero: false,
    });
    if (result.exitCode === 0) {
      // base64 output is ASCII; safe to decode.
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
    await this.exec(["tee", resolved], {
      user: options.user,
      stdin: payload,
    });
  }

  /** Remove a path. `recursive`/`force` mirror `rm -rf` semantics. */
  async removePath(path: string, opts: FileOptions & { recursive?: boolean; force?: boolean } = {}): Promise<void> {
    this.assertAlive();
    const resolved = this.resolvePath(path);
    const flags = ["-r" /* will be filtered */, "-f"].filter((_, i) => {
      if (i === 0) return opts.recursive ?? false;
      return opts.force ?? false;
    });
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

  // ----- host <-> sandbox file copy (uses orb push/pull) ---------------

  /** Copy a file from the host into the sandbox via `orbctl push`. */
  async push(hostPath: string, sandboxPath: string): Promise<void> {
    this.assertAlive();
    await runOrb(["push", "-m", this.name, hostPath, sandboxPath]);
  }

  /** Copy a file out of the sandbox to the host via `orbctl pull`. */
  async pull(sandboxPath: string, hostPath: string): Promise<void> {
    this.assertAlive();
    await runOrb(["pull", "-m", this.name, sandboxPath, hostPath]);
  }

  // ----- lifecycle -----------------------------------------------------

  async info(): Promise<OrbMachineRecord> {
    this.assertAlive();
    return infoMachine(this.name);
  }

  async start(): Promise<void> {
    this.assertAlive();
    await runOrb(["start", this.name]);
  }

  async stop(): Promise<void> {
    this.assertAlive();
    await runOrb(["stop", this.name]);
  }

  async restart(): Promise<void> {
    this.assertAlive();
    await runOrb(["restart", this.name]);
  }

  /** Delete the machine. Idempotent within a process — second call is a no-op. */
  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    await runOrb(["delete", "-f", this.name], { throwOnNonZero: false, timeoutMs: 60_000 });
  }

  get isDestroyed(): boolean {
    return this.destroyed;
  }

  // ----- internals -----------------------------------------------------

  private assertAlive(): void {
    if (this.destroyed) throw new SandboxNotFoundError(this.name);
  }

  private async ensureWorkspace(): Promise<void> {
    // mkdir & chown — runs as root since the default exec user is `user`,
    // but mkdir under /workspace as root then chown to the configured user.
    await this.exec(["sh", "-c", `mkdir -p ${shellQuote(this.workspace)} && chown ${shellQuote(this.user)}:${shellQuote(this.user)} ${shellQuote(this.workspace)}`], {
      user: "root",
    });
  }

  private buildRunArgs(
    command: string | readonly string[],
    opts: ReturnType<typeof parseExecOptions>,
  ): { args: string[]; env: Record<string, string> } {
    const head: string[] = ["run", "-m", this.name];
    if (opts.user ?? this.user) head.push("-u", opts.user ?? this.user);
    if (opts.workdir) head.push("-w", opts.workdir);

    let cmd: string[];
    if (typeof command === "string") {
      if (opts.shell) cmd = ["sh", "-lc", command];
      else cmd = command.trim().split(/\s+/);
    } else {
      cmd = [...command];
    }

    const env: Record<string, string> = {};
    if (opts.env && Object.keys(opts.env).length > 0) {
      // orbctl forwards env vars listed in ORBENV (colon-separated names).
      env["ORBENV"] = Object.keys(opts.env).join(":");
      Object.assign(env, opts.env);
    }
    return { args: [...head, ...cmd], env };
  }
}

// ----- helpers ----------------------------------------------------------

function buildCreateArgs(name: string, cfg: CreateConfigResolved): string[] {
  const args = ["create"];
  if (cfg.arch) args.push("-a", cfg.arch);
  if (cfg.memory) args.push("--memory", cfg.memory);
  if (cfg.cpus !== undefined) args.push("--cpus", String(cfg.cpus));
  if (cfg.disk) args.push("--disk", cfg.disk);
  if (cfg.user) args.push("-u", cfg.user);
  if (cfg.setPassword) args.push("-p");
  if (cfg.userDataPath) args.push("-c", cfg.userDataPath);
  if (cfg.isolated) args.push("--isolated");
  if (cfg.isolateNetwork) args.push("--isolate-network");
  if (cfg.forwardSshAgent) args.push("--forward-ssh-agent");
  for (const m of cfg.mounts) args.push("--mount", normalizeMount(m));

  const distro = cfg.version ? `${cfg.distro}:${cfg.version}` : cfg.distro;
  args.push(distro, name);
  return args;
}

function readUserFromInfo(info: OrbMachineRecord): string | undefined {
  const cfg = info.config as { default_username?: string; default_user?: string; user?: string } | undefined;
  return cfg?.default_username ?? cfg?.default_user ?? cfg?.user;
}

function readIsolatedFromInfo(info: OrbMachineRecord): boolean {
  const cfg = info.config as { isolated?: boolean } | undefined;
  return Boolean(cfg?.isolated);
}

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
