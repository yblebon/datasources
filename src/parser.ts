import { parse } from "smol-toml";
import { readFileSync } from "fs";
import type { WorkflowFile, StepConfig } from "./types";
import { resolveModule } from "./modules/index";

export function parseWorkflow(tomlPath: string): WorkflowFile {
  const raw = readFileSync(tomlPath, "utf-8");
  const parsed = parse(raw) as any;

  if (!parsed.flow) {
    throw new Error("TOML must contain a [flow] table");
  }

  const flow = parsed.flow;

  if (!flow.name) throw new Error("[flow] must have a 'name' field");
  if (!flow.step || !Array.isArray(flow.step)) {
    throw new Error("[flow] must have a 'step' array (use [[flow.step]])");
  }

  // Validate + normalise steps
  const steps: StepConfig[] = flow.step.map((s: any, i: number) => {
    if (!s.name) throw new Error(`Step #${i + 1} is missing 'name'`);

    // ── Module resolution ────────────────────────────────────────────────
    // If the step declares `module = "..."`, resolve it first so the
    // generated fields (command, cache, info) are available for validation.
    if (s.module) {
      const generated = resolveModule(s.module, s.params ?? {}, s);
      // Module-generated fields fill in gaps; step-level fields win except
      // for `command` which is always owned by the module.
      Object.assign(s, { ...generated, ...s, command: generated.command });
    }

    if (!s.command) throw new Error(`Step '${s.name}' is missing 'command' (and no module was specified)`);

    // Normalise wait → always string[]
    if (s.wait && typeof s.wait === "string") {
      s.wait = s.wait.split(",").map((w: string) => w.trim()).filter(Boolean);
    }

    return s as StepConfig;
  });

  // Validate wait references point to real hook_ids
  const hookIds = new Set(steps.map((s) => s.hook_id).filter(Boolean));
  // Auto-assign hook_id to steps that don't have one (index-based)
  steps.forEach((s, i) => {
    if (!s.hook_id) s.hook_id = `__step_${i}`;
  });

  for (const step of steps) {
    const waits = Array.isArray(step.wait) ? step.wait : [];
    for (const dep of waits) {
      if (!hookIds.has(dep)) {
        throw new Error(
          `Step '${step.name}' waits for '${dep}' but no step has hook_id '${dep}'`
        );
      }
    }
  }

  return { flow: { ...flow, step: steps } };
}