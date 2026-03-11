import { mkdir, writeFile } from "fs/promises";
import { createWriteStream, existsSync } from "fs";
import type { WriteStream } from "fs";
import { join, resolve, isAbsolute } from "path";
import type {
  StepConfig,
  FlowConfig,
  TaskResult,
  TaskStatus,
  RunnerOptions,
  FlowEnv,
} from "./types";
import { Logger } from "./logger";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function safeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_\-]/g, "_").toLowerCase();
}

/** e.g. 2026-03-11_14-05-32 — safe for directory names on all OSes */
function runTimestamp(): string {
  return new Date()
    .toISOString()
    .replace("T", "_")
    .replace(/:/g, "-")
    .slice(0, 19);
}

// ─── SSH env variables that must always be forwarded ─────────────────────────
const SSH_ENV_KEYS = [
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  "SSH_CONNECTION",
  "SSH_CLIENT",
  "HOME",
];

function buildEnv(
  flowEnv: FlowEnv = {},
  stepEnv: FlowEnv = {},
  binPath?: string
): Record<string, string> {
  const base = { ...process.env } as Record<string, string>;

  for (const key of SSH_ENV_KEYS) {
    if (process.env[key] && !base[key]) base[key] = process.env[key]!;
  }

  const merged = { ...base, ...flowEnv, ...stepEnv };
  merged["GIT_TERMINAL_PROMPT"] ??= "0";
  merged["GIT_SSH_COMMAND"] ??=
    "ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes";

  if (binPath) {
    merged["PATH"] = `${resolve(binPath)}:${merged["PATH"] ?? ""}`;
  }
  return merged;
}

function isoNow(): string {
  return new Date().toISOString();
}

// Lightweight ANSI constants for use inside log files (plain text stays readable)
const C_DIM   = "\x1b[2m";
const C_RESET = "\x1b[0m";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

// ─── Cache check ──────────────────────────────────────────────────────────────
// Returns resolved absolute paths on a full valid hit, or null if any path is
// missing or is an empty directory (which indicates a partial/failed previous run).

function isDirNonEmpty(absPath: string): boolean {
  try {
    // readdirSync returns [] for empty dirs; any entry means non-empty
    return require("fs").readdirSync(absPath).length > 0;
  } catch {
    return false;
  }
}

function checkCache(paths: string[], workdir: string): string[] | null {
  const resolved: string[] = [];

  for (const p of paths) {
    const abs = isAbsolute(p) ? p : join(workdir, p);

    if (!existsSync(abs)) return null;   // path absent → cache miss

    // For directories, treat empty as a cache miss — git creates the dir
    // before cloning, so an empty (or near-empty) dir means a failed prior run
    const stat = require("fs").statSync(abs);
    if (stat.isDirectory() && !isDirNonEmpty(abs)) return null;

    resolved.push(abs);
  }

  return resolved;   // all paths present and non-empty → cache hit
}

// ─── Auto-cache marker ────────────────────────────────────────────────────────
// On success, a JSON marker is written to {workdir}/.workflow-cache/{hook_id}.done
// containing a hash of the command + runner. On next run, if the marker exists
// and the hash still matches, the step is skipped automatically.

interface MarkerData {
  hookId: string;
  commandHash: string;
  runner: string;
  succeededAt: string;
}

function commandHash(command: string, runner: string): string {
  // Simple but sufficient: djb2-style hash over the combined string
  const input = `${runner}::${command}`;
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h) ^ input.charCodeAt(i);
    h = h >>> 0; // keep 32-bit unsigned
  }
  return h.toString(16).padStart(8, "0");
}

function markerPath(workdir: string, hookId: string): string {
  return join(workdir, ".workflow-cache", `${hookId}.done`);
}

async function writeMarker(workdir: string, hookId: string, command: string, runner: string) {
  const dir  = join(workdir, ".workflow-cache");
  await mkdir(dir, { recursive: true });
  const data: MarkerData = {
    hookId,
    commandHash: commandHash(command, runner),
    runner,
    succeededAt: new Date().toISOString(),
  };
  await writeFile(markerPath(workdir, hookId), JSON.stringify(data, null, 2), "utf-8");
}

