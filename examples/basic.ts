/**
 * Minimal orbbox example. Creates a sandbox, runs a few commands, demos
 * streaming, and tears down.
 *
 *   bun run examples/basic.ts
 */
import { Sandbox } from "../src/index.js";

const sandbox = await Sandbox.create({
  distro: "alpine",
  // isolated: true,        // uncomment for a network-isolated VM
  // isolateNetwork: true,
});

console.log("created", sandbox.name);

try {
  const hello = await sandbox.exec(["echo", "hello from", sandbox.name]);
  console.log("exec:", hello.stdout.trim());

  // streaming exec
  const handle = sandbox.spawn(
    "for i in 1 2 3 4 5; do echo tick $i; sleep 0.2; done",
    { shell: true },
  );
  handle.on("stdout", (c) => process.stdout.write(`[stream] ${c}`));
  const stream = await handle.done;
  console.log(`streamed exit=${stream.exitCode} duration=${stream.durationMs.toFixed(0)}ms`);

  // file IO
  await sandbox.writeFile("greeting.txt", "hi from the host\n");
  const back = await sandbox.readTextFile("greeting.txt");
  console.log("readTextFile:", back?.trim());
} finally {
  await sandbox.destroy();
  console.log("destroyed");
}
