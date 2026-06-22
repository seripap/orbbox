# AGENTS.md

Instructions for AI coding agents working in this repo. Humans, read the README first.

## What this is

`spawnbox` spawns AI agent sandboxes across pluggable **backends** behind one façade. The whole point of the package is the backend abstraction — a single `Sandbox` API over OrbStack VMs, Apple containers, or anything you register.

Layers:

1. `SandboxDriver` — the backend interface. Each backend (OrbStack, Apple `container`, your custom one) implements it. Drivers declare a `DriverCapabilities` record so callers know what's possible before they try.
2. `Sandbox` — backend-agnostic façade (create/attach/clone/exec/spawn/file IO/lifecycle/destroy). Owns everything pure-POSIX (command assembly, `/workspace` provisioning, base64 file IO, path resolution) and delegates backend-specific work to the driver chosen at create-time.
3. Connectors — `AiSandboxSession` / `toAiSandbox()` (Vercel AI SDK), `sandboxBackend()` (Vercel Eve), `flue()` + `SandboxFlueApi` (Flue). These ride on the façade and are driver-aware via `create.driver`.

Public surface is `src/index.ts`. Connectors are **structural** (no hard dep on `eve`, `ai`, or `@flue/runtime`) so the package stays consumable in any ecosystem.

## Layout

```
src/
  core/
    process.ts      CLI runner + StreamingProcess (runCli, spawnCli)
    exec-handle.ts  bufferedExec / streamingExec used by drivers
    driver.ts       SandboxDriver + DriverHandle + DriverCapabilities interfaces
    sandbox.ts      Sandbox façade (POSIX-level logic, delegates to a driver)
    schema.ts       zod validation for CreateConfig (incl. driver, image) + ExecOptions
    errors.ts       SpawnboxError tree
    registry.ts     resolveDriver / registerDriver / auto-detect
  drivers/
    orbstack/index.ts   OrbStack VM driver (distro source, clone, lifecycle)
    apple/index.ts      Apple container driver (image source, no clone)
  connectors/
    ai/sandbox-session.ts   AI-SDK-shaped session over Sandbox
    eve/backend.ts          Eve SandboxBackend factory (sandboxBackend)
    flue/adapter.ts         Flue SandboxFactory + SandboxApi (flue, SandboxFlueApi)
  index.ts          public exports
test/
  unit/    pure + real-CLI-output parsing tests (no mocks)
  e2e/     real sandbox tests, gated by SPAWNBOX_E2E=1
.github/workflows/   ci.yml (Linux), e2e.yml (self-hosted Mac), release.yml
```

## Environment

- Tooling lives behind `flox activate`. Run local commands as `flox activate -- bash -c '...'`.
- Bun is the package manager and test runner. Don't introduce npm/pnpm/yarn.
- Node 20+ runtime target. Output is ESM only.
- A backend must be present for e2e: OrbStack running (`orbctl status`), or Apple `container` (`container system status`, macOS 26 + Apple silicon).
- Bin overrides: `SPAWNBOX_ORB_BIN` (orbctl, falls back to legacy `ORBBOX_ORB_BIN`), `SPAWNBOX_CONTAINER_BIN` (Apple `container`).

## Commands

```sh
flox activate -- bun install
flox activate -- bun run typecheck
flox activate -- bun run build           # tsc -> dist/
flox activate -- bun test test/unit
flox activate -- SPAWNBOX_E2E=1 bun test test/e2e --timeout 180000
```

## Code rules

