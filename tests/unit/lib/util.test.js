import { describe, it, expect } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { parseUrl, formatTime, parseArgs } = require("../../../lib/util");

describe("parseUrl", () => {
  it("returns null for empty input", () => {
    expect(parseUrl("")).toBeNull();
    expect(parseUrl(null)).toBeNull();
    expect(parseUrl(undefined)).toBeNull();
  });

  it("parses a full URL", () => {
    const result = parseUrl("https://example.com:9090/path");
    expect(result).toEqual({
      href: "https://example.com:9090/path",
      hostname: "example.com",
      port: 9090,
    });
  });

  it("defaults to port 80 for http", () => {
    const result = parseUrl("http://localhost/foo");
    expect(result.port).toBe(80);
  });

  it("defaults to port 443 for https", () => {
    const result = parseUrl("https://localhost/foo");
    expect(result.port).toBe(443);
  });

  it("adds http:// when scheme is missing", () => {
    const result = parseUrl("localhost:8188");
    expect(result.hostname).toBe("localhost");
    expect(result.port).toBe(8188);
  });

  it("strips trailing slashes from href", () => {
    const result = parseUrl("http://example.com/");
    expect(result.href).toBe("http://example.com");
  });
});

describe("formatTime", () => {
  it("formats seconds only", () => {
    expect(formatTime(45)).toBe("45s");
  });

  it("formats minutes and seconds", () => {
    expect(formatTime(125)).toBe("2m 5s");
  });

  it("returns — for negative values", () => {
    expect(formatTime(-1)).toBe("—");
  });

  it("returns — for Infinity", () => {
    expect(formatTime(Infinity)).toBe("—");
  });

  it("handles zero", () => {
    expect(formatTime(0)).toBe("0s");
  });
});

describe("parseArgs", () => {
  it("splits simple arguments", () => {
    expect(parseArgs("--port 8188 --cpu")).toEqual(["--port", "8188", "--cpu"]);
  });

  it("handles double-quoted strings", () => {
    expect(parseArgs('--name "hello world" --flag')).toEqual([
      "--name",
      "hello world",
      "--flag",
    ]);
  });

  it("handles single-quoted strings", () => {
    expect(parseArgs("--path '/my dir/foo'")).toEqual(["--path", "/my dir/foo"]);
  });

  it("returns empty array for empty string", () => {
    expect(parseArgs("")).toEqual([]);
  });

  it("collapses multiple spaces", () => {
    expect(parseArgs("  --a   --b  ")).toEqual(["--a", "--b"]);
  });
});
