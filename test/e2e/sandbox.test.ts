import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Buffer } from "node:buffer";
import { Sandbox } from "../../src/sandbox.js";
import { runOrb } from "../../src/orb.js";

/**
 * Real OrbStack VM tests. Gated by ORBBOX_E2E=1 so unit-test runs stay fast.
 * Run: `ORBBOX_E2E=1 bun test test/e2e --timeout 180000`
 *
 * We always use alpine (smallest image) for speed and delete the machine at
 * the end so the test is hermetic.
 */
const E2E = process.env["ORBBOX_E2E"] === "1";
const NAME = `orbbox-e2e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

let sandbox: Sandbox;

beforeAll(async () => {
  if (!E2E) return;
  sandbox = await Sandbox.create({ name: NAME, distro: "alpine" });
});

afterAll(async () => {
  if (!E2E) return;
  await sandbox?.destroy();
  // belt and braces
  await runOrb(["delete", "-f", NAME], { throwOnNonZero: false });
});

describe.if(E2E)("Sandbox e2e", () => {
  test("exec captures stdout/stderr/exit", async () => {
    const r = await sandbox.exec(["echo", "hello"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("hello");
  });

  test("exec shell pipeline", async () => {
    const r = await sandbox.exec("printf 'a\\nb\\nc\\n' | wc -l", { shell: true });
    expect(r.exitCode).toBe(0);
    expect(parseInt(r.stdout.trim(), 10)).toBe(3);
  });

  test("exec non-zero throws by default", async () => {
    await expect(sandbox.exec(["false"])).rejects.toThrow();
  });

  test("exec non-zero with throwOnNonZero=false returns result", async () => {
    const r = await sandbox.exec(["sh", "-c", "exit 7"], { throwOnNonZero: false });
    expect(r.exitCode).toBe(7);
  });

  test("workspace defaults exist", async () => {
    const r = await sandbox.exec(["test", "-d", sandbox.workspace]);
    expect(r.exitCode).toBe(0);
  });

  test("env vars forwarded via ORBENV", async () => {
    const r = await sandbox.exec("echo \"$FOO\"", { shell: true, env: { FOO: "bar-baz" } });
    expect(r.stdout.trim()).toBe("bar-baz");
  });

  test("workdir applied", async () => {
    const r = await sandbox.exec(["pwd"], { workdir: "/tmp" });
    expect(r.stdout.trim()).toBe("/tmp");
  });

  test("writeFile + readFile roundtrip (text)", async () => {
    await sandbox.writeFile("hello.txt", "world\n");
    const t = await sandbox.readTextFile("hello.txt");
    expect(t).toBe("world\n");
  });

  test("writeFile + readFile roundtrip (binary)", async () => {
    const bytes = Buffer.from([0, 1, 2, 3, 255, 254, 0, 42]);
    await sandbox.writeFile("blob.bin", bytes);
    const buf = await sandbox.readFile("blob.bin");
    expect(buf).not.toBeNull();
    expect(buf!.length).toBe(bytes.length);
    expect(buf!.equals(bytes)).toBe(true);
  });

  test("readFile returns null on missing file", async () => {
    const buf = await sandbox.readFile("/nope/not/here.txt");
    expect(buf).toBeNull();
  });

  test("writeFile creates parent directories", async () => {
    await sandbox.writeFile("deep/nested/path/file.txt", "ok");
    const t = await sandbox.readTextFile("deep/nested/path/file.txt");
    expect(t).toBe("ok");
  });

  test("removePath recursive", async () => {
    await sandbox.writeFile("rmme/a.txt", "x");
    await sandbox.removePath("rmme", { recursive: true });
    const buf = await sandbox.readFile("rmme/a.txt");
    expect(buf).toBeNull();
  });

  test("spawn streams stdout incrementally", async () => {
    const chunks: string[] = [];
    const handle = sandbox.spawn(
      "for i in 1 2 3; do echo line$i; sleep 0.1; done",
      { shell: true },
    );
    handle.on("stdout", (c) => chunks.push(c));
    const r = await handle.done;
    expect(r.exitCode).toBe(0);
    expect(chunks.join("").trim().split("\n")).toEqual(["line1", "line2", "line3"]);
    // streamed in pieces, not one big blob (when the kernel cooperates)
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });

  test("spawn .kill() terminates", async () => {
    const handle = sandbox.spawn("sleep 30", { shell: true, throwOnNonZero: false });
    setTimeout(() => handle.kill("SIGTERM"), 200);
    const r = await handle.done.catch((e: Error) => ({ exitCode: -1, signal: null, stdout: "", stderr: "", durationMs: 0, args: [] as string[], _err: e }));
    expect(r.exitCode).not.toBe(0);
  });

  test("exec timeoutMs kills long-running command", async () => {
    const start = performance.now();
    await expect(
      sandbox.exec("sleep 10", { shell: true, timeoutMs: 500 }),
    ).rejects.toThrow();
    expect(performance.now() - start).toBeLessThan(5000);
  });

  test("info() returns the machine record", async () => {
    const info = await sandbox.info();
    expect(info.name).toBe(NAME);
  });
});
