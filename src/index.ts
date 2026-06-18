export { Sandbox } from "./sandbox.js";
export type { ExecResult, SpawnHandle, FileOptions } from "./sandbox.js";
export type { CreateConfig, ExecOptions, Distro, Arch, Mount } from "./schema.js";
export {
  OrbboxError,
  OrbCommandError,
  OrbNotInstalledError,
  OrbNotRunningError,
  SandboxExistsError,
  SandboxNotFoundError,
  ValidationError,
  ExecKilledError,
} from "./errors.js";
export {
  runOrb,
  spawnOrb,
  listMachines,
  infoMachine,
  machineExists,
  isOrbStackRunning,
  assertOrbStackRunning,
  StreamingProcess,
  type OrbMachineRecord,
  type RunOptions,
  type RunResult,
} from "./orb.js";

export { OrbStackAiSandboxSession, AiSandboxProcess, toAiSandbox } from "./ai/sandbox-session.js";

export {
  orbstack,
  listOrbboxMachines,
  purgeOrbboxMachines,
  type OrbstackBackendConfig,
  type EveSandboxBackend,
  type EveSandboxBackendHandle,
  type EveSandboxBackendSessionState,
  type EveSandboxBackendCreateInput,
  type EveSandboxBackendPrewarmInput,
  type EveSandboxBackendPrewarmResult,
  type EveSeedFile,
} from "./eve/backend.js";

export {
  flue,
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
} from "./flue/adapter.js";
