/**
 * PoC: Validate installations.json against the Zod schema.
 *
 * This is a standalone example showing how schema validation would work
 * when integrated into installations.js load(). It does NOT modify
 * any existing application code.
 *
 * Usage (after `npm install zod` and `npx tsx`):
 *   npx tsx schemas/validate-example.ts
 *
 * Or in plain Node with ts-node:
 *   npx ts-node schemas/validate-example.ts
 */
import * as fs from "fs";
import * as path from "path";
import { InstallationsArraySchema } from "./installation";
import { SettingsSchema } from "./settings";

// ── Resolve data paths (mirrors lib/paths.js logic) ─────────────────────────
const homeDir = process.env.HOME || process.env.USERPROFILE || "";
const dataDir =
  process.platform === "darwin"
    ? path.join(homeDir, "Library", "Application Support", "comfyui-launcher")
    : process.platform === "win32"
      ? path.join(process.env.APPDATA || homeDir, "comfyui-launcher")
      : path.join(process.env.XDG_DATA_HOME || path.join(homeDir, ".local", "share"), "comfyui-launcher");

const configDir =
  process.platform === "darwin"
    ? dataDir
    : process.platform === "win32"
      ? dataDir
      : path.join(process.env.XDG_CONFIG_HOME || path.join(homeDir, ".config"), "comfyui-launcher");

// ── Validate installations.json ─────────────────────────────────────────────
function validateInstallations() {
  const filePath = path.join(dataDir, "installations.json");
  console.log(`\n📂 Checking ${filePath}`);

  if (!fs.existsSync(filePath)) {
    console.log("   ⏭  File does not exist (no installations yet)");
    return;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (err) {
    console.error("   ❌ Failed to parse JSON:", err);
    return;
  }

  const result = InstallationsArraySchema.safeParse(raw);
  if (result.success) {
    console.log(`   ✅ Valid — ${result.data.length} installation(s)`);
    for (const inst of result.data) {
      console.log(`      • ${inst.id} — "${inst.name}" (${inst.sourceId}, status: ${inst.status ?? "pending"})`);
    }
  } else {
    console.error("   ❌ Validation failed:");
    for (const issue of result.error.issues) {
      console.error(`      • [${issue.path.join(".")}] ${issue.message}`);
    }
  }
}

// ── Validate settings.json ──────────────────────────────────────────────────
function validateSettings() {
  const filePath = path.join(configDir, "settings.json");
  console.log(`\n📂 Checking ${filePath}`);

  if (!fs.existsSync(filePath)) {
    console.log("   ⏭  File does not exist (using defaults)");
    return;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (err) {
    console.error("   ❌ Failed to parse JSON:", err);
    return;
  }

  const result = SettingsSchema.safeParse(raw);
  if (result.success) {
    console.log("   ✅ Valid");
    const keys = Object.keys(result.data);
    console.log(`      Keys: ${keys.join(", ")}`);
  } else {
    console.error("   ❌ Validation failed:");
    for (const issue of result.error.issues) {
      console.error(`      • [${issue.path.join(".")}] ${issue.message}`);
    }
  }
}

// ── Run ─────────────────────────────────────────────────────────────────────
console.log("🔍 ComfyUI Launcher — Zod Schema Validation PoC\n");
console.log("This validates existing data files against the proposed schemas.");
console.log("No data is modified.\n");

validateInstallations();
validateSettings();

console.log("\n✨ Done");
