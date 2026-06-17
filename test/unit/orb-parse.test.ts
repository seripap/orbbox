import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { parseListJson, ORB_BIN } from "../../src/orb.js";

/**
 * These tests don't mock orb — they shell out to the real binary and validate
 * we parse its actual output. If orb isn't installed, skip.
 */
const ORB_PRESENT = (() => {
  try {
    execSync(`${ORB_BIN} version`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe("parseListJson", () => {
  test("returns [] on empty string", () => {
    expect(parseListJson("")).toEqual([]);
  });
  test("returns [] on whitespace", () => {
    expect(parseListJson("   \n")).toEqual([]);
  });
  test("parses a real array", () => {
    const raw = JSON.stringify([{ name: "foo", state: "running" }]);
    expect(parseListJson(raw)).toEqual([{ name: "foo", state: "running" }]);
  });
  test("rejects non-array", () => {
    expect(() => parseListJson(JSON.stringify({ name: "foo" }))).toThrow();
  });
});

describe("parseListJson against real orbctl", () => {
  test.if(ORB_PRESENT)("orbctl list -f json output is parseable", () => {
    const out = execSync(`${ORB_BIN} list -f json`, { encoding: "utf8" });
    const machines = parseListJson(out);
    expect(Array.isArray(machines)).toBe(true);
    for (const m of machines) {
      expect(typeof m.name).toBe("string");
    }
  });
});
