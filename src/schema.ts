import { z } from "zod";
import { ValidationError } from "./errors.js";

/**
 * Supported distros, per `orbctl create --help`. Defaults track orb's defaults.
 * Versions are validated as free-form strings since orb's list moves over time
 * — we don't want to bake a list and then go stale.
 */
export const DistroSchema = z.enum([
  "alma",
  "alpine",
  "arch",
  "centos",
  "debian",
  "devuan",
  "fedora",
  "gentoo",
  "kali",
  "nixos",
  "openeuler",
  "opensuse",
  "oracle",
  "rocky",
  "ubuntu",
  "void",
]);
export type Distro = z.infer<typeof DistroSchema>;

export const ArchSchema = z.enum(["arm64", "amd64"]);
export type Arch = z.infer<typeof ArchSchema>;

/**
 * Size string: integer + optional unit (M, G, Mi, Gi). We let orb itself
 * arbitrate the exact grammar; just guard against obvious garbage.
 */
const SizeSchema = z
  .string()
  .regex(/^\d+\s*(K|M|G|T|Ki|Mi|Gi|Ti)?$/i, "expected size like \"4G\" or \"512M\"");

const NameSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9][a-z0-9_-]*$/i, "machine names: alphanumeric, dash, underscore; must start with alphanumeric");

export const MountSchema = z.union([
  z.string().min(1), // SOURCE or SOURCE:DEST
  z.object({ source: z.string().min(1), dest: z.string().optional() }),
]);
export type Mount = z.infer<typeof MountSchema>;

export const CreateConfigSchema = z
  .object({
    name: NameSchema.optional(),
    distro: DistroSchema.default("ubuntu"),
    version: z.string().min(1).optional(),
    arch: ArchSchema.optional(),
    user: z
      .string()
      .min(1)
      .regex(/^[a-z_][a-z0-9_-]*$/, "POSIX-ish username")
      .optional(),
    memory: SizeSchema.optional(),
    cpus: z
      .union([z.number().int().positive(), z.string().regex(/^\d+$/)])
      .optional(),
    disk: SizeSchema.optional(),
    isolated: z.boolean().default(false),
    isolateNetwork: z.boolean().default(false),
    forwardSshAgent: z.boolean().default(false),
    mounts: z.array(MountSchema).default([]),
    setPassword: z.boolean().default(false),
    userDataPath: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    if (cfg.isolateNetwork && !cfg.isolated) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "isolateNetwork requires isolated=true",
        path: ["isolateNetwork"],
      });
    }
    if (cfg.mounts.length > 0 && !cfg.isolated) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "mounts only apply to isolated machines",
        path: ["mounts"],
      });
    }
    if (cfg.forwardSshAgent && !cfg.isolated) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "forwardSshAgent only applies to isolated machines",
        path: ["forwardSshAgent"],
      });
    }
  });
export type CreateConfig = z.input<typeof CreateConfigSchema>;
export type CreateConfigResolved = z.output<typeof CreateConfigSchema>;

export const ExecOptionsSchema = z
  .object({
    user: z.string().min(1).optional(),
    workdir: z.string().min(1).optional(),
    env: z.record(z.string()).optional(),
    /** Treat command string as a shell pipeline (run via `sh -c`). */
    shell: z.boolean().default(false),
    /** Milliseconds before the process is killed. */
    timeoutMs: z.number().int().positive().optional(),
    /** Throw on non-zero exit code (default true for exec, false for spawn). */
    throwOnNonZero: z.boolean().optional(),
    /** stdin payload — string or Buffer. */
    stdin: z.union([z.string(), z.instanceof(Buffer)]).optional(),
  })
  .strict()
  .default({});
export type ExecOptions = z.input<typeof ExecOptionsSchema>;

/**
 * Parse a config, throwing ValidationError on failure.
 * Centralized so we get consistent error shape across the API.
 */
export function parseCreateConfig(input: unknown): CreateConfigResolved {
  const r = CreateConfigSchema.safeParse(input);
  if (!r.success) {
    const issues = r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new ValidationError(`invalid sandbox config: ${issues.join("; ")}`, issues);
  }
  return r.data;
}

export function parseExecOptions(input: unknown): z.output<typeof ExecOptionsSchema> {
  const r = ExecOptionsSchema.safeParse(input ?? {});
  if (!r.success) {
    const issues = r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new ValidationError(`invalid exec options: ${issues.join("; ")}`, issues);
  }
  return r.data;
}

export function normalizeMount(m: Mount): string {
  if (typeof m === "string") return m;
  return m.dest ? `${m.source}:${m.dest}` : m.source;
}
