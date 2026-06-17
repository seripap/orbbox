# AGENTS.md

Instructions for AI coding agents working in this repo. Humans, read the README first.

## What this is

`orbbox` wraps OrbStack Linux VMs as sandboxes for AI agents. Three layers:

1. `Sandbox` — low-level OrbStack handle (create, exec, spawn, file IO, destroy).
2. `OrbStackAiSandboxSession` / `toAiSandbox()` — adapter for Vercel AI SDK's `Experimental_SandboxSession`.
3. `orbstack()` — Vercel Eve `SandboxBackend` factory (`prewarm` + `create` + `dispose`).

Public surface is `src/index.ts`. Adapters are structural (no hard dep on `eve` or `ai`) so this package stays consumable in either ecosystem.

## Layout

```
src/
  orb.ts           low-level orbctl wrapper + StreamingProcess + JSON parsers
  sandbox.ts       Sandbox class (create/attach/clone/exec/spawn/file IO/destroy)
  schema.ts        zod validation for CreateConfig + ExecOptions
  errors.ts        OrbboxError tree
  ai/sandbox-session.ts   AI-SDK-shaped session over Sandbox
  eve/backend.ts          Eve SandboxBackend factory (orbstack)
  index.ts         public exports
test/
  unit/    pure + real-orb-output parsing tests (no mocks)
  e2e/     real OrbStack VM tests, gated by ORBBOX_E2E=1
.github/workflows/   ci.yml (Linux), e2e.yml (self-hosted Mac), release.yml
```

## Environment

- Tooling lives behind `flox activate`. Run any local command as `flox activate -- bash -c '...'`.
- Bun is the package manager and test runner. Don't introduce npm/pnpm/yarn.
- Node 20+ as a runtime target. Output is ESM only.
- OrbStack must be installed and running for e2e tests. Check with `orbctl status`.

## Commands

```sh
flox activate -- bun install
flox activate -- bun run typecheck
flox activate -- bun run build           # tsc -> dist/
flox activate -- bun test test/unit
flox activate -- ORBBOX_E2E=1 bun test test/e2e --timeout 300000
```

## Code rules

- TypeScript only. No `any`, no `as` casts to paper over types. Model the real shape.
- Validate at the boundary (zod in `schema.ts`). Internals can trust their inputs.
- Default to no comments. Only explain WHY when the reasoning isn't obvious from the code — e.g. the base64 round-trip in `Sandbox.readFile` exists because raw `cat` through orbctl corrupts non-UTF-8 bytes. That's worth a comment. "Read the file" is not.
- Throw typed errors (`OrbboxError` subclasses), never bare `Error`.
- Streaming surface: emit Node Readable streams from `Sandbox`, web ReadableStreams from the AI/Eve adapters. Don't mix.
- File IO: relative paths anchor at `/workspace` to match Eve/AI SDK conventions. `resolvePath()` is the canonical translator.

## Testing rules

- **No mocks.** Period. Unit tests either operate on pure functions (`parseListJson`, schema parse) or shell out to real `orbctl`. E2E tests provision real Alpine VMs and tear them down.
- Unit tests that need `orbctl` must self-skip via `describe.if(ORB_PRESENT)` so they pass on Linux CI.
- E2E tests are gated on `ORBBOX_E2E=1`. They always clean up — use `afterAll` to `destroy()` and follow up with `orbctl delete -f` as belt-and-braces.
- Don't expand snapshot fixtures. The real `orbctl` outputs are the source of truth — generate live in the test, validate the parse, move on.

## Vercel Eve compatibility

The Eve `SandboxBackend` contract is duplicated structurally in `src/eve/backend.ts` (`EveSandboxBackend`, `EveSandboxBackendHandle`, etc.) so we don't depend on `eve` directly. Two consequences:

- If you change a field name or signature here, cross-check against `https://github.com/vercel/eve/blob/main/packages/eve/src/shared/sandbox-backend.ts`. Drift breaks the contract silently.
- The `Experimental_SandboxSession` slice that Eve picks is also duplicated structurally in `src/ai/sandbox-session.ts`. Same rule applies — verify against `vercel/ai`'s `packages/provider-utils` types.

When the upstream contracts evolve, prefer adding methods (additive) over changing existing ones.

## CI

- `ci.yml` runs on Linux for every push/PR: install, typecheck, build, unit tests. Always green.
- `e2e.yml` runs on a self-hosted macOS runner with label `[self-hosted, macOS, orbstack]`. Triggered by schedule, manual dispatch, or PRs that touch `src/`, `test/e2e/`, or workflow files. GitHub-hosted Mac runners cannot run this — OrbStack needs interactive license activation.
- `release.yml` publishes to npm on `v*.*.*` tags. Asserts the tag matches `package.json`'s version before publishing.

## Things to avoid

- Don't add a generic "Linux sandbox" abstraction layer over multiple backends. That's Eve's job. `orbbox` is the OrbStack-specific implementation.
- Don't mock OrbStack in tests. If you need to test something that requires `orbctl`, write it as an e2e test and gate it.
- Don't bypass `runOrb`. Spawning `orbctl` directly skips error mapping, env handling, and the streaming/timeout/abort plumbing.
- Don't relax `--isolate-network` semantics in the AI/Eve adapters. OrbStack decides networking at machine create time; `setNetworkPolicy` post-create can only no-op when policy matches existing isolation, otherwise throw loud.
- Don't add features for hypothetical Eve versions. Match what's actually in `vercel/eve` `main`.

## Useful pointers

- OrbStack CLI: `orbctl --help`, `orbctl <subcommand> --help`. The CLI is the source of truth for what's possible.
- Eve sandbox contract: https://github.com/vercel/eve/tree/main/packages/eve/src/shared
- AI SDK sandbox surface: https://github.com/vercel/ai/tree/main/packages/sandbox-vercel/src — `VercelSandboxSession` is a useful reference implementation.
