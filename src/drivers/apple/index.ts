import type {
  DriverCapabilities,
  DriverExecOptions,
  DriverHandle,
  ExecResult,
  SandboxDriver,
  SandboxRecord,
  SpawnHandle,
} from "../../core/driver.js";
import type { CreateConfigResolved, Distro } from "../../core/schema.js";
import { normalizeMount } from "../../core/schema.js";
import { runCli } from "../../core/process.js";
import { bufferedExec, streamingExec } from "../../core/exec-handle.js";
import {
  DriverNotRunningError,
  DriverUnsupportedError,
  SandboxExistsError,
  SandboxNotFoundError,
} from "../../core/errors.js";

/** Apple's containerization CLI. Overridable for tests / nonstandard installs. */
export const CONTAINER_BIN = process.env["SPAWNBOX_CONTAINER_BIN"] || "container";

/**
 * Keepalive command so the container stays up long enough to `exec` into it.
 * `tail -f /dev/null` is the most portable option across busybox/coreutils
 * (unlike `sleep infinity`, which busybox sleep rejects).
 */
const KEEPALIVE = ["tail", "-f", "/dev/null"];

const CAPABILITIES: DriverCapabilities = {
  // distro names are supported via a distro -> OCI image mapping.
  distroSource: true,
  imageSource: true,
  // No copy-on-write clone: templating is image build/commit, wired by callers.
  clone: false,
  networkIsolation: true,
  mounts: true,
  // Containers are ephemeral-leaning but start/stop works.
  pauseResume: true,
};

/**
 * Driver backed by Apple's `container` CLI (the containerization framework,
 * https://github.com/apple/container). Each sandbox is a lightweight VM created
 * from an OCI image. Requires macOS 26 on Apple silicon.
 *
 * NOTE: `container`'s flag surface mirrors Docker but a handful of flags are
 * assumptions against the documented command reference (run --name/--detach/
 * --memory/--cpus/--volume/--network, exec --user/--workdir/--env, cp, ls
 * --format json). Verify against `container <cmd> --help` on a macOS 26 host;
 * any drift is contained to this file.
 */
export class AppleDriver implements SandboxDriver {
  readonly name = "apple";
  readonly capabilities = CAPABILITIES;

  async isAvailable(): Promise<boolean> {
    try {
      const r = await runCli(CONTAINER_BIN, ["system", "status"], { throwOnNonZero: false });
      return r.exitCode === 0;
    } catch {
      return false;
    }
  }

  async preflight(): Promise<void> {
    let status;
    try {
      status = await runCli(CONTAINER_BIN, ["system", "status"], { throwOnNonZero: false });
    } catch (err) {
      // ENOENT etc. -> DriverNotInstalledError, surfaced as-is.
      throw err;
    }
    if (status.exitCode !== 0) {
      throw new DriverNotRunningError(
        "Apple container service is not running. Start it with `container system start` (requires macOS 26 on Apple silicon).",
      );
    }
  }

  async create(name: string, cfg: CreateConfigResolved): Promise<DriverHandle> {
    if (await this.exists(name)) throw new SandboxExistsError(name);
    await runCli(CONTAINER_BIN, buildRunArgs(name, cfg), { timeoutMs: 5 * 60_000 });
    const user = cfg.user ?? "root";
    return new AppleHandle(name, user, cfg.isolated);
  }

  async attach(id: string): Promise<DriverHandle> {
    const rec = await this.find(id);
    if (!rec) throw new SandboxNotFoundError(id);
    return new AppleHandle(id, readUser(rec) ?? "root", readIsolated(rec));
  }

  async clone(_source: string, _newName: string): Promise<DriverHandle> {
    throw new DriverUnsupportedError(
      "apple",
      "clone a sandbox",
      "no copy-on-write snapshots; build a template image and create from it instead",
    );
  }

  async list(): Promise<SandboxRecord[]> {
    return listContainers();
  }

  async exists(id: string): Promise<boolean> {
    return (await this.find(id)) != null;
  }

  private async find(id: string): Promise<SandboxRecord | undefined> {
    return (await listContainers()).find((c) => c.name === id || c.id === id);
  }
}

class AppleHandle implements DriverHandle {
  constructor(
    readonly id: string,
    readonly user: string,
    readonly isolated: boolean,
  ) {}

  exec(argv: readonly string[], opts: DriverExecOptions): Promise<ExecResult> {
    return bufferedExec(CONTAINER_BIN, this.buildExecArgs(argv, opts), {
      stdin: opts.stdin,
      timeoutMs: opts.timeoutMs,
      throwOnNonZero: opts.throwOnNonZero,
      signal: opts.signal,
    });
  }

  spawn(argv: readonly string[], opts: DriverExecOptions): SpawnHandle {
    return streamingExec(CONTAINER_BIN, this.buildExecArgs(argv, opts), {
      stdin: opts.stdin,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
    });
  }

