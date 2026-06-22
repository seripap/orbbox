import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { Sandbox } from "../../core/sandbox.js";
import { AiSandboxSession } from "../ai/sandbox-session.js";
import type { CreateConfig } from "../../core/schema.js";
import { resolveDriver } from "../../core/registry.js";
import type { SandboxDriver } from "../../core/driver.js";

/**
 * Structural shapes for Vercel Eve's backend contract. We don't import from
 * `eve` (it's a peer / optional dep); these types match the public surface
 * defined at https://github.com/vercel/eve/blob/main/packages/eve/src/shared/sandbox-backend.ts.
 *
 * If `eve` is installed in the consumer's app, the structural compatibility
 * lets `sandboxBackend()` be assigned directly to a `SandboxBackend` field of a
 * `defineSandbox({ backend: ... })` call.
 */
export interface EveSeedFile {
  readonly path: string;
  readonly content: string | Buffer;
}

export interface EveSandboxBackendCreateInput {
  readonly templateKey: string | null;
  readonly sessionKey: string;
  readonly existingMetadata?: Record<string, unknown>;
  readonly tags?: Readonly<Record<string, string>>;
  readonly runtimeContext: { readonly appRoot: string };
}

export interface EveSandboxBackendPrewarmInput {
  readonly templateKey: string;
  readonly bootstrap?: (input: { use: (options?: unknown) => Promise<unknown> }) => void | Promise<void>;
  readonly log?: (message: string) => void;
  readonly runtimeContext: { readonly appRoot: string };
  readonly seedFiles: ReadonlyArray<EveSeedFile>;
}

export interface EveSandboxBackendPrewarmResult {
  readonly reused: boolean;
}

export interface EveSandboxBackendSessionState {
  readonly backendName: string;
  readonly metadata: Record<string, unknown>;
  readonly sessionKey: string;
}

export interface EveSandboxBackendHandle {
  readonly session: AiSandboxSession;
  readonly useSessionFn: (options?: unknown) => Promise<AiSandboxSession>;
  captureState(): Promise<EveSandboxBackendSessionState>;
  dispose(): Promise<void>;
}

export interface EveSandboxBackend {
  readonly name: string;
  create(input: EveSandboxBackendCreateInput): Promise<EveSandboxBackendHandle>;
  prewarm(input: EveSandboxBackendPrewarmInput): Promise<EveSandboxBackendPrewarmResult>;
}

export interface SandboxBackendConfig {
  /** Underlying create options for every per-session sandbox (includes `driver`). */
  create?: CreateConfig;
  /**
   * Prefix used when naming sandboxes. Useful for distinguishing spawnbox-managed
   * sandboxes from anything else in the backend's list. Defaults to "eve".
   */
  namePrefix?: string;
  /** Optional log sink (defaults to no-op for prewarm progress). */
  log?: (msg: string) => void;
  /**
   * When true (default), live sessions are derived from prewarmed templates via
   * a cheap clone (drivers with copy-on-write snapshots). On drivers without
   * clone support, or when false / when no template exists, each `create()`
   * provisions fresh.
   */
  useTemplates?: boolean;
}

/** @deprecated renamed to `SandboxBackendConfig`. */
export type OrbstackBackendConfig = SandboxBackendConfig;

/**
 * In-memory cache of template sandbox names keyed by templateKey. Persists for
 * the lifetime of the host process — matches Eve's expectation that
 * backend-internal state survives across `create()` calls.
 */
const templateCache = new Map<string, string>();

class SandboxBackend implements EveSandboxBackend {
  private driverPromise: Promise<SandboxDriver> | null = null;

  constructor(private readonly config: SandboxBackendConfig = {}) {}

  get name(): string {
    return "spawnbox";
  }

  private driver(): Promise<SandboxDriver> {
    if (!this.driverPromise) this.driverPromise = resolveDriver(this.config.create?.driver ?? "auto");
    return this.driverPromise;
  }

