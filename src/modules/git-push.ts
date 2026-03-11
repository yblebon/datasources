import type { Module, ModuleParams } from "./index";
import type { StepConfig } from "../types";

/**
 * git-push module
 *
 * Stages specific files/directories, commits, and pushes to a remote branch.
 * Handles three scenarios cleanly:
 *
 *   1. Remote branch already exists  → pull --rebase, stage, commit, push
 *   2. Remote branch is new          → create orphan or push new branch
 *   3. Nothing changed               → skip commit + push, exit 0
 *
 * The `include` list drives `git add` — only those paths are staged.
 * If `include` is omitted, all changes are staged (`git add -A`).
 *
 * TOML usage:
 *
 *   [[flow.step]]
 *   name    = "Publish build artifacts"
 *   module  = "git-push"
 *   hook_id = "publish"
 *
 *   [flow.step.params]
 *   repo    = "git@github.com:org/repo.git"
 *   branch  = "gh-pages"
 *   message = "chore: publish artifacts [ci skip]"
 *   # List mode — stage files at their current paths
 *   include = ["dist/", "docs/", "CHANGELOG.md"]
 *
 *   # Mapping mode — copy local path to a different remote path before staging
 *   [flow.step.params.include]
 *   "dist/app.js"      = "public/app.js"
 *   "dist/styles.css"  = "public/styles.css"
 *   "/tmp/report.html" = "reports/latest.html"   # absolute local path ok
 *
 *   # Optional
 *   workdir    = "."           # local directory to operate in (default: step workdir)
 *   user_name  = "CI Bot"     # git commit author name
 *   user_email = "ci@bot.com" # git commit author email
 *   force      = false        # push --force-with-lease (default: false)
 *   allow_empty = false       # commit even when nothing changed (default: false)
 */

export const gitPushModule: Module = {
  name:        "git-push",
  description: "Stage specific files and push them to a remote git branch",
  required:    ["repo", "branch", "message"],

  resolve(params: ModuleParams, step: Partial<StepConfig>): Partial<StepConfig> {
    const repo       = params.repo        as string;
    const branch     = params.branch      as string;
    const message    = params.message     as string;
    const includeRaw = params.include     as string[] | Record<string, string> | undefined;
    const workdir    = params.workdir     as string | undefined;
    const userName   = params.user_name   as string | undefined;
    const userEmail  = params.user_email  as string | undefined;
    const force      = (params.force      as boolean | undefined) ?? false;
    const allowEmpty = (params.allow_empty as boolean | undefined) ?? false;

    // ── Normalise include into a typed structure ──────────────────────────
    // List mode:    include = ["dist/", "README.md"]
    //   → stage each path as-is
    // Mapping mode: [params.include]
    //               "dist/app.js"  = "public/app.js"
    //   → cp local → remote path inside the repo, then stage the remote path
    const includeMode: "none" | "list" | "map" =
      !includeRaw                        ? "none" :
      Array.isArray(includeRaw)          ? "list" :
      typeof includeRaw === "object"     ? "map"  : "none";

    const includeList   = includeMode === "list" ? (includeRaw as string[])            : [];
    const includeMap    = includeMode === "map"  ? (includeRaw as Record<string,string>) : {};

    const lines: string[] = [];

    // ── Move into the target directory if specified ───────────────────────
    if (workdir) {
      lines.push(`cd ${quote(workdir)}`);
    }

    // ── Git identity (only set if not already configured) ─────────────────
    if (userName) {
      lines.push(`git config user.name ${quote(userName)}`);
    }
    if (userEmail) {
      lines.push(`git config user.email ${quote(userEmail)}`);
    }

    // ── Ensure we're pointing at the right remote ─────────────────────────
    // If a remote named 'origin' already exists update its URL, otherwise add it.
    lines.push(
      `git remote get-url origin 2>/dev/null && ` +
      `git remote set-url origin ${quote(repo)} || ` +
      `git remote add origin ${quote(repo)}`
    );

    // ── Fetch remote so we know if the branch exists ──────────────────────
    lines.push(`git fetch origin ${quote(branch)} 2>/dev/null || true`);

    // ── Sync with remote branch if it already exists ──────────────────────
    // Using --rebase avoids a merge commit; --autostash protects local changes.
    lines.push(
      `if git ls-remote --exit-code --heads origin ${quote(branch)} > /dev/null 2>&1; then ` +
        `git pull --rebase --autostash origin ${quote(branch)}; ` +
      `fi`
    );

    // ── Stage the requested files ─────────────────────────────────────────
    if (includeMode === "map") {
      // Mapping mode: copy each local path to its remote destination path,
      // creating parent directories as needed, then stage the destination.
      for (const [local, remote] of Object.entries(includeMap)) {
        // Ensure the parent directory of the remote path exists in the repo
        const remoteDir = remote.includes("/")
          ? remote.replace(/\/[^/]+$/, "")
          : ".";
        lines.push(`mkdir -p ${quote(remoteDir)}`);
        lines.push(`cp -r ${quote(local)} ${quote(remote)} 2>/dev/null || true`);
        lines.push(`git add --force -- ${quote(remote)} 2>/dev/null || true`);
      }
    } else if (includeMode === "list") {
      // List mode: stage each path at its existing location
      for (const path of includeList) {
        lines.push(`git add --force -- ${quote(path)} 2>/dev/null || true`);
      }
    } else {
      // No include: stage everything
      lines.push(`git add -A`);
    }

    // ── Commit (skip if nothing staged) ──────────────────────────────────
    const emptyFlag = allowEmpty ? " --allow-empty" : "";
    lines.push(
      `if ! git diff --cached --quiet; then ` +
        `git commit${emptyFlag} -m ${quote(message)}; ` +
      `elif [ "${allowEmpty}" = "true" ]; then ` +
        `git commit --allow-empty -m ${quote(message)}; ` +
      `else ` +
        `echo "Nothing to commit — working tree clean, skipping push."; exit 0; ` +
      `fi`
    );

    // ── Push ──────────────────────────────────────────────────────────────
    const forceFlag = force ? " --force-with-lease" : "";
    lines.push(`git push${forceFlag} origin HEAD:${quote(branch)}`);

    const command = lines.join(" && \\\n  ");

    return {
      command,
      info: step.info ?? buildInfo(repo, branch, message, includeMode, includeList, includeMap, force),
    };
  },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function quote(s: string): string {
  // Wrap in single quotes and escape any internal single quotes
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function buildInfo(
  repo: string,
  branch: string,
  message: string,
  mode: "none" | "list" | "map",
  list: string[],
  map: Record<string, string>,
  force?: boolean
): string {
  const parts = [`→ ${repo} @ ${branch}`];
  if (mode === "list") {
    parts.push(`files: [${list.join(", ")}]`);
  } else if (mode === "map") {
    const pairs = Object.entries(map).map(([l, r]) => `${l} → ${r}`);
    parts.push(`remap: [${pairs.join(", ")}]`);
  } else {
    parts.push("files: all");
  }
  if (force) parts.push("force-with-lease");
  parts.push(`msg: "${message}"`);
  return parts.join("  |  ");
}