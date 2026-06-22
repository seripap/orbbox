# spawnbox

> Spawn AI agent sandboxes across pluggable backends. Node.js / Bun module with streaming exec, file IO, host file copy, and drop-in connectors for the **Vercel AI SDK**, **Vercel Eve**, and **Flue**.

Two backends ship today, both behind one backend-agnostic `Sandbox` façade:

- **`orbstack`** — [OrbStack](https://orbstack.dev) persistent Linux VMs. Distro-based, cheap copy-on-write **clone**, real start/stop lifecycle. The better fit for repeated agent sessions.
- **`apple`** — Apple's [`container`](https://github.com/apple/container) CLI (the containerization framework). Image-based, requires **macOS 26 on Apple silicon**. No clone (templating is via images).

Pick one explicitly, or let `"auto"` detect what's available (prefers OrbStack, falls back to Apple). Add your own backend with `registerDriver()`.

## Requirements

- Node 20+ or Bun 1.0+.
- At least one backend:
  - OrbStack installed and running, **or**
  - Apple `container` available (macOS 26, Apple silicon).

## Install

```sh
bun add spawnbox
# or
npm i spawnbox
```

## Quick start

```ts
import { Sandbox } from "spawnbox";

// driver: "auto" (default) picks the first available backend.
const sb = await Sandbox.create({ distro: "alpine", isolated: true, isolateNetwork: true });

const r = await sb.exec(["echo", "hello"]);          // buffered
console.log(r.stdout);

const proc = sb.spawn("for i in 1 2 3; do echo $i; sleep 0.5; done", { shell: true });
proc.on("stdout", (chunk) => process.stdout.write(chunk));
await proc.done;

await sb.writeFile("greeting.txt", "hi\n");           // relative -> /workspace/greeting.txt
const back = await sb.readTextFile("greeting.txt");

await sb.destroy();
```

## Choosing a backend

```ts
// Explicit OrbStack VM (distro-based).
const orb = await Sandbox.create({ driver: "orbstack", distro: "ubuntu" });

// Explicit Apple container from a distro (mapped to a Docker Hub image)…
const apple = await Sandbox.create({ driver: "apple", distro: "alpine" });

// …or from an explicit OCI image (image-source drivers only).
const fromImage = await Sandbox.create({ driver: "apple", image: "node:22-bookworm" });

// Let spawnbox detect. OrbStack wins if running; otherwise Apple.
const auto = await Sandbox.create({ driver: "auto" }); // "auto" is the default
```

`distro` works on both drivers. On Apple the distro name maps to a Docker Hub library image (`alpine`, `ubuntu`, `archlinux`, …); pass `image` to override. On OrbStack, `image` is meaningless and passing it throws `DriverUnsupportedError` — fail loud, never silently ignore an option you set on purpose.

### Capabilities

Each driver declares what it can do. Ask for something it can't and you get a `DriverUnsupportedError`, not a silent no-op:

| capability | orbstack | apple |
|---|---|---|
| `distroSource` | yes | yes (distro → image) |
| `imageSource` (OCI `image`) | no | yes |
| `clone` (copy-on-write) | yes | no |
| `networkIsolation` | yes | yes |
| `mounts` | yes | yes |
| `pauseResume` | yes | yes |

```ts
import { resolveDriver } from "spawnbox";

const driver = await resolveDriver("auto");
if (driver.capabilities.clone) {
  await Sandbox.clone("base", "session-1", { driver: driver.name });
} else {
  await Sandbox.create({ driver: driver.name, image: "my-template:latest" });
}
```

### Custom drivers

Implement `SandboxDriver`, register it under any name, and it joins auto-detection (registration order = priority):

```ts
import { registerDriver, type SandboxDriver } from "spawnbox";

const docker: SandboxDriver = {
  name: "docker",
  capabilities: { distroSource: false, imageSource: true, clone: false, networkIsolation: true, mounts: true, pauseResume: true },
  async isAvailable() { /* cheap, non-throwing probe */ return true; },
  async preflight() { /* throw DriverNotInstalled/NotRunning if unusable */ },
  async create(name, cfg) { /* ... return a DriverHandle */ },
  async attach(id) { /* ... */ },
  async clone(source, newName) { /* throw DriverUnsupportedError if !clone */ },
  async list() { return []; },
  async exists(id) { return false; },
};

registerDriver("docker", () => docker);
const sb = await Sandbox.create({ driver: "docker", image: "alpine" });
```

Declare capabilities honestly and gate the ones you don't support with `DriverUnsupportedError`. The façade and connectors consult `capabilities` before attempting an operation, so honesty there is what makes graceful fallback work.

## Vercel AI SDK integration

```ts
import { generateText } from "ai";
import { Sandbox, toAiSandbox } from "spawnbox";

const sb = await Sandbox.create({ distro: "alpine" });
const result = await generateText({
  model: ...,
  prompt: "Run `uname -a`",
  experimental_sandbox: toAiSandbox(sb),
});
await sb.destroy();
```

`toAiSandbox(sandbox)` (or `new AiSandboxSession(sandbox)`) returns an object structurally compatible with `Experimental_SandboxSession` from `@ai-sdk/provider-utils` — `run`, `spawn`, `readFile`, `readBinaryFile`, `readTextFile`, `writeFile`, `writeBinaryFile`, `writeTextFile`, `removePath`, `resolvePath`, `setNetworkPolicy`, `id`, `description`.

## Vercel Eve integration

`sandboxBackend()` returns a `SandboxBackend` that satisfies Eve's contract. The driver comes from `create.driver` (defaults to auto-detection):

```ts
import { defineSandbox } from "eve/sandbox";
import { sandboxBackend } from "spawnbox";

export default defineSandbox({
  backend: sandboxBackend({
    create: { driver: "auto", distro: "ubuntu", isolated: true, memory: "4G", cpus: 2 },
  }),
  async bootstrap({ use }) {
    const sb = await use();
    await sb.run({ command: "apt-get update && apt-get install -y ripgrep curl" });
  },
  async onSession({ use }) {
    const sb = await use();
    await sb.writeTextFile({ path: "session-marker.txt", content: "ready" });
  },
});
```

Eve seed files in `agent/sandbox/workspace/` land at `/workspace`. Relative paths in file methods anchor to `/workspace` (same as Eve and the AI SDK's sandbox surface).

### What you get from the backend

- `prewarm()` builds a **template** from your `bootstrap` hook + seed files, then stops it so clones see a quiescent snapshot. Idempotent across runs via the template name. On drivers **without** `clone` support it skips baking a template entirely — sessions just provision fresh.
- `create()` reattaches an existing sandbox (from `existingMetadata`), clones the template (near-free on OrbStack's copy-on-write snapshots), or provisions fresh — picking whichever is possible for the active driver.
- `dispose()` deletes the per-session sandbox. The template stays for the next session.

`orbstack()` is kept as a **deprecated alias** for `sandboxBackend()` that pins `driver: "orbstack"`. Use `sandboxBackend({ create: { driver: "orbstack" } })` instead.

### Network policy

Network isolation is decided at create time on both backends (OrbStack `--isolate-network`, Apple `--network none`), so `setNetworkPolicy()` accepts only `"allow-all"` / `"deny-all"`, and only when they match how the sandbox was created. Anything else throws — better to fail loud than silently pretend to enforce. For fine-grained allowlists you'd need a firewall sidecar (open an issue).

## Flue integration

`flue()` returns a `SandboxFactory` matching Flue's [Sandbox Adapter API](https://flueframework.com/docs/api/sandbox-api/). The driver comes from `create.driver`. Wire it into the `provider()` function Flue calls:

```ts
// agent/sandbox/provider.ts
import { createSandboxSessionEnv } from "@flue/runtime";
import { flue } from "spawnbox";

export function provider(_sandbox: unknown) {
  return flue({
    createSessionEnv: createSandboxSessionEnv,
    create: { driver: "auto", distro: "ubuntu", isolated: true, isolateNetwork: true },
    bootstrap: async (sb) => {
      await sb.exec("apt-get update && apt-get install -y ripgrep curl", { shell: true });
    },
  });
}
```

What you get:

- `createSessionEnv({ id })` provisions an isolated sandbox per Flue session. On drivers with cheap snapshots it clones from a prewarmed template (near-instant after the first call); on drivers without `clone`, every session provisions fresh.
- The exposed `SandboxApi` covers `readFile` / `readFileBuffer` / `writeFile` / `stat` / `readdir` / `exists` / `mkdir` / `rm` / `exec`. Relative paths anchor at `/workspace`.
- `exec()` honours `cwd`, `env`, `timeoutMs`, and `signal` (mid-flight `AbortSignal` cancels the underlying process).
- `dispose()` on the returned `SessionEnv` deletes the per-session sandbox. The template stays around for the next session.

`@flue/runtime` is an **optional peer dependency** — install it only if you actually use Flue. `flue()` also works without `createSessionEnv` and returns a structurally-compatible `{ id, api, dispose }` directly.

For single-shared-sandbox setups (no session-per-id provisioning), wrap an existing `Sandbox`:

```ts
import { Sandbox, SandboxFlueApi } from "spawnbox";

const sb = await Sandbox.create({ distro: "alpine" });
const api = new SandboxFlueApi(sb);   // SandboxApi-compatible
```

`OrbboxFlueSandboxApi` remains as a deprecated alias for `SandboxFlueApi`.

## API reference

### `Sandbox.create(config?)`

| field | type | default | notes |
|---|---|---|---|
| `driver` | `"auto" \| "orbstack" \| "apple" \| string` | `"auto"` | which backend; `"auto"` detects (OrbStack, then Apple) |
| `name` | `string` | random `spawnbox-…` | sandbox name |
| `distro` | `Distro` | `"ubuntu"` | distro name; on Apple maps to a Docker Hub image |
| `version` | `string` | distro/image default | e.g. `"24.04"` |
| `image` | `string` | unset | OCI image ref. Image-source drivers only; wins over `distro`. Throws on `orbstack` |
| `arch` | `"arm64" \| "amd64"` | host arch | |
| `user` | `string` | backend default | default sandbox user |
| `memory` | string | unset | e.g. `"4G"` |
| `cpus` | `number \| string` | unset | |
| `disk` | string | unset | e.g. `"64G"` (orbstack) |
| `isolated` | `boolean` | `false` | disables host file sharing / integration |
| `isolateNetwork` | `boolean` | `false` | blocks LAN + host IPs; requires `isolated` |
| `forwardSshAgent` | `boolean` | `false` | only with `isolated` |
| `mounts` | `Array<string \| { source, dest? }>` | `[]` | host→guest mounts (isolated only) |
| `userDataPath` | string | unset | cloud-init user data (orbstack) |

### `Sandbox.attach(name, { driver? })` / `Sandbox.clone(source, newName?, { driver? })` / `Sandbox.list({ driver? })`

`clone` throws `DriverUnsupportedError` on drivers without copy-on-write snapshots (Apple). Check `capabilities.clone` or fall back to `create`.

### `sandbox.exec(command, options?)`

Returns `{ stdout, stderr, exitCode, signal, durationMs, args }`.

| option | type | notes |
|---|---|---|
| `shell` | `boolean` | run the string via `sh -lc` |
| `user` | `string` | override the run-as user |
| `workdir` | `string` | working directory |
| `env` | `Record<string,string>` | extra env (forwarded per-driver) |
| `stdin` | `string \| Buffer` | piped into the process |
| `timeoutMs` | `number` | kill after N ms |
| `throwOnNonZero` | `boolean` | default `true` (exec), `false` (spawn) |

### `sandbox.spawn(command, options?)`

Returns a `SpawnHandle`:

```ts
interface SpawnHandle {
  process: StreamingProcess;
  stdout: NodeJS.ReadableStream;       // utf-8
  stderr: NodeJS.ReadableStream;
  stdin:  NodeJS.WritableStream;
  done: Promise<ExecResult>;
  kill(signal?: NodeJS.Signals): void;
  on(event: "stdout" | "stderr", listener: (chunk: string) => void): SpawnHandle;
}
```

### File IO

```ts
sandbox.writeFile(path, content)                   // string | Buffer | Uint8Array
sandbox.readFile(path)        // -> Buffer | null
sandbox.readTextFile(path, { encoding? })
sandbox.removePath(path, { recursive?, force? })
sandbox.resolvePath(path)     // anchors relative paths under /workspace
sandbox.push(hostPath, sandboxPath)  // host -> sandbox
sandbox.pull(sandboxPath, hostPath)
```

Binary reads round-trip via base64 internally to avoid utf-8 corruption of raw bytes.

### Lifecycle

```ts
sandbox.start() / stop() / restart()
sandbox.info()
sandbox.destroy()             // idempotent
sandbox.isDestroyed
sandbox.driver                // active driver name
```

### Driver registry

```ts
import { resolveDriver, registerDriver, listDriverNames } from "spawnbox";
```

### Errors

All thrown errors descend from `SpawnboxError`:

- `DriverNotInstalledError` — backend CLI not on PATH
- `DriverNotRunningError`   — backend service installed but stopped
- `DriverUnsupportedError`  — driver can't do the requested op (carries `driver`, `operation`)
- `DriverNotFoundError`     — no driver available, or unknown driver name
- `CommandError`            — backend CLI exited non-zero (carries args/stdout/stderr/exit/signal)
- `SandboxExistsError`      — name already taken
- `SandboxNotFoundError`    — name doesn't exist (or was destroyed)
- `ValidationError`         — config rejected by schema (carries `.issues[]`)
- `ExecKilledError`         — killed by signal / timeout

**Deprecated aliases** (kept one release cycle): `OrbboxError` → `SpawnboxError`, `OrbCommandError` → `CommandError`, `OrbNotInstalledError` → `DriverNotInstalledError`, `OrbNotRunningError` → `DriverNotRunningError`.

## Testing

Unit tests run against the real backend CLIs for output parsing (no mocks).
E2E tests provision real sandboxes and tear them down:

```sh
bun test                        # unit
SPAWNBOX_E2E=1 bun run test:e2e # e2e (creates real sandboxes)
```

Env overrides: `SPAWNBOX_ORB_BIN` (orbctl path, falls back to the old `ORBBOX_ORB_BIN`), `SPAWNBOX_CONTAINER_BIN` (Apple `container` path).

## Isolation caveats

OrbStack VMs are real Linux kernels; Apple `container` sandboxes are lightweight VMs from the containerization framework. Neither default is a hardened multitenant boundary. For an actual sandbox, pass `isolated: true` and ideally `isolateNetwork: true` at create time — these can't be flipped after the fact.

This is sufficient for "don't let the agent `rm -rf ~`". It is NOT safe for hostile, internet-supplied code without additional layers.

> The Apple driver's CLI flags are a best-effort mapping against Apple's documented `container` command reference and may need verification on a macOS 26 host. Any drift is contained to `src/drivers/apple/index.ts`.

## License

MIT
