import { describe, it, expect, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => "/mock" },
  net: { request: vi.fn() },
}));
vi.mock("../../../lib/fetch", () => ({ fetchJSON: vi.fn() }));
vi.mock("../../../lib/actions", () => ({
  deleteAction: vi.fn(() => ({ id: "delete" })),
  untrackAction: vi.fn(() => ({ id: "untrack" })),
}));
vi.mock("../../../lib/installer", () => ({
  downloadAndExtract: vi.fn(),
  downloadAndExtractMulti: vi.fn(),
}));
vi.mock("../../../lib/delete", () => ({ deleteDir: vi.fn() }));
vi.mock("../../../lib/i18n", () => ({ t: (key) => key }));

const { createRequire } = await import("module");
const require = createRequire(import.meta.url);
const standalone = require("../../../sources/standalone");

describe("sources/standalone", () => {
  it("exports the expected source id", () => {
    expect(standalone.id).toBe("standalone");
  });

  it("buildInstallation extracts fields from selections", () => {
    const result = standalone.buildInstallation({
      release: { value: "v0.4.0" },
      variant: {
        data: {
          variantId: "linux-nvidia-cu128",
          manifest: { comfyui_ref: "0.3.30", python_version: "3.12.9" },
          downloadUrl: "https://example.com/env.tar",
          downloadFiles: [{ url: "https://example.com/env.tar", filename: "env.tar", size: 100 }],
        },
      },
    });
    expect(result.version).toBe("0.3.30");
    expect(result.releaseTag).toBe("v0.4.0");
    expect(result.variant).toBe("linux-nvidia-cu128");
    expect(result.downloadUrl).toBe("https://example.com/env.tar");
    expect(result.pythonVersion).toBe("3.12.9");
  });

  it("buildInstallation handles empty selections", () => {
    const result = standalone.buildInstallation({});
    expect(result.version).toBe("unknown");
    expect(result.releaseTag).toBe("unknown");
    expect(result.variant).toBe("");
  });

  it("getDefaults returns expected launch args", () => {
    const defaults = standalone.getDefaults();
    expect(defaults.launchArgs).toBe("--enable-manager");
    expect(defaults.launchMode).toBe("window");
  });
});
