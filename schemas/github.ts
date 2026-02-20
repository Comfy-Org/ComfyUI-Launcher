/**
 * Zod schemas for external API responses.
 *
 * These validate the subset of fields actually used by the codebase,
 * with .passthrough() to tolerate additional fields from the APIs.
 *
 * Derived from:
 *   - sources/git.js       getFieldOptions()  — lines 117–150
 *   - sources/portable.js  getFieldOptions()  — lines 379–406
 *   - sources/standalone.js getFieldOptions() — lines 474–523
 */
import { z } from "zod";

// ── GitHub Release Asset ────────────────────────────────────────────────────
export const GitHubAssetSchema = z
  .object({
    name: z.string(),
    size: z.number().nonnegative(),
    browser_download_url: z.string().url(),
  })
  .passthrough();

export type GitHubAsset = z.infer<typeof GitHubAssetSchema>;

// ── GitHub Release ──────────────────────────────────────────────────────────
// Used by portable.js:381–388 and standalone.js:477–489
export const GitHubReleaseSchema = z
  .object({
    id: z.number(),
    tag_name: z.string(),
    name: z.string().nullable().optional(),
    draft: z.boolean(),
    prerelease: z.boolean(),
    body: z.string().nullable().optional(),
    html_url: z.string().url(),
    published_at: z.string().nullable().optional(),
    assets: z.array(GitHubAssetSchema),
  })
  .passthrough();

export type GitHubRelease = z.infer<typeof GitHubReleaseSchema>;

// ── GitHub Branch ───────────────────────────────────────────────────────────
// Used by git.js:123 — branches endpoint
export const GitHubBranchSchema = z
  .object({
    name: z.string(),
  })
  .passthrough();

export type GitHubBranch = z.infer<typeof GitHubBranchSchema>;

// ── GitHub Commit ───────────────────────────────────────────────────────────
// Used by git.js:140–146 — commits endpoint
export const GitHubCommitSchema = z
  .object({
    sha: z.string(),
    commit: z.object({
      message: z.string(),
      committer: z
        .object({
          date: z.string().optional(),
        })
        .optional(),
    }),
    html_url: z.string().url().optional(),
  })
  .passthrough();

export type GitHubCommit = z.infer<typeof GitHubCommitSchema>;

// ── GitHub Repo Info ────────────────────────────────────────────────────────
// Used by git.js:122 — repo info endpoint
export const GitHubRepoSchema = z
  .object({
    default_branch: z.string(),
  })
  .passthrough();

export type GitHubRepo = z.infer<typeof GitHubRepoSchema>;

// ── GitHub Compare ──────────────────────────────────────────────────────────
// Used by portable.js:42–43 — compare endpoint
export const GitHubCompareSchema = z
  .object({
    ahead_by: z.number(),
  })
  .passthrough();

export type GitHubCompare = z.infer<typeof GitHubCompareSchema>;

// ── Standalone CDN Manifest ─────────────────────────────────────────────────
// Used by standalone.js:500–520 — manifests.json from release assets
export const StandaloneManifestSchema = z
  .object({
    id: z.string(), // e.g. "win-nvidia-cu128"
    comfyui_ref: z.string().optional(),
    python_version: z.string().optional(),
    files: z.array(z.string()).optional(),
  })
  .passthrough();

export type StandaloneManifest = z.infer<typeof StandaloneManifestSchema>;

export const StandaloneManifestsArraySchema = z.array(StandaloneManifestSchema);