function readMarker(workdir: string, hookId: string): MarkerData | null {
  const p = markerPath(workdir, hookId);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(require("fs").readFileSync(p, "utf-8")) as MarkerData;
  } catch {
    return null;
  }
}


// Different interpreters use different flags to evaluate inline code.
// Anything not listed here falls back to "-c".
const RUNNER_EVAL_FLAG: Record<string, string> = {
  node:    "-e",
  nodejs:  "-e",
  bun:     "-e",
  deno:    "-e",
  ruby:    "-e",
  perl:    "-e",
  Rscript: "-e",
};

function evalFlag(runner: string): string {
  // Match on the basename in case a full path was given (e.g. /usr/bin/node)
  const base = runner.split("/").pop() ?? runner;
  return RUNNER_EVAL_FLAG[base] ?? "-c";
}

// ─── Real-time streaming write ────────────────────────────────────────────────
// Drains a ReadableStream chunk-by-chunk, writing each one to the log file
// immediately so `tail -f step.log` works during execution.

async function streamToFile(
  stream: ReadableStream<Uint8Array> | null,
  ws: WriteStream,
  label: "STDOUT" | "STDERR"
): Promise<void> {
  if (!stream) return;

  let headerWritten = false;
  const reader = stream.getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value?.length) continue;

    if (!headerWritten) {
      ws.write(`\n── ${label} ${"─".repeat(50 - label.length)}\n`);
      headerWritten = true;
    }
    // Write the raw chunk — no buffering, no waiting for line boundaries
    await writeToStream(ws, value);
  }

  if (headerWritten) ws.write("\n");
}

/** Promisified single-chunk write so we respect backpressure */
function writeToStream(ws: WriteStream, data: string | Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    const ok = ws.write(data);
    if (ok) return resolve();
    ws.once("drain", resolve);
    ws.once("error", reject);
  });
}

function closeStream(ws: WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.end();
    ws.once("close", resolve);
    ws.once("error", reject);
  });
}



// ─── Runner ──────────────────────────────────────────────────────────────────

export class WorkflowRunner {
  private results: Map<string, TaskResult> = new Map();
  private promises: Map<string, Promise<TaskResult>> = new Map();
  private logger: Logger;
  private aborted = false;
  private runDir!: string;
  /** When --step is active: the set of hook_ids that should actually execute */
  private activeSteps: Set<string> | null = null;

  constructor(
    private flow: FlowConfig,
    private opts: RunnerOptions
  ) {
    this.logger = new Logger();
  }

  async run(): Promise<Map<string, TaskResult>> {
    // Derive default workdir from flow name when not explicitly set:
    // "Football Workflow" → "<cwd>/workdir/football-workflow"
    if (!this.flow.workdir) {
      const slug = this.flow.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");
      this.flow.workdir = resolve("workdir", slug);
    }

    // Default logs dir lives inside the workdir so everything is co-located.
    // CLI --logs-dir overrides this.
    if (!this.opts.logsDir) {
      this.opts.logsDir = join(this.flow.workdir, "logs");
    }

    // ── Per-run sub-directory ─────────────────────────────────────────────
    this.runDir = join(this.opts.logsDir, runTimestamp());
    await mkdir(this.runDir, { recursive: true });

    // ── --step: resolve the target + its full transitive dep set ─────────
    if (this.opts.step) {
      const target = this.flow.step.find((s) => s.hook_id === this.opts.step);
      if (!target) {
        throw new Error(
          `--step '${this.opts.step}' not found. ` +
          `Available hook_ids: ${this.flow.step.map((s) => s.hook_id).filter(Boolean).join(", ")}`
        );
      }
      this.activeSteps = this.resolveTransitiveDeps(this.opts.step);
    }

    const stepNote = this.opts.step
      ? `  (--step ${this.opts.step}: ${this.activeSteps!.size} step(s) in scope)`
      : this.opts.full ? "  (--full: skip fields ignored)" : "";

    this.logger.header(`▶  Workflow: ${this.flow.name}`);
    this.logger.info(`   Run log dir  : ${this.runDir}`);
    this.logger.info(`   Workdir      : ${this.flow.workdir}`);
    this.logger.info(`   Total steps  : ${this.flow.step.length}${stepNote}`);
    this.logger.line();

    for (const step of this.flow.step) {
      this.scheduleTask(step);
    }

    await Promise.allSettled([...this.promises.values()]);

    this.printSummary();
    return this.results;
  }