- TypeScript only. No `any`, no `as` casts to paper over types. Model the real shape.
- Validate at the boundary (zod in `core/schema.ts`). Internals can trust their inputs.
- Default to no comments. Only explain WHY when the reasoning isn't obvious — e.g. the base64 round-trip in `Sandbox.readFile` exists because raw `cat` through a backend CLI corrupts non-UTF-8 bytes. That's worth a comment. "Read the file" is not.
- Throw typed errors (`SpawnboxError` subclasses), never bare `Error`.
- Capability gaps are loud, never silent. If a driver can't do something, throw `DriverUnsupportedError` (carries `driver` + `operation`). Never no-op an option the caller explicitly set — e.g. OrbStack throws when handed an `image`.
- Streaming surface: emit Node Readable streams from `Sandbox`/drivers, web ReadableStreams from the AI/Eve connectors. Don't mix.
- File IO: relative paths anchor at `/workspace` to match Eve/AI SDK conventions. `resolvePath()` is the canonical translator and lives in the façade (it's pure POSIX over `exec`), not in drivers.

## The driver model

A `SandboxDriver` (see `core/driver.ts`) is the only thing a backend has to implement:

- `name`, `capabilities` (a `DriverCapabilities` record).
- `isAvailable()` — cheap, **non-throwing** probe used by auto-detection.
- `preflight()` — throw a helpful `DriverNotInstalledError` / `DriverNotRunningError` if unusable. This is where good errors come from; auto-detect skips it.
- `create` / `attach` / `clone` / `list` / `exists` — return `DriverHandle`s. The handle exposes `exec`/`spawn`/`pushFile`/`pullFile`/lifecycle; higher-level file IO stays in the façade.

`DriverCapabilities` gates features so the façade and connectors can fall back gracefully instead of dying deep in a CLI: `distroSource`, `imageSource`, `clone`, `networkIsolation`, `mounts`, `pauseResume`. The Eve and Flue connectors check `capabilities.clone` to decide whether to bake-and-clone a template or just provision fresh per session.

### Adding a new driver

1. Implement `SandboxDriver` in `src/drivers/<name>/index.ts`.
2. Declare `capabilities` **honestly**. This is load-bearing — connectors trust it to choose code paths. A lie here is a silent bug.
3. Gate every unsupported op with `DriverUnsupportedError`, not a silent fallback. (Apple's `clone()` is the reference: it throws with a remediation hint instead of pretending.)
4. Register it: `registerDriver("<name>", () => new MyDriver())`. Built-ins are wired in `core/registry.ts`; third parties call `registerDriver` at startup.
5. Auto-detect order is registration order (earlier = preferred). OrbStack is first because persistent VMs + cheap clone fit repeated agent sessions; Apple is the fallback.
6. The façade resolves the inner argv (shell-wrapping, string splitting) before calling the driver. Your driver only wraps that argv in its own invocation (`orbctl run -m …`, `container exec …`) and injects env however the backend wants.

## Testing rules

- **No mocks.** Period. Unit tests either operate on pure functions (`parseListJson`, `parseContainerList`, `parseStatLine`, schema parse) or shell out to a real backend CLI. E2E tests provision real sandboxes and tear them down.
- Unit tests that need a backend CLI must self-skip (e.g. `describe.if(ORB_PRESENT)` / a `container` presence guard) so they pass on Linux CI.
- E2E tests are gated on `SPAWNBOX_E2E=1`. They always clean up — use `afterAll` to `destroy()` and follow up with the CLI's force-delete as belt-and-braces.
- Don't expand snapshot fixtures. Real CLI output is the source of truth — generate live in the test, validate the parse, move on.
- New `stat -c '%s\t%Y\t%F'` `%F` variants (distros word "regular empty file" differently) need a `parseStatLine` unit test.

## Connector compatibility

The connector contracts are duplicated **structurally** so we never hard-depend on the upstream packages. That means upstream drift breaks us silently — cross-check when you touch these:

- **Eve** (`src/connectors/eve/backend.ts`): `EveSandboxBackend`, `EveSandboxBackendHandle`, etc. Cross-check `https://github.com/vercel/eve/blob/main/packages/eve/src/shared/sandbox-backend.ts`.
- **AI SDK** (`src/connectors/ai/sandbox-session.ts`): the `Experimental_SandboxSession` slice Eve and the AI SDK pick. Cross-check `vercel/ai`'s `packages/provider-utils` / `packages/sandbox-vercel`.
- **Flue** (`src/connectors/flue/adapter.ts`): `FlueSandboxApi`, `FlueSandboxFactory`, `FlueFileStat`, etc. Cross-check `https://flueframework.com/docs/api/sandbox-api/`. `@flue/runtime` is an optional peer dep — never import it; the consumer passes `createSandboxSessionEnv` into `flue()`.

When upstream contracts evolve, prefer adding (additive) over changing existing fields. Don't add features for hypothetical upstream versions — match what's actually shipped.

- Flue `exec()` uses `Sandbox.spawn` (not `exec`) when an `AbortSignal` is present so `signal.abort()` can kill the running process. Don't collapse this back to `exec` — it'd silently drop cancellation.
- Network policy is decided at create-time on every driver (OrbStack `--isolate-network`, Apple `--network none`). The AI/Eve `setNetworkPolicy` accepts only `allow-all`/`deny-all` and only when they match how the sandbox was created; anything else throws loud. Don't relax this into a silent no-op.

## Deprecated aliases

Renames from the `orbbox` era ship as aliases for one release cycle. Keep them until then, then remove:

- Errors: `OrbboxError` → `SpawnboxError`, `OrbCommandError` → `CommandError`, `OrbNotInstalledError` → `DriverNotInstalledError`, `OrbNotRunningError` → `DriverNotRunningError`.
- Eve: `orbstack()` → `sandboxBackend()` (the alias pins `driver: "orbstack"`); `OrbstackBackendConfig` → `SandboxBackendConfig`; `listOrbboxMachines`/`purgeOrbboxMachines` → `listManagedMachines`/`purgeManagedMachines`.
- AI: `OrbStackAiSandboxSession` → `AiSandboxSession`.
- Flue: `OrbboxFlueSandboxApi` → `SandboxFlueApi`.
- Env: `ORBBOX_E2E` → `SPAWNBOX_E2E`, `ORBBOX_ORB_BIN` → `SPAWNBOX_ORB_BIN` (old name still read as fallback).

## CI

- `ci.yml` runs on Linux for every push/PR: install, typecheck, build, unit tests. Always green (no backend needed — unit tests self-skip CLI-dependent cases).
- `e2e.yml` runs on a self-hosted macOS runner. Triggered by schedule, manual dispatch, or PRs touching `src/`, `test/e2e/`, or workflow files. GitHub-hosted Mac runners can't run OrbStack (interactive license activation); the Apple driver needs macOS 26 + Apple silicon.
- `release.yml` publishes to npm on `v*.*.*` tags. Asserts the tag matches `package.json`'s version before publishing.

## Things to avoid

- Don't bypass `runCli` / `bufferedExec` / `streamingExec`. Spawning a backend CLI directly skips error mapping, env handling, and the streaming/timeout/abort plumbing.
- Don't lie in `capabilities`. Connectors branch on it; a wrong flag is a silent fallback bug.
- Don't silently no-op an unsupported op. Throw `DriverUnsupportedError`.
- Don't mock a backend in tests. If it needs a CLI, write it as an e2e test and gate it.
- Don't leak driver-specific concepts into the façade. POSIX-level logic lives in `Sandbox`; backend-specific invocation lives in the driver.

## Useful pointers

- OrbStack CLI: `orbctl --help`, `orbctl <subcommand> --help`. The CLI is the source of truth.
- Apple container CLI: `container --help`, `container <cmd> --help`. The Apple driver's flag surface is a best-effort mapping against Apple's documented command reference (run/exec/cp/ls). Verify on a macOS 26 host; drift is contained to `src/drivers/apple/index.ts` (already noted in that file).
- Eve sandbox contract: https://github.com/vercel/eve/tree/main/packages/eve/src/shared
- AI SDK sandbox surface: https://github.com/vercel/ai/tree/main/packages/sandbox-vercel/src
- Flue sandbox adapter: https://flueframework.com/docs/api/sandbox-api/
