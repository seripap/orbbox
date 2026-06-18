import { describe, expect, test } from "bun:test";
import { parseStatLine, FileNotFoundError, SandboxOperationUnsupportedError } from "../../src/flue/adapter.js";

describe("parseStatLine", () => {
  test("parses a regular file", () => {
    const s = parseStatLine("42\t1700000000\tregular file");
    expect(s.isFile).toBe(true);
    expect(s.isDirectory).toBe(false);
    expect(s.size).toBe(42);
    expect(s.mtime?.getTime()).toBe(1700000000_000);
    expect(s.isSymbolicLink).toBeUndefined();
  });

  test("parses an empty regular file", () => {
    const s = parseStatLine("0\t1700000000\tregular empty file");
    expect(s.isFile).toBe(true);
    expect(s.isDirectory).toBe(false);
    expect(s.size).toBe(0);
  });

  test("parses a directory", () => {
    const s = parseStatLine("4096\t1700000000\tdirectory");
    expect(s.isFile).toBe(false);
    expect(s.isDirectory).toBe(true);
  });

  test("parses a symbolic link", () => {
    const s = parseStatLine("13\t1700000000\tsymbolic link");
    expect(s.isSymbolicLink).toBe(true);
    expect(s.isFile).toBe(false);
    expect(s.isDirectory).toBe(false);
  });

  test("omits fields when the underlying values are bogus", () => {
    const s = parseStatLine("\t\tcharacter special file");
    expect(s.size).toBeUndefined();
    expect(s.mtime).toBeUndefined();
    expect(s.isFile).toBe(false);
    expect(s.isDirectory).toBe(false);
  });
});

describe("error types", () => {
  test("FileNotFoundError carries ENOENT and a useful message", () => {
    const e = new FileNotFoundError("/workspace/missing.txt");
    expect(e.code).toBe("ENOENT");
    expect(e.message).toContain("/workspace/missing.txt");
    expect(e.name).toBe("FileNotFoundError");
  });

  test("SandboxOperationUnsupportedError carries the op name", () => {
    const e = new SandboxOperationUnsupportedError("readlink", "needs a firewall sidecar");
    expect(e.message).toContain("readlink");
    expect(e.message).toContain("needs a firewall sidecar");
  });
});
