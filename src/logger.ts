import type { TaskStatus } from "./types";

// ANSI colours
const C = {
  reset:  "\x1b[0m",
  bold:   "\x1b[1m",
  dim:    "\x1b[2m",
  cyan:   "\x1b[36m",
  green:  "\x1b[32m",
  yellow: "\x1b[33m",
  red:    "\x1b[31m",
  grey:   "\x1b[90m",
  blue:   "\x1b[34m",
  white:  "\x1b[97m",
};

const STATUS_ICON: Record<TaskStatus, string> = {
  pending: `${C.grey}○${C.reset}`,
  running: `${C.cyan}◉${C.reset}`,
  success: `${C.green}✔${C.reset}`,
  failed:  `${C.red}✖${C.reset}`,
  skipped: `${C.yellow}⊘${C.reset}`,
  cached:  `${C.blue}◈${C.reset}`,
};

const STATUS_COLOUR: Record<TaskStatus, string> = {
  pending: C.grey,
  running: C.cyan,
  success: C.green,
  failed:  C.red,
  skipped: C.yellow,
  cached:  C.blue,
};

export class Logger {
  line() {
    console.log(`${C.grey}${"─".repeat(64)}${C.reset}`);
  }

  header(text: string) {
    console.log(`${C.bold}${C.white}${text}${C.reset}`);
  }

  info(text: string) {
    console.log(`${C.dim}${text}${C.reset}`);
  }

  taskStart(name: string, command: string, deps: string[]) {
    const depStr =
      deps.length > 0
        ? `${C.grey} (waiting on: ${deps.join(", ")})${C.reset}`
        : "";
    console.log(
      `${C.cyan}▶${C.reset} ${C.bold}${name}${C.reset}${depStr}`
    );
    console.log(`  ${C.dim}$ ${command}${C.reset}`);
  }

  taskEnd(name: string, status: TaskStatus, durationMs: number) {
    const icon = STATUS_ICON[status];
    const col  = STATUS_COLOUR[status];
    const dur  = `${(durationMs / 1000).toFixed(2)}s`;
    console.log(
      `${icon} ${col}${name}${C.reset} ${C.grey}(${dur})${C.reset}`
    );
  }

  taskCached(name: string, hits: string[]) {
    console.log(
      `${STATUS_ICON.cached} ${C.blue}${name}${C.reset}` +
      `${C.grey} — cache hit [${hits.join(", ")}]${C.reset}`
    );
  }

  taskCachedLate(name: string, exitCode: number, hits: string[]) {
    console.log(
      `${STATUS_ICON.cached} ${C.blue}${name}${C.reset}` +
      `${C.yellow} — exit ${exitCode}, recovered from cache${C.reset}` +
      `${C.grey} [${hits.join(", ")}]${C.reset}`
    );
  }

  timeout(name: string, secs: number) {
    console.log(
      `${STATUS_ICON.failed} ${C.red}${name}${C.reset}${C.grey} — timed out after ${secs}s${C.reset}`
    );
  }

  skip(name: string, because?: string) {
    const reason = because ? ` — dep '${because}' failed` : "";
    console.log(
      `${STATUS_ICON.skipped} ${C.yellow}${name}${C.reset}${C.grey}${reason}${C.reset}`
    );
  }

  skipExplicit(name: string) {
    console.log(
      `${STATUS_ICON.skipped} ${C.yellow}${name}${C.reset}${C.grey} — skip: true${C.reset}`
    );
  }

  skipExcluded(name: string) {
    console.log(`${C.grey}  ○ ${name} — excluded${C.reset}`);
  }

  summaryRow(
    name: string,
    status: TaskStatus,
    duration: string,
    logFile: string,
    cacheHits?: string[]
  ) {
    const icon = STATUS_ICON[status];
    const col  = STATUS_COLOUR[status];
    const pad  = name.padEnd(30, " ");
    const extra = cacheHits?.length
      ? `${C.blue} [cached: ${cacheHits.join(", ")}]${C.reset}`
      : "";
    console.log(
      `  ${icon} ${col}${pad}${C.reset} ${C.grey}${duration.padStart(8)}  ${logFile}${C.reset}${extra}`
    );
  }
}