  /**
   * Walk the dep graph upward from hookId and return the full set of
   * hook_ids that must run (the target itself + all transitive wait deps).
   */
  private resolveTransitiveDeps(hookId: string): Set<string> {
    const visited = new Set<string>();
    const visit = (id: string) => {
      if (visited.has(id)) return;
      visited.add(id);
      const step = this.flow.step.find((s) => s.hook_id === id);
      if (!step) return;
      const deps: string[] = Array.isArray(step.wait) ? step.wait : [];
      for (const dep of deps) visit(dep);
    };
    visit(hookId);
    return visited;
  }

  private scheduleTask(step: StepConfig): Promise<TaskResult> {
    const id = step.hook_id!;
    if (this.promises.has(id)) return this.promises.get(id)!;
    const promise = this.executeTask(step);
    this.promises.set(id, promise);
    return promise;
  }

  private async executeTask(step: StepConfig): Promise<TaskResult> {
    const id = step.hook_id!;

    // ── Step index for filename prefix (1-based, zero-padded) ─────────────
    const stepIndex = this.flow.step.findIndex((s) => s.hook_id === id);
    const prefix = String(stepIndex + 1).padStart(2, "0");
    const logFile = join(this.runDir, `${prefix}_${safeFileName(step.name)}.log`);

    // ── 0. Excluded by --step ────────────────────────────────────────────
    if (this.activeSteps && !this.activeSteps.has(id)) {
      const result: TaskResult = {
        hookId: id, name: step.name, status: "skipped",
        skipReason: "excluded",
        exitCode: null, startedAt: null, finishedAt: null,
        durationMs: null, logFile,
      };
      this.results.set(id, result);
      await this.writeSkipLog(logFile, step, undefined, false, true);
      this.logger.skipExcluded(step.name);
      return result;
    }

    // ── 1. Await dependencies ─────────────────────────────────────────────
    const deps: string[] = Array.isArray(step.wait) ? step.wait : [];

    if (deps.length > 0) {
      const depSteps = this.flow.step.filter(
        (s) => s.hook_id && deps.includes(s.hook_id)
      );
      const depResults = await Promise.all(
        depSteps.map((s) => this.scheduleTask(s))
      );

      const blockingDep = depResults.find(
        (r) => r.status === "failed" ||
               (r.status === "skipped" && r.skipReason === "dependency")
      );

      if (blockingDep || this.aborted) {
        const result: TaskResult = {
          hookId: id, name: step.name, status: "skipped",
          skipReason: "dependency",
          exitCode: null, startedAt: null, finishedAt: null,
          durationMs: null, logFile,
        };
        this.results.set(id, result);
        await this.writeSkipLog(logFile, step, blockingDep?.name);
        this.logger.skip(step.name, blockingDep?.name);
        return result;
      }
    }

    // ── 2. Explicit skip ─────────────────────────────────────────────────
    const workdir = resolve(step.workdir ?? this.flow.workdir!);

    if (step.skip && !this.opts.full && !this.activeSteps) {
      const result: TaskResult = {
        hookId: id, name: step.name, status: "skipped",
        skipReason: "explicit",
        exitCode: null, startedAt: null, finishedAt: null,
        durationMs: null, logFile,
      };
      this.results.set(id, result);
      await this.writeSkipLog(logFile, step, undefined, true);
      this.logger.skipExplicit(step.name);
      return result;
    }

    // ── 3. Manual cache check (explicit cache: [...] field) ──────────────

    if (!this.opts.noCache && step.cache?.length) {
      const hits = checkCache(step.cache, workdir);
      if (hits) {
        const result: TaskResult = {
          hookId: id, name: step.name, status: "cached",
          exitCode: null, startedAt: null, finishedAt: null,
          durationMs: null, logFile, cacheHits: hits,
        };
        this.results.set(id, result);
        await this.writeCacheLog(logFile, step, workdir, hits);
        this.logger.taskCached(step.name, hits);
        return result;
      }
    }

    // ── 4. Auto-cache check (marker written on previous successful run) ───
    // Step runner > flow runner > default "bash"
    const runner = step.runner ?? this.flow.runner ?? "bash";

    if (!this.opts.noCache) {
      const marker = readMarker(workdir, id);
      if (marker && marker.commandHash === commandHash(step.command, runner)) {
        const mFile = markerPath(workdir, id);
        const result: TaskResult = {
          hookId: id, name: step.name, status: "cached",
          exitCode: null, startedAt: null, finishedAt: null,
          durationMs: null, logFile, cacheHits: [mFile],
        };
        this.results.set(id, result);
        await this.writeCacheLog(logFile, step, workdir, [mFile], marker.succeededAt);
        this.logger.taskCachedAuto(step.name, marker.succeededAt);
        return result;
      }
    }

    // ── 5. Open log file immediately so tail -f works from step start ─────
    const env = buildEnv(this.flow.env, step.env, step.bin);

    const ws = createWriteStream(logFile, { flags: "w" });
    const startedAt = new Date();

    // Write header synchronously before the process even starts
    ws.write(
      [
        `╔═══════════════════════════════════════════════════════════`,
        `  Step    : ${step.name}`,
        `  Info    : ${step.info ?? "—"}`,
        `  Runner  : ${runner} ${evalFlag(runner)}`,
        `  Command : ${step.command}`,
        `  Workdir : ${workdir}`,
        `  Started : ${startedAt.toISOString()}`,
        `╚═══════════════════════════════════════════════════════════`,
        "",
      ].join("\n")
    );

    this.logger.taskStart(step.name, step.command, deps);

    let exitCode: number | null = null;
    let status: TaskStatus = "running";
    let timedOut = false;

    try {
      if (!existsSync(workdir)) await mkdir(workdir, { recursive: true });

      const proc = Bun.spawn([runner, evalFlag(runner), step.command], {
        cwd: workdir,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });

      // ── Timeout watchdog ─────────────────────────────────────────────────
      const timeoutSecs = step.timeout ?? this.opts.defaultTimeout;
      let watchdog: ReturnType<typeof setTimeout> | null = null;
      if (timeoutSecs) {
        watchdog = setTimeout(() => {
          timedOut = true;
          try { proc.kill(); } catch {}
        }, timeoutSecs * 1000);
      }

      // ── Real-time stream: stdout and stderr flush as chunks arrive ────────
      await Promise.all([
        streamToFile(proc.stdout, ws, "STDOUT"),
        streamToFile(proc.stderr, ws, "STDERR"),
      ]);

      exitCode = await proc.exited;
      if (watchdog) clearTimeout(watchdog);

      if (timedOut) {
        status = "failed";
      } else if (exitCode === 0) {
        status = "success";
      } else {
        // ── Post-failure cache recheck ────────────────────────────────────
        // The command failed (e.g. "already exists"), but if every declared
        // cache path is now present and non-empty the output is usable.
        // Promote to "cached" so downstream steps aren't blocked.
        if (!this.opts.noCache && step.cache?.length) {
          const lateHits = checkCache(step.cache, workdir);
          if (lateHits) {
            status = "cached";
            ws.write(
              [
                ``,
                `── CACHE RECOVERED (exit ${exitCode}) ─────────────────────────`,
                `   The command exited with an error, but all declared cache`,
                `   paths are present and non-empty — treating as cached.`,
                ...lateHits.map((p) => `   ✔  ${p}`),
                ``,
              ].join("\n")
            );
            await closeStream(ws);

            const finishedAt = new Date();
            const durationMs = finishedAt.getTime() - startedAt.getTime();
            const result: TaskResult = {
              hookId: id, name: step.name, status: "cached",
              exitCode, startedAt, finishedAt, durationMs, logFile,
              cacheHits: lateHits,
            };
            this.results.set(id, result);
            this.logger.taskCachedLate(step.name, exitCode!, lateHits);
            return result;
          }
        }
        status = "failed";
      }

      if (status === "failed" && this.opts.failFast) this.aborted = true;
    } catch (err: any) {
      ws.write(`\n── ERROR ────────────────────────────────────────────────\n`);
      ws.write(err.message ?? String(err));
      ws.write("\n");
      status = "failed";
      if (this.opts.failFast) this.aborted = true;
    }

    const finishedAt = new Date();
    const durationMs = finishedAt.getTime() - startedAt.getTime();

    // ── Write footer and flush ────────────────────────────────────────────
    ws.write(
      [
        ``,
        `╔═══════════════════════════════════════════════════════════`,
        `  Finished : ${finishedAt.toISOString()}`,
        `  Duration : ${(durationMs / 1000).toFixed(3)}s`,
        `  Exit code: ${exitCode ?? "—"}`,
        `  Status   : ${timedOut ? `TIMEOUT (limit: ${step.timeout ?? this.opts.defaultTimeout}s)` : status.toUpperCase()}`,
        `╚═══════════════════════════════════════════════════════════`,
        "",
      ].join("\n")
    );

    await closeStream(ws);

    // ── Write auto-cache marker on success ───────────────────────────────
    if (status === "success" && !this.opts.noCache) {
      await writeMarker(workdir, id, step.command, runner);
    }

    const result: TaskResult = {
      hookId: id, name: step.name, status,
      exitCode, startedAt, finishedAt, durationMs, logFile,
    };
    this.results.set(id, result);

    if (timedOut) {
      this.logger.timeout(step.name, step.timeout ?? this.opts.defaultTimeout!);
    } else {
      this.logger.taskEnd(step.name, status, durationMs);
    }

    return result;
  }

