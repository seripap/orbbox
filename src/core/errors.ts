/**
 * Base error for anything spawnbox throws. All subclasses inherit so callers can
 * `catch (e) { if (e instanceof SpawnboxError) ... }`.
 */
export class SpawnboxError extends Error {
  override readonly name: string = "SpawnboxError";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/**
 * A backend CLI (orbctl, container, ...) exited non-zero. Carries
 * stdout/stderr/exit code for diagnostics.
 */
export class CommandError extends SpawnboxError {
  override readonly name = "CommandError";
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

/** A backend CLI binary was not found on PATH. */
export class DriverNotInstalledError extends SpawnboxError {
  override readonly name = "DriverNotInstalledError";
}

/** A backend service is installed but not running. */
export class DriverNotRunningError extends SpawnboxError {
  override readonly name = "DriverNotRunningError";
}

/**
 * The selected driver cannot perform the requested operation (e.g. cloning on a
 * driver without copy-on-write snapshots). Thrown loud rather than silently
 * no-op'd so callers know the capability is genuinely missing.
 */
export class DriverUnsupportedError extends SpawnboxError {
  override readonly name = "DriverUnsupportedError";
  constructor(
    readonly driver: string,
    readonly operation: string,
    detail?: string,
  ) {
    super(detail ? `driver "${driver}" cannot ${operation}: ${detail}` : `driver "${driver}" cannot ${operation}`);
  }
}

/** No driver could be resolved (none available, or an unknown name was requested). */
export class DriverNotFoundError extends SpawnboxError {
  override readonly name = "DriverNotFoundError";
}

/** A sandbox with that name already exists. */
export class SandboxExistsError extends SpawnboxError {
  override readonly name = "SandboxExistsError";
  constructor(readonly machine: string) {
    super(`sandbox "${machine}" already exists`);
  }
}

/** A sandbox with that name does not exist. */
export class SandboxNotFoundError extends SpawnboxError {
  override readonly name = "SandboxNotFoundError";
  constructor(readonly machine: string) {
    super(`sandbox "${machine}" not found`);
  }
}

/** User-supplied config failed validation. */
export class ValidationError extends SpawnboxError {
  override readonly name = "ValidationError";
  constructor(message: string, readonly issues: readonly string[]) {
    super(message);
  }
}

/** A streaming exec was killed by `.kill()` or a signal. */
export class ExecKilledError extends SpawnboxError {
  override readonly name = "ExecKilledError";
  constructor(readonly signal: NodeJS.Signals | null) {
    super(`exec terminated by signal ${signal ?? "(unknown)"}`);
  }
}
