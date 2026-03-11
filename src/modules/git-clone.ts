import type { Module, ModuleParams } from "./index";
import type { StepConfig } from "../types";

/**
 * git-clone module
 *
 * Clones a git repository into a subdirectory of the step's workdir.
 * When `include` is provided, uses sparse checkout so only the listed
 * paths are materialised on disk — ideal for large monorepos.
 *
 * TOML usage:
 *
 *   [[flow.step]]
 *   name   = "Clone tools"
 *   module = "git-clone"
 *   hook_id = "clone-tools"
 *   cache   = ["tools"]          # auto-skip if dir already present
 *
 *   [flow.step.params]
 *   repo    = "git@github.com:org/tools.git"
 *   branch  = "main"
 *   dir     = "tools"            # optional, defaults to repo name
 *   depth   = 1                  # optional shallow clone depth (default: full)
 *   include = ["scripts/", "config/", "README.md"]   # optional sparse paths
 */

export const gitCloneModule: Module = {
  name:        "git-clone",
  description: "Clone a git repository, optionally using sparse checkout",
  required:    ["repo", "branch"],

  resolve(params: ModuleParams, step: Partial<StepConfig>): Partial<StepConfig> {
    const repo   = params.repo   as string;
    const branch = params.branch as string;
    const depth  = params.depth  as number | undefined;
    const include = params.include as string[] | undefined;

    // Derive target directory from repo name if not given
    const dir = (params.dir as string | undefined)
      ?? repo.split("/").pop()!.replace(/\.git$/, "");

    const lines: string[] = [];

    if (include?.length) {
      // ── Sparse checkout ─────────────────────────────────────────────────
      // 1. Clone with --filter=blob:none --no-checkout so we get the tree
      //    metadata without downloading any blobs yet.
      // 2. Init sparse-checkout in cone mode (fastest pattern matching).
      // 3. Set the desired paths — git will fetch only those blobs.
      // 4. Checkout the target branch.
      const depthFlag = depth ? `--depth ${depth} ` : "";
      lines.push(
        `git clone --filter=blob:none --no-checkout ${depthFlag}` +
        `--branch ${branch} ${repo} ${dir}`,
        `cd ${dir}`,
        `git sparse-checkout init --cone`,
        `git sparse-checkout set ${include.map((p) => quote(p)).join(" ")}`,
        `git checkout ${branch}`,
      );
    } else {
      // ── Full clone ───────────────────────────────────────────────────────
      const depthFlag = depth ? `--depth ${depth} ` : "";
      lines.push(
        `git clone ${depthFlag}--branch ${branch} ${repo} ${dir}`,
      );
    }

    const command = lines.join(" && \\\n  ");

    // Auto-set cache to the cloned directory so the step is skipped on
    // subsequent runs if the directory is already present and non-empty.
    const cache = (step.cache && step.cache.length > 0)
      ? step.cache
      : [dir];

    return {
      command,
      cache,
      // Provide a sensible info string if the step didn't define one
      info: step.info ?? buildInfo(repo, branch, dir, include, depth),
    };
  },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function quote(s: string): string {
  return s.includes(" ") ? `"${s}"` : s;
}

function buildInfo(
  repo: string,
  branch: string,
  dir: string,
  include?: string[],
  depth?: number
): string {
  const parts = [`${repo} → ${dir} @ ${branch}`];
  if (depth)   parts.push(`depth=${depth}`);
  if (include?.length) parts.push(`sparse: [${include.join(", ")}]`);
  return parts.join("  |  ");
}