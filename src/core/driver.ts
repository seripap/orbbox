import type { RunResult, StreamingProcess } from "./process.js";
import type { CreateConfigResolved } from "./schema.js";

export interface ExecResult extends RunResult {
  /** Final command line that was sent to the backend CLI (debug aid). */
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

/**
 * Options the façade passes to a driver for a single exec/spawn. The command
 * itself is already resolved to argv by the façade (shell-wrapping, string
 * splitting). The driver is responsible for wrapping that argv in its own
 * invocation (`orbctl run -m ...`, `container exec ...`) and injecting env in
 * whatever way the backend expects.
 */
export interface DriverExecOptions {
  user?: string;
  workdir?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  throwOnNonZero?: boolean;
  stdin?: string | Buffer;
  signal?: AbortSignal;
}

/** Normalized record describing one sandbox, across drivers. */
export interface SandboxRecord {
  id: string;
  name: string;
  state?: string;
  [k: string]: unknown;
}

/**
 * What a driver can and can't do. The façade and connectors consult this
 * before attempting an operation so they can fall back gracefully (or throw a
 * precise DriverUnsupportedError) instead of failing deep in the CLI.
 */
export interface DriverCapabilities {
  /** Provision from a distro name (orbstack). */
  distroSource: boolean;
  /** Provision from an OCI image (apple, docker). */
  imageSource: boolean;
  /** Cheap copy-on-write clone of an existing sandbox (orbstack snapshots). */
  clone: boolean;
  /** Create-time network isolation. */
  networkIsolation: boolean;
  /** Host directory mounts. */
  mounts: boolean;
  /** Long-lived stop/start lifecycle (vs. ephemeral). */
  pauseResume: boolean;
}

/**
 * A live handle to one provisioned sandbox. Drivers return this from
 * create/attach/clone. It exposes exec/file-copy/lifecycle; the higher-level
 * file IO (base64 read, tee write, resolvePath) lives in the Sandbox façade
 * since it's pure POSIX over `exec`.
 */
export interface DriverHandle {
  readonly id: string;
  readonly user: string;
  readonly isolated: boolean;
  exec(argv: readonly string[], opts: DriverExecOptions): Promise<ExecResult>;
  spawn(argv: readonly string[], opts: DriverExecOptions): SpawnHandle;
  /** Copy a host file into the sandbox. */
  pushFile(hostPath: string, sandboxPath: string): Promise<void>;
  /** Copy a sandbox file out to the host. */
  pullFile(sandboxPath: string, hostPath: string): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  destroy(): Promise<void>;
  info(): Promise<SandboxRecord>;
}

/**
 * A backend that provisions sandboxes. OrbStack VMs, Apple containers, Docker —
 * each implements this. Register implementations in core/registry.ts.
 */
export interface SandboxDriver {
  readonly name: string;
  readonly capabilities: DriverCapabilities;
  /** Cheap, non-throwing availability probe used by auto-detection. */
  isAvailable(): Promise<boolean>;
  /** Throw a helpful DriverNotInstalled/NotRunning error if unusable. */
  preflight(): Promise<void>;
  create(name: string, cfg: CreateConfigResolved): Promise<DriverHandle>;
  attach(id: string): Promise<DriverHandle>;
  clone(source: string, newName: string): Promise<DriverHandle>;
  list(): Promise<SandboxRecord[]>;
  exists(id: string): Promise<boolean>;
}
