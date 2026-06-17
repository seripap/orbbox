import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { Sandbox } from "../sandbox.js";
import { OrbStackAiSandboxSession } from "../ai/sandbox-session.js";
import type { CreateConfig } from "../schema.js";
import { listMachines, machineExists, runOrb, assertOrbStackRunning } from "../orb.js";

/**
 * Structural shapes for Vercel Eve's backend contract. We don't import from
 * `eve` (it's a peer / optional dep); these types match the public surface
 * defined at https://github.com/vercel/eve/blob/main/packages/eve/src/shared/sandbox-backend.ts.
 *
 * If `eve` is installed in the consumer's app, the structural compatibility
 * lets `orbstack()` be assigned directly to a `SandboxBackend` field of a
 * `defineSandbox({ backend: orbstack(...) })` call.
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
  readonly session: OrbStackAiSandboxSession;
  readonly useSessionFn: (options?: unknown) => Promise<OrbStackAiSandboxSession>;
  captureState(): Promise<EveSandboxBackendSessionState>;
  dispose(): Promise<void>;
}

export interface EveSandboxBackend {
  readonly name: string;
  create(input: EveSandboxBackendCreateInput): Promise<EveSandboxBackendHandle>;
  prewarm(input: EveSandboxBackendPrewarmInput): Promise<EveSandboxBackendPrewarmResult>;
}

export interface OrbstackBackendConfig {
  /** Underlying create options for every per-session machine. */
  create?: CreateConfig;
  /**
   * Prefix used when naming machines. Useful for distinguishing orbbox-managed
   * VMs from anything else in `orbctl list`. Defaults to "eve".
   */
  namePrefix?: string;
  /**
   * Optional log sink (defaults to console for prewarm progress).
   */
  log?: (msg: string) => void;
  /**
   * When true (default), live sessions are derived from prewarmed templates
   * via `orbctl clone`. When false (or when no template exists), each
   * `create()` provisions a fresh machine from scratch.
   */
  useTemplates?: boolean;
}

/**
 * In-memory cache of template machine names keyed by templateKey. Persists
 * for the lifetime of the host process — matches Eve's expectation that
 * backend-internal state survives across `create()` calls.
 */
const templateCache = new Map<string, string>();

class OrbstackBackend implements EveSandboxBackend {
  readonly name = "orbstack";

  constructor(private readonly config: OrbstackBackendConfig = {}) {}

  async prewarm(input: EveSandboxBackendPrewarmInput): Promise<EveSandboxBackendPrewarmResult> {
    if (this.config.useTemplates === false) {
      // Templates disabled — nothing to bake. Sessions provision fresh.
      return { reused: false };
    }
    await assertOrbStackRunning();

    const log = input.log ?? this.config.log ?? (() => {});
    const templateName = this.templateMachineName(input.templateKey);

    if (await machineExists(templateName)) {
      templateCache.set(input.templateKey, templateName);
      log(`[orbbox] reusing existing template machine ${templateName}`);
      return { reused: true };
    }

    log(`[orbbox] prewarming template ${templateName}`);
    const sandbox = await Sandbox.create({ ...this.config.create, name: templateName });
    try {
      for (const file of input.seedFiles) {
        await sandbox.writeFile(file.path, file.content);
      }
      if (input.bootstrap) {
        const ses = new OrbStackAiSandboxSession(sandbox, { id: `template:${input.templateKey}` });
        const used: OrbStackAiSandboxSession[] = [];
        const use = async (): Promise<OrbStackAiSandboxSession> => {
          used.push(ses);
          return ses;
        };
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
    await assertOrbStackRunning();
    const sessionMachineName = this.sessionMachineName(input.sessionKey);

    let sandbox: Sandbox;
    const existing = (input.existingMetadata?.["machine"] as string | undefined) ?? undefined;
    if (existing && (await machineExists(existing))) {
      sandbox = await Sandbox.attach(existing);
      await sandbox.start().catch(() => {});
    } else if (input.templateKey && templateCache.has(input.templateKey)) {
      const template = templateCache.get(input.templateKey)!;
      sandbox = await Sandbox.clone(template, sessionMachineName);
    } else {
      sandbox = await Sandbox.create({ ...this.config.create, name: sessionMachineName });
    }

    const session = new OrbStackAiSandboxSession(sandbox, { id: input.sessionKey });

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
    const safe = sanitize(templateKey);
    return `${this.prefix}-tpl-${safe}`;
  }

  private sessionMachineName(sessionKey: string): string {
    const safe = sanitize(sessionKey);
    const rand = randomUUID().slice(0, 6);
    return `${this.prefix}-${safe}-${rand}`;
  }

  private get prefix(): string {
    return this.config.namePrefix ?? "eve";
  }
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 24).toLowerCase() || "anon";
}

/**
 * Factory for the OrbStack-backed Eve sandbox backend.
 *
 * ```ts
 * import { defineSandbox } from "eve/sandbox";
 * import { orbstack } from "orbbox/eve";
 *
 * export default defineSandbox({
 *   backend: orbstack({ create: { distro: "ubuntu", isolated: true } }),
 *   async bootstrap({ use }) {
 *     const sb = await use();
 *     await sb.run({ command: "apt-get update && apt-get install -y ripgrep" });
 *   },
 * });
 * ```
 */
export function orbstack(config: OrbstackBackendConfig = {}): EveSandboxBackend {
  return new OrbstackBackend(config);
}

/** List orbbox-managed template/session machines (those with the prefix). */
export async function listOrbboxMachines(prefix = "eve"): Promise<string[]> {
  const all = await listMachines();
  return all.filter((m) => m.name.startsWith(`${prefix}-`)).map((m) => m.name);
}

/** Delete all orbbox-managed sessions and templates. Useful in tests/CI. */
export async function purgeOrbboxMachines(prefix = "eve"): Promise<void> {
  const names = await listOrbboxMachines(prefix);
  for (const n of names) {
    await runOrb(["delete", "-f", n], { throwOnNonZero: false });
  }
}
