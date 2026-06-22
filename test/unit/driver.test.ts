import { describe, expect, test } from "bun:test";
import { resolveDriver, registerDriver, listDriverNames } from "../../src/core/registry.js";
import { OrbStackDriver } from "../../src/drivers/orbstack/index.js";
import { AppleDriver, parseContainerList, resolveImage } from "../../src/drivers/apple/index.js";
import { parseCreateConfig } from "../../src/core/schema.js";
import { DriverNotFoundError, DriverUnsupportedError } from "../../src/core/errors.js";

describe("registry", () => {
  test("resolves built-in drivers by name", async () => {
    expect((await resolveDriver("orbstack")).name).toBe("orbstack");
    expect((await resolveDriver("apple")).name).toBe("apple");
  });

  test("unknown driver name throws DriverNotFoundError", async () => {
    await expect(resolveDriver("podman")).rejects.toBeInstanceOf(DriverNotFoundError);
  });

  test("registerDriver adds a custom driver", async () => {
    const fake = new OrbStackDriver();
    registerDriver("fake-test-driver", () => fake);
    expect(listDriverNames()).toContain("fake-test-driver");
    expect(await resolveDriver("fake-test-driver")).toBe(fake);
  });
});

describe("capabilities", () => {
  test("orbstack: distro source, clone, no image", () => {
    const caps = new OrbStackDriver().capabilities;
    expect(caps.distroSource).toBe(true);
    expect(caps.clone).toBe(true);
    expect(caps.imageSource).toBe(false);
  });

  test("apple: image source, no clone", () => {
    const caps = new AppleDriver().capabilities;
    expect(caps.imageSource).toBe(true);
    expect(caps.clone).toBe(false);
  });

  test("apple.clone throws DriverUnsupportedError", async () => {
    await expect(new AppleDriver().clone("a", "b")).rejects.toBeInstanceOf(DriverUnsupportedError);
  });
});

describe("apple image resolution", () => {
  test("explicit image wins", () => {
    const cfg = parseCreateConfig({ image: "ghcr.io/acme/box:1" });
    expect(resolveImage(cfg)).toBe("ghcr.io/acme/box:1");
  });

  test("distro maps to a library image with version tag", () => {
    expect(resolveImage(parseCreateConfig({ distro: "ubuntu" }))).toBe("ubuntu:latest");
    expect(resolveImage(parseCreateConfig({ distro: "alpine", version: "3.22" }))).toBe("alpine:3.22");
    expect(resolveImage(parseCreateConfig({ distro: "arch" }))).toBe("archlinux:latest");
  });
});

describe("parseContainerList", () => {
  test("returns [] on empty", () => {
    expect(parseContainerList("")).toEqual([]);
  });

  test("parses a JSON array and normalizes name/id/state", () => {
    const rows = parseContainerList(
      JSON.stringify([{ ID: "abc123", Names: "/my-box", Status: "running" }]),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe("abc123");
    expect(rows[0]!.name).toBe("my-box");
    expect(rows[0]!.state).toBe("running");
  });

  test("parses NDJSON", () => {
    const rows = parseContainerList('{"id":"a","name":"one","state":"running"}\n{"id":"b","name":"two","state":"stopped"}');
    expect(rows.map((r) => r.name)).toEqual(["one", "two"]);
  });
});
