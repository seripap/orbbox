import { describe, test, expect, afterAll } from "bun:test";
import { orbstack, listOrbboxMachines, purgeOrbboxMachines } from "../../src/eve/backend.js";

const E2E = process.env["ORBBOX_E2E"] === "1";
const PREFIX = `orbboxtest${Date.now().toString(36)}`;

afterAll(async () => {
  if (!E2E) return;
  await purgeOrbboxMachines(PREFIX);
});

describe.if(E2E)("Eve backend (orbstack)", () => {
  test("prewarm + create + dispose lifecycle", async () => {
    const backend = orbstack({
      namePrefix: PREFIX,
      create: { distro: "alpine" },
      log: () => {},
    });

    const seedFiles = [{ path: "/workspace/seed.txt", content: "hello from prewarm" }];
    const tplKey = "tpl-abc";
    const prewarm = await backend.prewarm({
      templateKey: tplKey,
      seedFiles,
      runtimeContext: { appRoot: process.cwd() },
      log: () => {},
      bootstrap: async ({ use }) => {
        const ses = (await use()) as { run: (o: { command: string }) => Promise<{ exitCode: number }> };
        const r = await ses.run({ command: "echo bootstrap-ran > /workspace/bootstrap.txt" });
        expect(r.exitCode).toBe(0);
      },
    });
    expect(prewarm.reused).toBe(false);

    // Second prewarm with the same key should reuse.
    const reuse = await backend.prewarm({
      templateKey: tplKey,
      seedFiles,
      runtimeContext: { appRoot: process.cwd() },
    });
    expect(reuse.reused).toBe(true);

    const handle = await backend.create({
      templateKey: tplKey,
      sessionKey: "sess-1",
      runtimeContext: { appRoot: process.cwd() },
    });
    try {
      // Eve API: session.run / session.readTextFile / etc.
      const r = await handle.session.run({ command: "cat /workspace/seed.txt" });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("hello from prewarm");

      const bootstrap = await handle.session.readTextFile({ path: "/workspace/bootstrap.txt" });
      expect(bootstrap?.trim()).toBe("bootstrap-ran");

      // resolvePath sanity
      expect(handle.session.resolvePath("foo")).toBe("/workspace/foo");
      expect(handle.session.resolvePath("/abs")).toBe("/abs");

      // writeBinaryFile + readBinaryFile
      const bytes = new Uint8Array([1, 2, 3, 4]);
      await handle.session.writeBinaryFile({ path: "bin.dat", content: bytes });
      const got = await handle.session.readBinaryFile({ path: "bin.dat" });
      expect(got).not.toBeNull();
      expect(Array.from(got!)).toEqual([1, 2, 3, 4]);

      // spawn API
      const proc = await handle.session.spawn({ command: "echo streamed" });
      const out = await new Response(proc.stdout).text();
      const exit = await proc.wait();
      expect(out).toContain("streamed");
      expect(exit.exitCode).toBe(0);

      // captureState shape (Eve reconnect record)
      const state = await handle.captureState();
      expect(state.backendName).toBe("orbstack");
      expect(state.sessionKey).toBe("sess-1");
      expect(state.metadata["machine"]).toContain(PREFIX);
    } finally {
      await handle.dispose();
    }

    const survivors = await listOrbboxMachines(PREFIX);
    // template machine should still exist; session machine should be gone.
    expect(survivors.some((n) => n.includes("tpl"))).toBe(true);
    expect(survivors.some((n) => n.includes("sess-1"))).toBe(false);
  }, 240_000);

  test("readBinaryFile returns null for missing files", async () => {
    const backend = orbstack({
      namePrefix: PREFIX,
      create: { distro: "alpine" },
      useTemplates: false,
    });
    const handle = await backend.create({
      templateKey: null,
      sessionKey: "miss",
      runtimeContext: { appRoot: process.cwd() },
    });
    try {
      const got = await handle.session.readBinaryFile({ path: "/nope/here" });
      expect(got).toBeNull();
    } finally {
      await handle.dispose();
    }
  }, 180_000);
});
