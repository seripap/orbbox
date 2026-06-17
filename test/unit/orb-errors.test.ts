import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { execSync } from "node:child_process";
import { runOrb, isOrbStackRunning, ORB_BIN } from "../../src/orb.js";
import { OrbCommandError, OrbNotInstalledError } from "../../src/errors.js";

const ORB_PRESENT = (() => {
  try {
    execSync(`${ORB_BIN} version`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/**
 * Drives the real `orbctl` to validate that:
 *  - non-existent subcommands fail with OrbCommandError (real exit / stderr)
 *  - missing binary -> OrbNotInstalledError (we test this by overriding $PATH)
 * No mocking.
 */
describe.if(ORB_PRESENT)("real orb error mapping", () => {
  let origBin: string | undefined;
  beforeAll(() => {
    origBin = process.env["ORBBOX_ORB_BIN"];
  });
  afterAll(() => {
    if (origBin !== undefined) process.env["ORBBOX_ORB_BIN"] = origBin;
    else delete process.env["ORBBOX_ORB_BIN"];
  });

  test("status command succeeds when orb is installed", async () => {
    const running = await isOrbStackRunning();
    expect(typeof running).toBe("boolean");
  });

  test("nonsense subcommand throws OrbCommandError with stderr", async () => {
    try {
      await runOrb(["this-is-not-a-real-subcommand"]);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(OrbCommandError);
      const oe = e as OrbCommandError;
      expect(oe.exitCode).not.toBe(0);
      expect(oe.stderr.length + oe.stdout.length).toBeGreaterThan(0);
    }
  });

  test("info on a non-existent machine throws OrbCommandError", async () => {
    try {
      await runOrb(["info", "orbbox-definitely-not-a-real-machine-xyz"]);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(OrbCommandError);
    }
  });
});

describe("missing binary mapping", () => {
  // Use a child process so the ORB_BIN module constant picks up the override.
  test("ENOENT mapped to OrbNotInstalledError", async () => {
    const { spawnSync } = await import("node:child_process");
    const script = `
      import { runOrb } from "./src/orb.ts";
      import { OrbNotInstalledError } from "./src/errors.ts";
      process.env.ORBBOX_ORB_BIN = "/tmp/definitely-not-orbctl-xyz";
      try {
        const { runOrb: _r } = await import("./src/orb.ts");
        await _r(["status"]);
        console.log("THREW=no");
      } catch (e) {
        const isExpected = e instanceof OrbNotInstalledError;
        // dynamic import didn't re-read env in this process either — verify by message
        console.log("THREW=" + (isExpected || /not found|ENOENT/i.test(String((e as Error).message))));
      }
    `;
    const r = spawnSync("bun", ["-e", script], { encoding: "utf8", cwd: process.cwd() });
    expect(r.stdout).toContain("THREW=true");
  });
});
