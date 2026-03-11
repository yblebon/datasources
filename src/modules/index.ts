import type { StepConfig } from "../types";

// ─── Module interface ─────────────────────────────────────────────────────────

export interface ModuleParams {
  [key: string]: unknown;
}

/**
 * A module receives the raw params from the TOML [step.params] table and the
 * partial step definition, and returns the fields it wants to inject into the
 * final StepConfig. At minimum it must provide `command`.
 *
 * Returned fields are merged into the step — existing step fields take
 * precedence over module defaults, except `command` which is always owned
 * by the module.
 */
export interface Module {
  /** Short identifier used in the TOML `module = "..."` field */
  name: string;
  /** Human-readable description shown in --help and error messages */
  description: string;
  /** Required param names — parser throws if any are missing */
  required: string[];
  resolve(params: ModuleParams, step: Partial<StepConfig>): Partial<StepConfig>;
}

// ─── Registry ─────────────────────────────────────────────────────────────────

import { gitCloneModule } from "./git-clone";
import { gitPushModule }  from "./git-push";

const MODULES: Record<string, Module> = {
  [gitCloneModule.name]: gitCloneModule,
  [gitPushModule.name]:  gitPushModule,
};

export function getModule(name: string): Module {
  const mod = MODULES[name];
  if (!mod) {
    const available = Object.keys(MODULES).join(", ");
    throw new Error(
      `Unknown module '${name}'. Available modules: ${available}`
    );
  }
  return mod;
}

export function resolveModule(
  moduleName: string,
  params: ModuleParams,
  step: Partial<StepConfig>
): Partial<StepConfig> {
  const mod = getModule(moduleName);

  // Validate required params
  for (const key of mod.required) {
    if (params[key] === undefined || params[key] === null || params[key] === "") {
      throw new Error(
        `Module '${moduleName}' requires param '${key}' (step: '${step.name ?? "??"}')`
      );
    }
  }

  return mod.resolve(params, step);
}