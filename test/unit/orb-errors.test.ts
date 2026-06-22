import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { runCli } from "../../src/core/process.js";
import { isOrbStackRunning, ORB_BIN } from "../../src/drivers/orbstack/index.js";
import { CommandError, DriverNotInstalledError } from "../../src/core/errors.js";

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
 *  - non-existent subcommands fail with CommandError (real exit / stderr)
 *  - missing binary -> DriverNotInstalledError
 * No mocking.
 */
describe.if(ORB_PRESENT)("real orb error mapping", () => {
  test("status command succeeds when orb is installed", async () => {
    const running = await isOrbStackRunning();
    expect(typeof running).toBe("boolean");
  });

  test("nonsense subcommand throws CommandError with stderr", async () => {
    try {
      await runCli(ORB_BIN, ["this-is-not-a-real-subcommand"]);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(CommandError);
      const oe = e as CommandError;
      expect(oe.exitCode).not.toBe(0);
      expect(oe.stderr.length + oe.stdout.length).toBeGreaterThan(0);
    }
  });

  test("info on a non-existent machine throws CommandError", async () => {
    try {
      await runCli(ORB_BIN, ["info", "spawnbox-definitely-not-a-real-machine-xyz"]);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(CommandError);
    }
  });
});

describe("missing binary mapping", () => {
  test("ENOENT mapped to DriverNotInstalledError", async () => {
    try {
      await runCli("/tmp/definitely-not-a-real-cli-xyz", ["status"]);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(DriverNotInstalledError);
    }
  });
});