  async prewarm(input: EveSandboxBackendPrewarmInput): Promise<EveSandboxBackendPrewarmResult> {
    if (this.config.useTemplates === false) {
      // Templates disabled — nothing to bake. Sessions provision fresh.
      return { reused: false };
    }
    const driver = await this.driver();
    await driver.preflight();

    const log = input.log ?? this.config.log ?? (() => {});
    const templateName = this.templateMachineName(input.templateKey);

    if (await driver.exists(templateName)) {
      templateCache.set(input.templateKey, templateName);
      log(`[spawnbox] reusing existing template ${templateName}`);
      return { reused: true };
    }

    if (!driver.capabilities.clone) {
      // No cheap clone: skip baking a template entirely; sessions create fresh.
      log(`[spawnbox] driver "${driver.name}" has no clone support; skipping template prewarm`);
      return { reused: false };
    }

    log(`[spawnbox] prewarming template ${templateName}`);
    const sandbox = await Sandbox.create({ ...this.config.create, name: templateName });
    try {
      for (const file of input.seedFiles) {
        await sandbox.writeFile(file.path, file.content);
      }
      if (input.bootstrap) {
        const ses = new AiSandboxSession(sandbox, { id: `template:${input.templateKey}` });
        const use = async (): Promise<AiSandboxSession> => ses;
        await input.bootstrap({ use: use as (options?: unknown) => Promise<unknown> });
      }
      // Stop the template so clones see a quiescent snapshot.
      await sandbox.stop();
    } catch (err) {
      // Best-effort cleanup of half-built templates.
      await sandbox.destroy().catch(() => {});
      throw err;
    }
    templateCache.set(input.templateKey, templateName);
    return { reused: false };
  }

  async create(input: EveSandboxBackendCreateInput): Promise<EveSandboxBackendHandle> {
    const driver = await this.driver();
    await driver.preflight();
    const sessionMachineName = this.sessionMachineName(input.sessionKey);

    let sandbox: Sandbox;
    const existing = (input.existingMetadata?.["machine"] as string | undefined) ?? undefined;
    if (existing && (await driver.exists(existing))) {
      sandbox = await Sandbox.attach(existing, { driver: driver.name });
      await sandbox.start().catch(() => {});
    } else if (
      driver.capabilities.clone &&
      input.templateKey &&
      templateCache.has(input.templateKey)
    ) {
      const template = templateCache.get(input.templateKey)!;
      sandbox = await Sandbox.clone(template, sessionMachineName, { driver: driver.name });
    } else {
      sandbox = await Sandbox.create({ ...this.config.create, name: sessionMachineName });
    }

    const session = new AiSandboxSession(sandbox, { id: input.sessionKey });

    return {
      session,
      useSessionFn: async () => session,
      captureState: async (): Promise<EveSandboxBackendSessionState> => ({
        backendName: this.name,
        sessionKey: input.sessionKey,
        metadata: { machine: sandbox.name },
      }),
      dispose: async () => {
        await sandbox.destroy();
      },
    };
  }

  private templateMachineName(templateKey: string): string {
    return `${this.prefix}-tpl-${sanitize(templateKey)}`;
  }

  private sessionMachineName(sessionKey: string): string {
    const rand = randomUUID().slice(0, 6);
    return `${this.prefix}-${sanitize(sessionKey)}-${rand}`;
  }

  private get prefix(): string {
    return this.config.namePrefix ?? "eve";
  }
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 24).toLowerCase() || "anon";
}

/**
 * Factory for a spawnbox-backed Eve sandbox backend. The backend driver is
 * chosen by `create.driver` (defaults to auto-detection).
 *
 * ```ts
 * import { defineSandbox } from "eve/sandbox";
 * import { sandboxBackend } from "spawnbox";
 *
 * export default defineSandbox({
 *   backend: sandboxBackend({ create: { distro: "ubuntu", isolated: true } }),
 *   async bootstrap({ use }) {
 *     const sb = await use();
 *     await sb.run({ command: "apt-get update && apt-get install -y ripgrep" });
 *   },
 * });
 * ```
 */
export function sandboxBackend(config: SandboxBackendConfig = {}): EveSandboxBackend {
  return new SandboxBackend(config);
}

/** @deprecated renamed to `sandboxBackend()`. Pins the OrbStack driver. */
export function orbstack(config: SandboxBackendConfig = {}): EveSandboxBackend {
  return new SandboxBackend({ ...config, create: { ...config.create, driver: "orbstack" } });
}

/** List spawnbox-managed sandboxes (those with the prefix) for the active driver. */
export async function listManagedMachines(prefix = "eve", driverName = "auto"): Promise<string[]> {
  const driver = await resolveDriver(driverName);
  const all = await driver.list();
  return all.filter((m) => m.name.startsWith(`${prefix}-`)).map((m) => m.name);
}

/** Delete all spawnbox-managed sessions and templates. Useful in tests/CI. */
export async function purgeManagedMachines(prefix = "eve", driverName = "auto"): Promise<void> {
  const driver = await resolveDriver(driverName);
  const names = await listManagedMachines(prefix, driverName);
  for (const n of names) {
    const handle = await driver.attach(n).catch(() => null);
    if (handle) await handle.destroy().catch(() => {});
  }
}

/** @deprecated renamed to `listManagedMachines`. */
export const listOrbboxMachines = listManagedMachines;
/** @deprecated renamed to `purgeManagedMachines`. */
export const purgeOrbboxMachines = purgeManagedMachines;