  async pushFile(hostPath: string, sandboxPath: string): Promise<void> {
    await runCli(CONTAINER_BIN, ["cp", hostPath, `${this.id}:${sandboxPath}`]);
  }

  async pullFile(sandboxPath: string, hostPath: string): Promise<void> {
    await runCli(CONTAINER_BIN, ["cp", `${this.id}:${sandboxPath}`, hostPath]);
  }

  async info(): Promise<SandboxRecord> {
    const rec = (await listContainers()).find((c) => c.name === this.id || c.id === this.id);
    if (!rec) throw new SandboxNotFoundError(this.id);
    return rec;
  }

  async start(): Promise<void> {
    await runCli(CONTAINER_BIN, ["start", this.id]);
  }

  async stop(): Promise<void> {
    await runCli(CONTAINER_BIN, ["stop", this.id], { throwOnNonZero: false });
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  async destroy(): Promise<void> {
    await runCli(CONTAINER_BIN, ["rm", "-f", this.id], { throwOnNonZero: false, timeoutMs: 60_000 });
  }

  private buildExecArgs(argv: readonly string[], opts: DriverExecOptions): string[] {
    const args = ["exec"];
    const user = opts.user ?? this.user;
    if (user) args.push("--user", user);
    if (opts.workdir) args.push("--workdir", opts.workdir);
    if (opts.env) {
      for (const [k, v] of Object.entries(opts.env)) args.push("--env", `${k}=${v}`);
    }
    if (opts.stdin !== undefined) args.push("--interactive");
    args.push(this.id, ...argv);
    return args;
  }
}

// ----- container helpers ------------------------------------------------

function buildRunArgs(name: string, cfg: CreateConfigResolved): string[] {
  const args = ["run", "--detach", "--name", name];
  if (cfg.arch) args.push("--platform", `linux/${cfg.arch}`);
  if (cfg.memory) args.push("--memory", cfg.memory);
  if (cfg.cpus !== undefined) args.push("--cpus", String(cfg.cpus));
  if (cfg.user) args.push("--user", cfg.user);
  // Network isolation: drop networking entirely when requested.
  if (cfg.isolateNetwork) args.push("--network", "none");
  for (const m of cfg.mounts) args.push("--volume", normalizeMount(m));
  args.push(resolveImage(cfg), ...KEEPALIVE);
  return args;
}

/**
 * Pick the OCI image. An explicit `image` wins; otherwise map the distro to a
 * Docker Hub library image. Unknown distros fall back to `<distro>:latest`.
 */
export function resolveImage(cfg: CreateConfigResolved): string {
  if (cfg.image) return cfg.image;
  const tag = cfg.version ?? "latest";
  const repo = DISTRO_IMAGE[cfg.distro] ?? cfg.distro;
  return `${repo}:${tag}`;
}

const DISTRO_IMAGE: Partial<Record<Distro, string>> = {
  alpine: "alpine",
  ubuntu: "ubuntu",
  debian: "debian",
  fedora: "fedora",
  centos: "centos",
  arch: "archlinux",
  rocky: "rockylinux",
  alma: "almalinux",
  opensuse: "opensuse/leap",
  oracle: "oraclelinux",
  kali: "kalilinux/kali-rolling",
};

interface ContainerJson {
  id?: string;
  ID?: string;
  name?: string;
  Names?: string | string[];
  status?: string;
  Status?: string;
  state?: string;
  State?: string;
  configuration?: { user?: string; networks?: unknown[] };
  [k: string]: unknown;
}

export async function listContainers(): Promise<SandboxRecord[]> {
  const r = await runCli(CONTAINER_BIN, ["ls", "--all", "--format", "json"], { throwOnNonZero: false });
  if (r.exitCode !== 0) return [];
  return parseContainerList(r.stdout);
}

/** Exposed for unit tests. Tolerates JSON array or NDJSON. */
export function parseContainerList(stdout: string): SandboxRecord[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  const rows: ContainerJson[] = trimmed.startsWith("[")
    ? JSON.parse(trimmed)
    : trimmed
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => JSON.parse(l));
  return rows.map(toRecord);
}

function toRecord(c: ContainerJson): SandboxRecord {
  const name = normalizeName(c.name ?? c.Names);
  const id = c.id ?? c.ID ?? name;
  const state = c.state ?? c.State ?? c.status ?? c.Status;
  return { ...c, id, name, state };
}

function normalizeName(n: string | string[] | undefined): string {
  if (Array.isArray(n)) return (n[0] ?? "").replace(/^\//, "");
  return (n ?? "").replace(/^\//, "");
}

function readUser(rec: SandboxRecord): string | undefined {
  const cfg = (rec as ContainerJson).configuration;
  return cfg?.user;
}

function readIsolated(rec: SandboxRecord): boolean {
  const cfg = (rec as ContainerJson).configuration;
  // No network configured -> isolated.
  if (cfg && Array.isArray(cfg.networks)) return cfg.networks.length === 0;
  return false;
}