  // ── Cache-hit log (no process ran) ───────────────────────────────────────

  private async writeCacheLog(
    logFile: string,
    step: StepConfig,
    workdir: string,
    hits: string[],
    succeededAt?: string
  ) {
    const lines = [
      `╔═══════════════════════════════════════════════════════════`,
      `  Step    : ${step.name}`,
      `  Status  : CACHED`,
      `  Time    : ${isoNow()}`,
      `  Workdir : ${workdir}`,
      ...(succeededAt ? [`  Last run : ${succeededAt}`] : []),
      `╚═══════════════════════════════════════════════════════════`,
      ``,
      `── Cache paths (all present — step skipped) ────────────────`,
    ];
    for (const abs of hits) {
      try {
        const size = (await Bun.file(abs).size) ?? 0;
        lines.push(`  ✔  ${abs}  (${formatSize(size)})`);
      } catch {
        lines.push(`  ✔  ${abs}`);
      }
    }
    lines.push("");
    await writeFile(logFile, lines.join("\n"), "utf-8");
  }

  // ── Skipped step log (written all at once — no process runs) ──────────────

  private async writeSkipLog(
    logFile: string,
    step: StepConfig,
    skippedBecause?: string,
    explicit?: boolean,
    excluded?: boolean
  ) {
    const reason = excluded
      ? `--step mode: step is outside the requested execution scope`
      : explicit
        ? "skip: true — step is explicitly disabled in the workflow file"
        : `dependency '${skippedBecause}' failed or was skipped`;
    await writeFile(
      logFile,
      [
        `╔═══════════════════════════════════════════════════════════`,
        `  Step    : ${step.name}`,
        `  Info    : ${step.info ?? "—"}`,
        `  Status  : SKIPPED`,
        `  Time    : ${isoNow()}`,
        `  Reason  : ${reason}`,
        `╚═══════════════════════════════════════════════════════════`,
        "",
      ].join("\n"),
      "utf-8"
    );
  }

  // ── Summary ───────────────────────────────────────────────────────────────

  private printSummary() {
    this.logger.line();
    this.logger.header("■  Summary");

    let success = 0, failed = 0, skipped = 0, cached = 0;

    for (const r of this.results.values()) {
      // Excluded steps are shown above as "○ name — excluded"; omit from summary table
      if (r.skipReason === "excluded") continue;

      const dur = r.durationMs != null ? `${(r.durationMs / 1000).toFixed(2)}s` : "—";
      this.logger.summaryRow(r.name, r.status, dur, r.logFile, r.cacheHits);
      if (r.status === "success") success++;
      else if (r.status === "failed") failed++;
      else if (r.status === "cached") cached++;
      else skipped++;
    }

    this.logger.line();
    this.logger.info(
      `   ✔ ${success} succeeded   ✖ ${failed} failed` +
      `   ⊘ ${skipped} skipped   ◈ ${cached} cached`
    );
    this.logger.info(`   Logs → ${this.runDir}`);
    this.logger.line();
  }
}