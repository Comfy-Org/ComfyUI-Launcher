import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "path";
import fs from "fs";
import os from "os";

const tmpDir = path.join(os.tmpdir(), `launcher-test-${Date.now()}`);

// On Linux, lib/paths.js uses XDG env vars instead of app.getPath("userData").
// Point all XDG dirs to tmpDir so installations.json lands in our test directory.
process.env.XDG_DATA_HOME = tmpDir;
process.env.XDG_CONFIG_HOME = tmpDir;
process.env.XDG_CACHE_HOME = tmpDir;
process.env.XDG_STATE_HOME = tmpDir;

// Vitest cannot intercept CJS require() calls. Override Node's Module._load
// to provide a fake "electron" module so that lib/paths.js can resolve.
vi.hoisted(async () => {
  const { Module } = await import("module");
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "electron") {
      return {
        app: {
          getPath: (name) => {
            if (name === "home") return os.homedir();
            return tmpDir;
          },
        },
        net: { request: () => {} },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
});

const { createRequire } = await import("module");
const require = createRequire(import.meta.url);
const installations = require("../../installations.js");

describe("installations", () => {
  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
    // On Linux: dataDir() = XDG_DATA_HOME/comfyui-launcher
    // On other platforms: dataDir() = app.getPath("userData") = tmpDir
    const dataDir = path.join(tmpDir, "comfyui-launcher");
    fs.mkdirSync(dataDir, { recursive: true });
    const dataPath = path.join(dataDir, "installations.json");
    if (fs.existsSync(dataPath)) fs.unlinkSync(dataPath);
    // Also clean non-Linux path
    const altPath = path.join(tmpDir, "installations.json");
    if (fs.existsSync(altPath)) fs.unlinkSync(altPath);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("list returns empty array when no file exists", async () => {
    const result = await installations.list();
    expect(result).toEqual([]);
  });

  it("add creates an installation with generated id and timestamp", async () => {
    const entry = await installations.add({ name: "Test Install", source: "standalone" });
    expect(entry.id).toMatch(/^inst-\d+$/);
    expect(entry.createdAt).toBeTruthy();
    expect(entry.name).toBe("Test Install");
    expect(entry.source).toBe("standalone");
  });

  it("list returns added installations (newest first)", async () => {
    await installations.add({ name: "First" });
    await installations.add({ name: "Second" });
    const list = await installations.list();
    expect(list).toHaveLength(2);
    expect(list[0].name).toBe("Second");
    expect(list[1].name).toBe("First");
  });

  it("get finds an installation by id", async () => {
    const entry = await installations.add({ name: "Findable" });
    const found = await installations.get(entry.id);
    expect(found).not.toBeNull();
    expect(found.name).toBe("Findable");
  });

  it("get returns null for unknown id", async () => {
    const found = await installations.get("inst-nonexistent");
    expect(found).toBeNull();
  });

  it("update merges data into an existing installation", async () => {
    const entry = await installations.add({ name: "Original", version: "1.0" });
    const updated = await installations.update(entry.id, { version: "2.0" });
    expect(updated.version).toBe("2.0");
    expect(updated.name).toBe("Original");
  });

  it("update returns null for unknown id", async () => {
    const result = await installations.update("inst-nonexistent", { name: "X" });
    expect(result).toBeNull();
  });

  it("remove deletes an installation", async () => {
    const entry = await installations.add({ name: "ToDelete" });
    await installations.remove(entry.id);
    const list = await installations.list();
    expect(list).toHaveLength(0);
  });

  it("reorder changes the order of installations", async () => {
    const a = await installations.add({ name: "A" });
    await new Promise((r) => setTimeout(r, 2));
    const b = await installations.add({ name: "B" });
    await new Promise((r) => setTimeout(r, 2));
    const c = await installations.add({ name: "C" });
    await installations.reorder([a.id, c.id, b.id]);
    const list = await installations.list();
    expect(list.map((i) => i.name)).toEqual(["A", "C", "B"]);
  });

  it("reorder appends missing installations at the end", async () => {
    const a = await installations.add({ name: "A" });
    await new Promise((r) => setTimeout(r, 2));
    const b = await installations.add({ name: "B" });
    await installations.reorder([a.id]);
    const list = await installations.list();
    expect(list[0].name).toBe("A");
    expect(list[1].name).toBe("B");
  });
});
