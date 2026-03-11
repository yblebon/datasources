#!/usr/bin/env bun
import { resolve, dirname, join } from "path";
import { parseWorkflow } from "./src/parser";
import { WorkflowRunner } from "./src/runner";

// ─── CLI ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function usage() {
  console.log(`
  Usage:
    bun run index.ts <workflow.toml> [options]

  Options:
    --logs-dir <dir>   Directory for log files (default: {workdir}/logs)
    --workdir <dir>    Override the flow-level working directory
    --step <hook_id>   Run only this step (and its transitive dependencies)
    --fail-fast        Abort remaining tasks on first failure
    --timeout <secs>   Default step timeout in seconds (0 = no limit)
    --no-cache         Ignore all cache declarations and run every step
    --full             Ignore all skip: true fields and run every step
    --help             Show this help
  `);
  process.exit(0);
}

if (args.includes("--help") || args.length === 0) usage();

const tomlPath = resolve(args[0]);
const logsDir = args.includes("--logs-dir")
  ? resolve(args[args.indexOf("--logs-dir") + 1])
  : undefined;
const workdirOverride = args.includes("--workdir")
  ? resolve(args[args.indexOf("--workdir") + 1])
  : undefined;
const failFast = args.includes("--fail-fast");
const noCache  = args.includes("--no-cache");
const full     = args.includes("--full");
const step     = args.includes("--step")
  ? args[args.indexOf("--step") + 1]
  : undefined;
const defaultTimeout = args.includes("--timeout")
  ? parseInt(args[args.indexOf("--timeout") + 1], 10) || undefined
  : undefined;

// ─── Run ──────────────────────────────────────────────────────────────────────

try {
  const workflow = parseWorkflow(tomlPath);

  // CLI --workdir takes precedence over [flow] workdir in the TOML
  if (workdirOverride) workflow.flow.workdir = workdirOverride;

  const runner = new WorkflowRunner(workflow.flow, { logsDir, failFast, defaultTimeout, noCache, full, step });
  const results = await runner.run();

  const anyFailed = [...results.values()].some((r) => r.status === "failed");
  process.exit(anyFailed ? 1 : 0);
} catch (err: any) {
  console.error(`\n  ✖ Error: ${err.message ?? String(err)}\n`);
  process.exit(1);
}