export interface FlowEnv {
  [key: string]: string;
}

export interface StepConfig {
  name: string;
  info?: string;
  workdir?: string;
  command: string;
  bin?: string;
  env?: FlowEnv;
  hook_id?: string;
  wait?: string | string[];
  /** Shell or interpreter used to run the command (default: "bash") */
  runner?: string;
  /** When true the step is skipped unconditionally regardless of dependencies */
  skip?: boolean;
  /**
   * List of paths (files or directories) to check before running the step.
   * Paths are resolved relative to the step's effective workdir.
   * If ALL listed paths exist the step is skipped with status "cached".
   */
  cache?: string[];
}

export interface FlowConfig {
  name: string;
  workdir?: string;
  env?: FlowEnv;
  /** Default runner for all steps (default: "bash") */
  runner?: string;
  step: StepConfig[];
}

export interface WorkflowFile {
  flow: FlowConfig;
}

// ─── Runtime types ───────────────────────────────────────────────────────────

export type TaskStatus = "pending" | "running" | "success" | "failed" | "skipped" | "cached";

export interface TaskResult {
  hookId: string;
  name: string;
  status: TaskStatus;
  exitCode: number | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  durationMs: number | null;
  logFile: string;
  /** Populated when status === "cached" — lists the paths that were found */
  cacheHits?: string[];
  /**
   * "explicit"    — step had skip: true in the TOML; dependents are NOT blocked
   * "dependency"  — step was blocked by a failed/cascaded upstream dep
   * "excluded"    — step is outside the --step target set; treated as transparent
   */
  skipReason?: "explicit" | "dependency" | "excluded";
}

export interface RunnerOptions {
  /** Root directory for log output (default: {workdir}/logs) */
  logsDir?: string;
  /** Stop all remaining tasks on first failure */
  failFast?: boolean;
  /** Global step timeout in seconds (overridden per-step by step.timeout) */
  defaultTimeout?: number;
  /** When true, ignore all cache declarations and always run every step */
  noCache?: boolean;
  /** When set, only this hook_id (and its transitive deps) will be executed */
  step?: string;
  /** When true, ignore all skip: true fields and run every step */
  full?: boolean;
}