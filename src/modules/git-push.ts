import type { Module, ModuleParams } from "./index";
import type { StepConfig } from "../types";

/**
 * git-push module
 *
 * Stages specific files/directories, commits, and pushes to a remote branch.
 *
 * `include` accepts two forms:
 *
 *   # Array — stage each path as-is
 *   include = ["dist/", "docs/", "CHANGELOG.md"]
 *
 *   # Mapping — copy local → remote path, then stage the remote path
 *   [flow.step.params.include]
 *   "dist/app.js"      = "public/app.js"
 *   "build/styles.css" = "assets/styles.css"
 *   "reports/latest"   = "docs/report"
 *
 * When omitted, all changes are staged (`git add -A`).
 *
 * Other params:
 *   repo        — remote URL (required)
 *   branch      — remote branch (required)
 *   message     — commit message (required)
 *   workdir     — local directory to operate in (default: step workdir)
 *   user_name   — git commit author name
 *   user_email  — git commit author email
 *   force       — push --force-with-lease (default: false)
 *   allow_empty — commit even when nothing changed (default: false)
 */

export const gitPushModule: Module = {
  name:        "git-push",
  description: "Stage specific files and push them to a remote git branch",
  required:    ["repo", "branch", "message"],

  resolve(params: ModuleParams, step: Partial<StepConfig>): Partial<StepConfig> {
    const repo       = params.repo        as string;
    const branch     = params.branch      as string;
    const message    = params.message     as string;
    const include    = params.include;
    const workdir    = params.workdir     as string | undefined;
    const userName   = params.user_name   as string | undefined;
    const userEmail  = params.user_email  as string | undefined;
    const force      = (params.force      as boolean | undefined) ?? false;
    const allowEmpty = (params.allow_empty as boolean | undefined) ?? false;

    // ── Detect include form ───────────────────────────────────────────────
    const includeMap  = isMapping(include) ? include as Record<string, string> : null;
    const includeList = Array.isArray(include) ? include as string[] : null;

    if (include !== undefined && !includeMap && !includeList) {
      throw new Error(
        `git-push: 'include' must be a list of paths or a {local = "remote"} mapping`
      );
    }

    const lines: string[] = [];

    // Capture the original working directory upfront so local paths in the
    // mapping form always resolve from the step's cwd — even after a cd.
    lines.push(`_WF_ORIGIN=$(pwd)`);

    // ── Move into the target directory if specified ───────────────────────
    if (workdir) {
      lines.push(`cd ${q(workdir)}`);
    }

    // ── Git identity ──────────────────────────────────────────────────────
    if (userName)  lines.push(`git config user.name ${q(userName)}`);
    if (userEmail) lines.push(`git config user.email ${q(userEmail)}`);

    // ── Ensure remote is set ──────────────────────────────────────────────
    lines.push(
      `git remote get-url origin 2>/dev/null && ` +
      `git remote set-url origin ${q(repo)} || ` +
      `git remote add origin ${q(repo)}`
    );

    // ── Fetch + rebase if branch already exists ───────────────────────────
    lines.push(`git fetch origin ${q(branch)} 2>/dev/null || true`);
    lines.push(
      `if git ls-remote --exit-code --heads origin ${q(branch)} > /dev/null 2>&1; then ` +
        `git pull --rebase --autostash origin ${q(branch)}; ` +
      `fi`
    );

    // ── Copy local → remote paths (mapping form) ──────────────────────────
    if (includeMap) {
      for (const [local, remote] of Object.entries(includeMap)) {
        // Create parent directory of the remote path if needed, then copy.
        const remoteDir = remote.includes("/")
          ? remote.substring(0, remote.lastIndexOf("/"))
          : null;
        if (remoteDir) {
          lines.push(`mkdir -p ${q(remoteDir)}`);
        }
        // Prefix local with $_WF_ORIGIN so the source always resolves from
        // the step's original cwd, not from inside params.workdir after cd.
        // Strip any nested .git directories so git doesn't treat the copy
        // as a submodule when staging.
        lines.push(`cp -r "$_WF_ORIGIN/${local}" ${q(remote)}`);
        lines.push(`find ${q(remote)} -name '.git' -type d -exec rm -rf {} + 2>/dev/null || true`);
      }
    }

    // ── Stage ─────────────────────────────────────────────────────────────
    if (includeMap) {
      // Stage only the remote (destination) paths
      for (const remote of Object.values(includeMap)) {
        lines.push(`git add --force -- ${q(remote)} 2>/dev/null || true`);
      }
    } else if (includeList?.length) {
      for (const path of includeList) {
        lines.push(`git add --force -- ${q(path)} 2>/dev/null || true`);
      }
    } else {
      lines.push(`git add -A`);
    }

    // ── Commit ────────────────────────────────────────────────────────────
    const emptyFlag = allowEmpty ? " --allow-empty" : "";
    lines.push(
      `if ! git diff --cached --quiet; then ` +
        `git commit${emptyFlag} -m ${q(message)}; ` +
      `elif [ "${allowEmpty}" = "true" ]; then ` +
        `git commit --allow-empty -m ${q(message)}; ` +
      `else ` +
        `echo "Nothing to commit — working tree clean, skipping push."; exit 0; ` +
      `fi`
    );

    // ── Push ──────────────────────────────────────────────────────────────
    const forceFlag = force ? " --force-with-lease" : "";
    lines.push(`git push${forceFlag} origin HEAD:${q(branch)}`);

    const command = lines.join(" && \\\n  ");

    return {
      command,
      info: step.info ?? buildInfo(repo, branch, message, include, force),
    };
  },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Single-quote a shell argument, escaping internal single quotes */
function q(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function isMapping(v: unknown): v is Record<string, string> {
  return (
    v !== null &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    Object.values(v as object).every((x) => typeof x === "string")
  );
}

function buildInfo(
  repo: string,
  branch: string,
  message: string,
  include: unknown,
  force?: boolean
): string {
  const parts = [`→ ${repo} @ ${branch}`];

  if (isMapping(include)) {
    const pairs = Object.entries(include as Record<string, string>)
      .map(([l, r]) => `${l} → ${r}`)
      .join(", ");
    parts.push(`map: [${pairs}]`);
  } else if (Array.isArray(include) && include.length) {
    parts.push(`files: [${(include as string[]).join(", ")}]`);
  } else {
    parts.push("files: all");
  }

  if (force) parts.push("force-with-lease");
  parts.push(`msg: "${message}"`);
  return parts.join("  |  ");
}