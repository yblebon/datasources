## Overall impression

This is a genuinely useful piece of tooling. The core idea — a TOML-driven parallel task runner with dependency resolution, caching, and real-time logs — sits in a sweet spot that existing tools don't quite cover. It's simpler than a full CI system (Jenkins, GitHub Actions) but more structured than a Makefile. The Bun choice is smart: fast startup, native TypeScript, and `Bun.spawn` with readable streams makes the real-time log flushing clean.

The incremental design is also solid — each feature builds naturally on the last without breaking prior behaviour.

---

## What's working well

**The dependency model** is the strongest part. Promise-based scheduling with no polling is elegant, and the `skipReason: "explicit" | "dependency"` distinction to prevent unintended cascade skips shows real thought about edge cases.

**Cache recovery** (post-failure recheck + empty-dir detection) is a production-grade detail that most hobby runners skip entirely. It directly solves the git clone re-run problem.

**Log structure** is excellent — timestamped run directories, numbered step prefixes, real-time flushing, headers with full context. You can `tail -f` a running step or `diff` two runs. This is often the last thing people think about and you did it early.

**The runner abstraction** (`bash`, `node -e`, `python3 -c`) with automatic flag detection is a nice quality-of-life feature.

---

## What can be improved

**1. No retry mechanism**

A step that fails due to a transient error (network blip during `git clone`, flaky test) currently requires a full re-run or manual intervention. A `retry` field with optional delay would make this production-viable:

```toml
retry       = 3
retry_delay = 5   # seconds between attempts
```

**2. No `--step` flag to run a single step by name/hook_id**

Right now you run everything or nothing (with `skip: true`). Being able to do:
```sh
bun run index.ts workflow.toml --step clone-toolchain
```
would be invaluable for debugging a specific step without touching the TOML.

**3. TOML validation errors aren't friendly enough**

The parser throws raw JS errors. A step missing `command`, a `wait` referencing a non-existent `hook_id`, or a circular dependency (`A waits on B, B waits on A`) will produce confusing output or silently hang forever. Circular dependency detection in particular is a correctness bug waiting to happen.

**4. No `output` / artifact passing between steps**

Steps can't currently communicate results. A common pattern is: step 1 produces a version string, step 2 needs it. Right now you'd have to write to a file and read it back manually. An `outputs` field that captures stdout into a named variable usable as `${{steps.build.output}}` in later steps would be powerful.

**5. The `env` section inheritance isn't composable**

Flow-level env and step-level env are merged, but there's no way to reference a flow-level variable inside the TOML itself. Something like:

```toml
[flow.env]
BASE_DIR = "/opt/myapp"

[[flow.step]]
command = "cd $BASE_DIR && make"   # works at runtime
workdir = "$BASE_DIR/src"          # does NOT expand — treated as literal
```

`workdir` and `bin` paths don't go through env expansion, so you end up duplicating paths.

**6. No `depends_on` at the flow level**

Right now `wait` is per-step. There's no way to say "all steps in this flow require the setup flow to have run first." A lightweight flow-composition model — even just being able to `include` another TOML — would open up reuse.

**7. The `--full` flag name is ambiguous**

`--full` reads as "full output" or "verbose". Something like `--no-skip` or `--ignore-skip` is more self-documenting at the CLI level.

**8. No summary exit code distinction**

Currently exits `1` if any step failed. It would be useful to distinguish: `1` = step failure, `2` = workflow configuration error, `3` = timeout — so calling scripts can react differently.

---

## Bigger picture

The project is at the point where it works reliably for a single machine. The natural next question is: **where does it run?** If the answer stays "locally", the main investment should be in the retry + single-step execution UX. If the answer becomes "in CI" or "as a daemon", you'd want a machine-readable run summary (JSON output alongside the human logs) and probably a `watch` mode that re-runs on file changes. A simple `bun run index.ts workflow.toml --json > run-summary.json` would make it trivially composable with other tools.