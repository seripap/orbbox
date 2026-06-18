import { describe, test, expect, afterAll } from "bun:test";
import { flue, listFlueMachines, purgeFlueMachines, FileNotFoundError, OrbboxFlueSandboxApi } from "../../src/flue/adapter.js";
import { Sandbox } from "../../src/sandbox.js";

const E2E = process.env["ORBBOX_E2E"] === "1";
const PREFIX = `fluetest${Date.now().toString(36)}`;

afterAll(async () => {
  if (!E2E) return;
  await purgeFlueMachines(PREFIX);
});

describe.if(E2E)("Flue adapter (orbstack)", () => {
  test("createSessionEnv exposes the full SandboxApi surface", async () => {
    const factory = flue({
      namePrefix: PREFIX,
      create: { distro: "alpine" },
      bootstrap: async (sb) => {
        await sb.writeFile("seeded.txt", "from-template");
      },
    });

    const env = await factory.createSessionEnv({ id: "s1" });
    try {
      // Sanity: the template seed file was inherited via clone.
      const seeded = await env.api.readFile("seeded.txt");
      expect(seeded.trim()).toBe("from-template");

      // writeFile + readFile (text)
      await env.api.writeFile("hello.txt", "world");
      expect((await env.api.readFile("hello.txt")).trim()).toBe("world");

      // writeFile (bytes) + readFileBuffer
      await env.api.writeFile("bin.dat", new Uint8Array([0, 1, 2, 0xff]));
      const buf = await env.api.readFileBuffer("bin.dat");
      expect(Array.from(buf)).toEqual([0, 1, 2, 0xff]);

      // exists
      expect(await env.api.exists("hello.txt")).toBe(true);
      expect(await env.api.exists("nope.txt")).toBe(false);

      // mkdir + readdir
      await env.api.mkdir("nested/deep", { recursive: true });
      await env.api.writeFile("nested/deep/a.txt", "a");
      await env.api.writeFile("nested/deep/b.txt", "b");
      const entries = await env.api.readdir("nested/deep");
      expect(entries.sort()).toEqual(["a.txt", "b.txt"]);

      // stat (file)
      const sFile = await env.api.stat("hello.txt");
      expect(sFile.isFile).toBe(true);
      expect(sFile.isDirectory).toBe(false);
      expect(sFile.size).toBe(5);
      expect(sFile.mtime).toBeInstanceOf(Date);

      // stat (dir)
      const sDir = await env.api.stat("nested");
      expect(sDir.isDirectory).toBe(true);
      expect(sDir.isFile).toBe(false);

      // rm (recursive)
      await env.api.rm("nested", { recursive: true, force: true });
      expect(await env.api.exists("nested")).toBe(false);

      // exec: cwd + env + stdout/stderr/exitCode
      const r = await env.api.exec("echo $GREETING && pwd", {
        cwd: "/workspace",
        env: { GREETING: "hi" },
      });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("hi");
      expect(r.stdout).toContain("/workspace");

      // exec: non-zero exit is surfaced (not thrown)
      const fail = await env.api.exec("exit 17");
      expect(fail.exitCode).toBe(17);
    } finally {
      await env.dispose?.();
    }

    // Session machine cleaned up; template survives.
    const survivors = await listFlueMachines(PREFIX);
    expect(survivors.some((n) => n.includes("tpl"))).toBe(true);
    expect(survivors.some((n) => n.includes("s1"))).toBe(false);
  }, 300_000);

  test("readFile throws FileNotFoundError on missing path", async () => {
    const factory = flue({
      namePrefix: PREFIX,
      create: { distro: "alpine" },
      useTemplates: false,
    });
    const env = await factory.createSessionEnv({ id: "miss" });
    try {
      let threw: unknown;
      try {
        await env.api.readFile("/nope/here.txt");
      } catch (e) {
        threw = e;
      }
      expect(threw).toBeInstanceOf(FileNotFoundError);
      expect((threw as FileNotFoundError).code).toBe("ENOENT");

      // readFileBuffer mirrors the behavior.
      let bufErr: unknown;
      try {
        await env.api.readFileBuffer("/nope/bin");
      } catch (e) {
        bufErr = e;
      }
      expect(bufErr).toBeInstanceOf(FileNotFoundError);

      // stat on missing path throws too.
      let statErr: unknown;
      try {
        await env.api.stat("/nope/here");
      } catch (e) {
        statErr = e;
      }
      expect(statErr).toBeInstanceOf(FileNotFoundError);
    } finally {
      await env.dispose?.();
    }
  }, 180_000);

  test("exec honours AbortSignal mid-flight", async () => {
    const factory = flue({
      namePrefix: PREFIX,
      create: { distro: "alpine" },
      useTemplates: false,
    });
    const env = await factory.createSessionEnv({ id: "abort" });
    try {
      const ctrl = new AbortController();
      const started = Date.now();
      setTimeout(() => ctrl.abort(), 500);
      const result = await env.api.exec("sleep 30 && echo done", { signal: ctrl.signal }).catch((e) => e);
      const elapsed = Date.now() - started;
      // Either the promise rejected from throwIfAborted post-completion, or
      // it resolved with a non-zero exit because the process was killed.
      // Both are acceptable; what matters is we didn't wait 30s.
      expect(elapsed).toBeLessThan(10_000);
      if (result instanceof Error) {
        expect(ctrl.signal.aborted).toBe(true);
      } else {
        expect(result.exitCode).not.toBe(0);
      }
    } finally {
      await env.dispose?.();
    }
  }, 180_000);

  test("OrbboxFlueSandboxApi works against a directly-managed Sandbox", async () => {
    const sb = await Sandbox.create({ name: `${PREFIX}-direct`, distro: "alpine" });
    try {
      const api = new OrbboxFlueSandboxApi(sb);
      await api.writeFile("direct.txt", "shared");
      expect((await api.readFile("direct.txt")).trim()).toBe("shared");
      const s = await api.stat("direct.txt");
      expect(s.isFile).toBe(true);
      expect(s.size).toBe(6);
    } finally {
      await sb.destroy();
    }
  }, 180_000);
});
