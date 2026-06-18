# orbbox

> Turn OrbStack Linux VMs into AI agent sandboxes. Node.js / Bun module with streaming exec, file IO, and drop-in backends for **Vercel Eve** and **Flue**.

1. **`Sandbox`** — low-level OrbStack VM handle (create, exec, spawn, file IO, destroy).
2. **`orbstack()`** — a `SandboxBackend` factory for [Vercel Eve](https://github.com/vercel/eve). Drop it into `defineSandbox({ backend: orbstack(...) })` and you're done.
3. **`flue()`** — a `SandboxFactory` for [Flue](https://flueframework.com/docs/guide/sandboxes/). Wire it into your Flue `provider()` entrypoint.

## Requirements

- [OrbStack](https://orbstack.dev) installed and running on macOS.
- Node 20+ or Bun 1.0+.

## Install

```sh
bun add orbbox
# or
npm i orbbox
```

## Quick start (low-level)

```ts
import { Sandbox } from "orbbox";

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

## Vercel Eve integration

`orbstack()` returns a `SandboxBackend` that satisfies Eve's contract:

```ts
import { defineSandbox } from "eve/sandbox";
import { orbstack } from "orbbox";

export default defineSandbox({
  backend: orbstack({
    create: { distro: "ubuntu", isolated: true, memory: "4G", cpus: 2 },
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

Eve seed files in `agent/sandbox/workspace/` are mounted at `/workspace`. Relative paths in file methods anchor to `/workspace` (same as Eve and the AI SDK's sandbox surface).

### What you get from the backend

- `prewarm()` builds a **template machine** from your `bootstrap` hook + seed files. Stops it so clones see a quiescent snapshot. Idempotent across runs via `orbctl`'s template name.
- `create()` either reattaches an existing machine (from `existingMetadata`), clones the template (near-free thanks to OrbStack's copy-on-write snapshots), or provisions fresh.
- `dispose()` deletes the per-session machine. Template stays around for the next session.

### Network policy

OrbStack's isolation is decided at machine create time, so `setNetworkPolicy()` accepts only `"allow-all"` / `"deny-all"`, and only when they match how the machine was created. Anything else throws — better to fail loud than silently pretend to enforce. For fine-grained allowlists you'd need a firewall sidecar (open an issue if you want this).

## Flue integration

`flue()` returns a `SandboxFactory` matching Flue's [Sandbox Adapter API](https://flueframework.com/docs/api/sandbox-api/). Wire it into the `provider()` function Flue calls:

```ts
// agent/sandbox/provider.ts
import { createSandboxSessionEnv } from "@flue/runtime";
import { flue } from "orbbox";

export function provider(_sandbox: unknown) {
  return flue({
    createSessionEnv: createSandboxSessionEnv,
    create: { distro: "ubuntu", isolated: true, isolateNetwork: true },
    bootstrap: async (sb) => {
      await sb.exec("apt-get update && apt-get install -y ripgrep curl", { shell: true });
    },
  });
}
```

What you get:

- `createSessionEnv({ id })` provisions an isolated VM per Flue session — cloned near-instantly from a prewarmed template after the first call.
- The exposed `SandboxApi` covers `readFile` / `readFileBuffer` / `writeFile` / `stat` / `readdir` / `exists` / `mkdir` / `rm` / `exec`. Relative paths anchor at `/workspace`.
- `exec()` honours `cwd`, `env`, `timeoutMs`, and `signal` (mid-flight `AbortSignal` cancels the underlying process).
- `dispose()` on the returned `SessionEnv` deletes the per-session machine. The template stays around for the next session.

`@flue/runtime` is declared as an **optional peer dependency** — install it only if you actually use Flue. If you don't have it on hand, `flue()` also works without `createSessionEnv` and returns a structurally-compatible `{ id, api, dispose }` directly.

For single-shared-sandbox setups (no session-per-id provisioning), wrap an existing `Sandbox` directly:

```ts
import { Sandbox, OrbboxFlueSandboxApi } from "orbbox";

const sb = await Sandbox.create({ distro: "alpine" });
const api = new OrbboxFlueSandboxApi(sb);   // SandboxApi-compatible
```

## Vercel AI SDK integration (without Eve)

```ts
import { generateText } from "ai";
import { Sandbox, toAiSandbox } from "orbbox";

const sb = await Sandbox.create({ distro: "alpine" });
const result = await generateText({
  model: ...,
  prompt: "Run `uname -a`",
  experimental_sandbox: toAiSandbox(sb),
});
await sb.destroy();
```

`toAiSandbox(sandbox)` returns an object structurally compatible with `Experimental_SandboxSession` from `@ai-sdk/provider-utils` — `run`, `spawn`, `readFile`, `readBinaryFile`, `readTextFile`, `writeFile`, `writeBinaryFile`, `writeTextFile`, `removePath`, `resolvePath`, `id`, `description`.

## API reference

### `Sandbox.create(config?)`

| field | type | default | notes |
|---|---|---|---|
| `name` | `string` | random `orbbox-…` | OrbStack machine name |
| `distro` | `Distro` | `"ubuntu"` | any [orb-supported distro](https://docs.orbstack.dev/machines/distros) |
| `version` | `string` | distro default | e.g. `"24.04"` |
| `arch` | `"arm64" \| "amd64"` | host arch | |
| `user` | `string` | macOS username | default sandbox user |
| `memory` | string | unset | e.g. `"4G"` |
| `cpus` | `number \| string` | unset | |
| `disk` | string | unset | e.g. `"64G"` |
| `isolated` | `boolean` | `false` | disables host file sharing & integration |
| `isolateNetwork` | `boolean` | `false` | blocks LAN + host IPs; requires `isolated` |
| `forwardSshAgent` | `boolean` | `false` | only with `isolated` |
| `mounts` | `Array<string \| { source, dest? }>` | `[]` | host->guest mounts (isolated only) |
| `userDataPath` | string | unset | path to cloud-init user data |

### `Sandbox.attach(name)` / `Sandbox.clone(source, newName?)` / `Sandbox.list()`

### `sandbox.exec(command, options?)`

Returns `{ stdout, stderr, exitCode, signal, durationMs, args }`.

| option | type | notes |
|---|---|---|
| `shell` | `boolean` | run the string via `sh -c` |
| `user` | `string` | override the run-as user |
| `workdir` | `string` | working directory |
| `env` | `Record<string,string>` | extra env (forwarded via `ORBENV`) |
| `stdin` | `string \| Buffer` | piped into the process |
| `timeoutMs` | `number` | kill after N ms (SIGTERM -> SIGKILL after 2s) |
| `throwOnNonZero` | `boolean` | default `true` |

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
sandbox.push(hostPath, sandboxPath)  // host -> sandbox via orbctl push
sandbox.pull(sandboxPath, hostPath)
```

Binary reads round-trip via base64 internally to avoid utf-8 corruption of raw bytes.

### Lifecycle

```ts
sandbox.start() / stop() / restart()
sandbox.info()
sandbox.destroy()             // idempotent
sandbox.isDestroyed
```

### Errors

All thrown errors descend from `OrbboxError`:

- `OrbNotInstalledError` — `orbctl` not on PATH
- `OrbNotRunningError`   — OrbStack service stopped
- `OrbCommandError`      — orbctl exited non-zero (carries stdout/stderr/exit)
- `SandboxExistsError`   — name already taken
- `SandboxNotFoundError` — name doesn't exist (or was destroyed)
- `ValidationError`      — config rejected by schema (carries `.issues[]`)
- `ExecKilledError`      — killed by signal / timeout

## Testing

Unit tests run against real `orbctl` for output parsing (no mocks).
E2E tests provision real alpine VMs and tear them down:

```sh
bun test                        # unit
ORBBOX_E2E=1 bun test:e2e       # e2e (creates real VMs, ~30s)
```

## Isolation caveats

OrbStack VMs are real Linux kernels, not Docker containers. Defaults share host networking and bind-mount your macOS home. For an actual sandbox, pass `isolated: true` and ideally `isolateNetwork: true` at create time — these can't be flipped after the fact.

This is sufficient for "don't let the agent `rm -rf ~`". It is NOT a hardened multitenant boundary. Don't run hostile, internet-supplied code inside without additional layers.

## License

MIT
