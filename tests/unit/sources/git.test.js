import { describe, it, expect, vi } from "vitest";

vi.mock("electron", () => ({ net: { request: vi.fn() } }));
vi.mock("../../../lib/fetch", () => ({ fetchJSON: vi.fn() }));
vi.mock("../../../lib/actions", () => ({
  deleteAction: vi.fn(() => ({ id: "delete" })),
  untrackAction: vi.fn(() => ({ id: "untrack" })),
}));

const { createRequire } = await import("module");
const require = createRequire(import.meta.url);
const git = require("../../../sources/git");

describe("sources/git", () => {
  it("exports the expected source id", () => {
    expect(git.id).toBe("git");
  });

  it("buildInstallation extracts version from commit SHA", () => {
    const result = git.buildInstallation({
      commit: { value: "abc1234567890", label: "abc12345 — some message" },
      repo: { value: "https://github.com/Comfy-Org/ComfyUI" },
      branch: { value: "main" },
    });
    expect(result.version).toBe("abc12345");
    expect(result.repo).toBe("https://github.com/Comfy-Org/ComfyUI");
    expect(result.branch).toBe("main");
  });

  it("buildInstallation handles missing selections gracefully", () => {
    const result = git.buildInstallation({});
    expect(result.version).toBe("unknown");
    expect(result.repo).toContain("github.com");
    expect(result.branch).toBe("");
    expect(result.commit).toBe("");
  });

  it("getLaunchCommand always returns null", () => {
    expect(git.getLaunchCommand({})).toBeNull();
  });
});
