/**
 * Vercel Eve sandbox using the orbstack backend.
 *
 *   bun run examples/eve-sandbox.ts
 *
 * This file is what `agent/sandbox.ts` would look like in an Eve app.
 * If you have `eve` installed, you can also use `defineSandbox` from it —
 * the orbstack backend is structurally compatible with Eve's
 * `SandboxBackend` interface.
 */
import { orbstack } from "../src/index.js";

const backend = orbstack({
  create: {
    distro: "alpine",
    memory: "1G",
    cpus: 2,
    // isolated: true,
    // isolateNetwork: true,
  },
  log: (m) => console.log(m),
});

// 1) Prewarm a template, optionally with seed files + bootstrap.
await backend.prewarm({
  templateKey: "ripgrep-and-curl",
  seedFiles: [{ path: "/workspace/README.txt", content: "seeded at template time\n" }],
  runtimeContext: { appRoot: process.cwd() },
  bootstrap: async ({ use }) => {
    const ses = (await use()) as any;
    await ses.run({ command: "apk add --no-cache ripgrep curl" });
  },
});

// 2) Open a per-session sandbox cloned from that template.
const handle = await backend.create({
  templateKey: "ripgrep-and-curl",
  sessionKey: "demo-session",
  runtimeContext: { appRoot: process.cwd() },
});

try {
  const which = await handle.session.run({ command: "which rg && rg --version | head -1" });
  console.log(which.stdout);
  const readme = await handle.session.readTextFile({ path: "README.txt" });
  console.log("seed file:", readme?.trim());
} finally {
  await handle.dispose();
}
