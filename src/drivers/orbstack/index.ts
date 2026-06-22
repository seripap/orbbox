import type {
  DriverCapabilities,
  DriverExecOptions,
  DriverHandle,
  ExecResult,
  SandboxDriver,
  SandboxRecord,
  SpawnHandle,
} from "../../core/driver.js";
import type { CreateConfigResolved } from "../../core/schema.js";
import { normalizeMount } from "../../core/schema.js";
import { runCli } from "../../core/process.js";
import { bufferedExec, streamingExec } from "../../core/exec-handle.js";
import {
  CommandError,
  DriverNotRunningError,
  DriverUnsupportedError,
  SandboxExistsError,
  SandboxNotFoundError,
} from "../../core/errors.js";

/** Where the orb CLI lives. Overridable for tests / nonstandard installs. */
export const ORB_BIN = process.env["SPAWNBOX_ORB_BIN"] || process.env["ORBBOX_ORB_BIN"] || "orbctl";

const CAPABILITIES: DriverCapabilities = {
  distroSource: true,
  imageSource: false,
  clone: true,
  networkIsolation: true,
  mounts: true,
  pauseResume: true,
};

export class OrbStackDriver implements SandboxDriver {
  readonly name = "orbstack";
  readonly capabilities = CAPABILITIES;

  async isAvailable(): Promise<boolean> {
    return isOrbStackRunning();
  }

  async preflight(): Promise<void> {
    if (!(await isOrbStackRunning())) {
      throw new DriverNotRunningError("OrbStack is not running. Start it from the menu bar or via `orb start`.");
    }
  }

  async create(name: string, cfg: CreateConfigResolved): Promise<DriverHandle> {
    if (cfg.image) {
      throw new DriverUnsupportedError("orbstack", "provision from an OCI image", "use a `distro` instead");
    }
    if (await machineExists(name)) throw new SandboxExistsError(name);
    await runCli(ORB_BIN, buildCreateArgs(name, cfg), { timeoutMs: 5 * 60_000 });
    const user = cfg.user ?? process.env["USER"] ?? "root";
    return new OrbStackHandle(name, user, cfg.isolated);
  }

  async attach(id: string): Promise<DriverHandle> {
    if (!(await machineExists(id))) throw new SandboxNotFoundError(id);
    const info = await infoMachine(id);
    const user = readUserFromInfo(info) ?? process.env["USER"] ?? "root";
    return new OrbStackHandle(id, user, readIsolatedFromInfo(info));
  }

  async clone(source: string, newName: string): Promise<DriverHandle> {
    if (!(await machineExists(source))) throw new SandboxNotFoundError(source);
    if (await machineExists(newName)) throw new SandboxExistsError(newName);
    await runCli(ORB_BIN, ["clone", source, newName], { timeoutMs: 2 * 60_000 });
    await runCli(ORB_BIN, ["start", newName], { timeoutMs: 60_000 });
    return this.attach(newName);
  }

  async list(): Promise<SandboxRecord[]> {
    return (await listMachines()).map(toRecord);
  }

  async exists(id: string): Promise<boolean> {
    return machineExists(id);
  }
}

class OrbStackHandle implements DriverHandle {
  constructor(
    readonly id: string,
    readonly user: string,
    readonly isolated: boolean,
  ) {}

  exec(argv: readonly string[], opts: DriverExecOptions): Promise<ExecResult> {
    const { args, env } = this.buildRunArgs(argv, opts);
    return bufferedExec(ORB_BIN, args, {
      stdin: opts.stdin,
      timeoutMs: opts.timeoutMs,
      throwOnNonZero: opts.throwOnNonZero,
      env,
      signal: opts.signal,
    });
  }

  spawn(argv: readonly string[], opts: DriverExecOptions): SpawnHandle {
    const { args, env } = this.buildRunArgs(argv, opts);
    return streamingExec(ORB_BIN, args, {
      stdin: opts.stdin,
      timeoutMs: opts.timeoutMs,
      env,
      signal: opts.signal,
    });
  }

  async pushFile(hostPath: string, sandboxPath: string): Promise<void> {
    await runCli(ORB_BIN, ["push", "-m", this.id, hostPath, sandboxPath]);
  }

  async pullFile(sandboxPath: string, hostPath: string): Promise<void> {
    await runCli(ORB_BIN, ["pull", "-m", this.id, sandboxPath, hostPath]);
  }

  async info(): Promise<SandboxRecord> {
    return toRecord(await infoMachine(this.id));
  }

  async start(): Promise<void> {
    await runCli(ORB_BIN, ["start", this.id]);
  }

  async stop(): Promise<void> {
    await runCli(ORB_BIN, ["stop", this.id]);
  }

  async restart(): Promise<void> {
    await runCli(ORB_BIN, ["restart", this.id]);
  }

  async destroy(): Promise<void> {
    await runCli(ORB_BIN, ["delete", "-f", this.id], { throwOnNonZero: false, timeoutMs: 60_000 });
  }

  private buildRunArgs(
    argv: readonly string[],
    opts: DriverExecOptions,
  ): { args: string[]; env: Record<string, string> } {
    const head: string[] = ["run", "-m", this.id];
    const user = opts.user ?? this.user;
    if (user) head.push("-u", user);
    if (opts.workdir) head.push("-w", opts.workdir);

    const env: Record<string, string> = {};
    if (opts.env && Object.keys(opts.env).length > 0) {
      // orbctl forwards env vars listed in ORBENV (colon-separated names).
      env["ORBENV"] = Object.keys(opts.env).join(":");
      Object.assign(env, opts.env);
    }
    return { args: [...head, ...argv], env };
  }
}

// ----- orbctl machine helpers -------------------------------------------

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
  const r = await runCli(ORB_BIN, ["list", "-f", "json"]);
  return parseListJson(r.stdout);
}

/** Exposed for unit tests. */
export function parseListJson(stdout: string): OrbMachineRecord[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed);
  if (!Array.isArray(parsed)) {
    throw new CommandError(
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
  const r = await runCli(ORB_BIN, ["info", name, "-f", "json"]);
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

/** True if `orbctl status` reports a running service. */
export async function isOrbStackRunning(): Promise<boolean> {
  try {
    const r = await runCli(ORB_BIN, ["status"], { throwOnNonZero: false });
    return r.exitCode === 0 && r.stdout.trim().toLowerCase().includes("running");
  } catch {
    // orbctl missing -> not available. isAvailable() must not throw.
    return false;
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

function toRecord(m: OrbMachineRecord): SandboxRecord {
  return { ...m, id: m.id ?? m.name, name: m.name, state: m.state ?? m.status };
}

function readUserFromInfo(info: OrbMachineRecord): string | undefined {
  const cfg = info.config as { default_username?: string; default_user?: string; user?: string } | undefined;
  return cfg?.default_username ?? cfg?.default_user ?? cfg?.user;
}

function readIsolatedFromInfo(info: OrbMachineRecord): boolean {
  const cfg = info.config as { isolated?: boolean } | undefined;
  return Boolean(cfg?.isolated);
}
