// ----- core ------------------------------------------------------------
export { Sandbox } from "./core/sandbox.js";
export type { FileOptions } from "./core/sandbox.js";
export type {
  CreateConfig,
  CreateConfigResolved,
  ExecOptions,
  ExecOptionsResolved,
  Distro,
  Arch,
  Mount,
  DriverName,
} from "./core/schema.js";
export { parseCreateConfig, parseExecOptions, normalizeMount } from "./core/schema.js";

export type {
  SandboxDriver,
  DriverHandle,
  DriverCapabilities,
  DriverExecOptions,
  SandboxRecord,
  ExecResult,
  SpawnHandle,
} from "./core/driver.js";

export { resolveDriver, registerDriver, listDriverNames } from "./core/registry.js";

export {
  StreamingProcess,
  runCli,
  spawnCli,
  type RunOptions,
  type RunResult,
} from "./core/process.js";

// ----- errors ----------------------------------------------------------
export {
  SpawnboxError,
  CommandError,
  DriverNotInstalledError,
  DriverNotRunningError,
  DriverUnsupportedError,
  DriverNotFoundError,
  SandboxExistsError,
  SandboxNotFoundError,
  ValidationError,
  ExecKilledError,
} from "./core/errors.js";

// Deprecated error aliases — kept for one release cycle.
export {
  SpawnboxError as OrbboxError,
  CommandError as OrbCommandError,
  DriverNotInstalledError as OrbNotInstalledError,
  DriverNotRunningError as OrbNotRunningError,
} from "./core/errors.js";

// ----- drivers ---------------------------------------------------------
export {
  OrbStackDriver,
  listMachines,
  infoMachine,
  machineExists,
  isOrbStackRunning,
  parseListJson,
  ORB_BIN,
  type OrbMachineRecord,
} from "./drivers/orbstack/index.js";

export {
  AppleDriver,
  listContainers,
  parseContainerList,
  resolveImage,
  CONTAINER_BIN,
} from "./drivers/apple/index.js";

// ----- connectors ------------------------------------------------------
export { AiSandboxSession, AiSandboxProcess, toAiSandbox, OrbStackAiSandboxSession } from "./connectors/ai/sandbox-session.js";

export {
  sandboxBackend,
  orbstack,
  listManagedMachines,
  purgeManagedMachines,
  listOrbboxMachines,
  purgeOrbboxMachines,
  type SandboxBackendConfig,
  type OrbstackBackendConfig,
  type EveSandboxBackend,
  type EveSandboxBackendHandle,
  type EveSandboxBackendSessionState,
  type EveSandboxBackendCreateInput,
  type EveSandboxBackendPrewarmInput,
  type EveSandboxBackendPrewarmResult,
  type EveSeedFile,
} from "./connectors/eve/backend.js";

export {
  flue,
  SandboxFlueApi,
  OrbboxFlueSandboxApi,
  SandboxOperationUnsupportedError,
  FileNotFoundError,
  listFlueMachines,
  purgeFlueMachines,
  parseStatLine,
  type FlueAdapterConfig,
  type FlueSandboxApi,
  type FlueSandboxFactory,
  type FlueSessionEnv,
  type FlueFileStat,
  type FlueExecOptions,
  type FlueExecResult,
  type FlueCreateSessionEnv,
} from "./connectors/flue/adapter.js";
