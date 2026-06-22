import { describe, expect, test } from "bun:test";
import { parseCreateConfig, parseExecOptions, normalizeMount } from "../../src/core/schema.js";
import { ValidationError } from "../../src/core/errors.js";

describe("parseCreateConfig", () => {
  test("applies defaults", () => {
    const cfg = parseCreateConfig({});
    expect(cfg.distro).toBe("ubuntu");
    expect(cfg.driver).toBe("auto");
    expect(cfg.isolated).toBe(false);
    expect(cfg.isolateNetwork).toBe(false);
    expect(cfg.mounts).toEqual([]);
  });

  test("accepts driver and image overrides", () => {
    const cfg = parseCreateConfig({ driver: "apple", image: "ubuntu:24.04" });
    expect(cfg.driver).toBe("apple");
    expect(cfg.image).toBe("ubuntu:24.04");
  });

  test("rejects unknown driver", () => {
    expect(() => parseCreateConfig({ driver: "podman" as never })).toThrow(ValidationError);
  });

  test("accepts a real configuration", () => {
    const cfg = parseCreateConfig({
      name: "my-box",
      distro: "alpine",
      version: "3.22",
      arch: "arm64",
      memory: "2G",
      cpus: 2,
      disk: "20G",
      isolated: true,
      isolateNetwork: true,
      user: "agent",
      mounts: ["/tmp/host:/host", { source: "/etc/hosts", dest: "/mnt/hosts" }],
    });
    expect(cfg.name).toBe("my-box");
    expect(cfg.distro).toBe("alpine");
    expect(cfg.mounts).toHaveLength(2);
  });

  test("rejects isolateNetwork without isolated", () => {
    expect(() => parseCreateConfig({ isolateNetwork: true })).toThrow(ValidationError);
  });

  test("rejects mounts on non-isolated", () => {
    expect(() => parseCreateConfig({ mounts: ["/tmp"] })).toThrow(ValidationError);
  });

  test("rejects forwardSshAgent on non-isolated", () => {
    expect(() => parseCreateConfig({ forwardSshAgent: true })).toThrow(ValidationError);
  });

  test("rejects garbage size strings", () => {
    expect(() => parseCreateConfig({ memory: "lots" })).toThrow(ValidationError);
    expect(() => parseCreateConfig({ disk: "10 elephants" })).toThrow(ValidationError);
  });

  test("rejects unknown distro", () => {
    expect(() => parseCreateConfig({ distro: "windows" as never })).toThrow(ValidationError);
  });

  test("rejects bad machine name", () => {
    expect(() => parseCreateConfig({ name: "-bad" })).toThrow(ValidationError);
    expect(() => parseCreateConfig({ name: "has spaces" })).toThrow(ValidationError);
  });

  test("ValidationError carries machine-readable issues", () => {
    try {
      parseCreateConfig({ isolateNetwork: true });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError);
      const ve = e as ValidationError;
      expect(ve.issues.length).toBeGreaterThan(0);
      expect(ve.issues[0]).toContain("isolateNetwork");
    }
  });
});

describe("parseExecOptions", () => {
  test("defaults shell=false", () => {
    expect(parseExecOptions({}).shell).toBe(false);
  });
  test("accepts env, workdir, timeout", () => {
    const o = parseExecOptions({ workdir: "/tmp", env: { FOO: "bar" }, timeoutMs: 5000 });
    expect(o.workdir).toBe("/tmp");
    expect(o.env).toEqual({ FOO: "bar" });
    expect(o.timeoutMs).toBe(5000);
  });
  test("rejects negative timeout", () => {
    expect(() => parseExecOptions({ timeoutMs: -1 })).toThrow(ValidationError);
  });
});

describe("normalizeMount", () => {
  test("string passthrough", () => {
    expect(normalizeMount("/a")).toBe("/a");
    expect(normalizeMount("/a:/b")).toBe("/a:/b");
  });
  test("object with dest", () => {
    expect(normalizeMount({ source: "/a", dest: "/b" })).toBe("/a:/b");
  });
  test("object without dest", () => {
    expect(normalizeMount({ source: "/a" })).toBe("/a");
  });
});
