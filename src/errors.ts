/**
 * Base error for anything orbbox throws. All subclasses inherit so callers can
 * `catch (e) { if (e instanceof OrbboxError) ... }`.
 */
export class OrbboxError extends Error {
  override readonly name: string = "OrbboxError";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** orbctl exited non-zero. Carries stdout/stderr/exit code for diagnostics. */
export class OrbCommandError extends OrbboxError {
  override readonly name = "OrbCommandError";
  constructor(
    message: string,
    readonly args: readonly string[],
    readonly exitCode: number | null,
    readonly signal: NodeJS.Signals | null,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(message);
  }
}

/** orbctl binary not found on PATH. */
export class OrbNotInstalledError extends OrbboxError {
  override readonly name = "OrbNotInstalledError";
}

/** OrbStack service is installed but not running. */
export class OrbNotRunningError extends OrbboxError {
  override readonly name = "OrbNotRunningError";
}

/** A machine with that name already exists. */
export class SandboxExistsError extends OrbboxError {
  override readonly name = "SandboxExistsError";
  constructor(readonly machine: string) {
    super(`sandbox "${machine}" already exists`);
  }
}

/** A machine with that name does not exist. */
export class SandboxNotFoundError extends OrbboxError {
  override readonly name = "SandboxNotFoundError";
  constructor(readonly machine: string) {
    super(`sandbox "${machine}" not found`);
  }
}

/** User-supplied config failed validation. */
export class ValidationError extends OrbboxError {
  override readonly name = "ValidationError";
  constructor(message: string, readonly issues: readonly string[]) {
    super(message);
  }
}

/** A streaming exec was killed by `.kill()` or a signal. */
export class ExecKilledError extends OrbboxError {
  override readonly name = "ExecKilledError";
  constructor(readonly signal: NodeJS.Signals | null) {
    super(`exec terminated by signal ${signal ?? "(unknown)"}`);
  }
}
