#!/usr/bin/env node
// Writes default per-agent prompt templates to
// `<cwd>/.opencode/agent-intercom/<agent>.md` — one file per agent (9 total).
// Each template contains the full system prompt that agent would receive,
// with `{{placeholder}}` tokens at the spots where the runtime parts get
// injected (env, AGENTS.md, project-spec, limits, snapshot, context_budget,
// abort_notice). The plugin's transform hook picks up edits on the next LLM
// call (mtime-cached).
//
// Usage:
//   npx opencode-agent-intercom-init-prompts          # refuse to clobber existing files
//   npx opencode-agent-intercom-init-prompts --force  # overwrite all 9 files
//   npx opencode-agent-intercom-init-prompts <dir>    # target a different project dir

import { writeDefaultPromptsFiles, getPromptsDir } from "../src/promptsfile.js"
import { resolve } from "node:path"

const args = process.argv.slice(2)
let force = false
let dir = process.cwd()
for (const arg of args) {
  if (arg === "--force" || arg === "-f") force = true
  else if (arg === "--help" || arg === "-h") {
    console.log(
      "Usage: opencode-agent-intercom-init-prompts [--force] [<directory>]\n" +
        "Writes default prompt templates to <dir>/.opencode/agent-intercom/<agent>.md,\n" +
        "one file per agent (9 files). Refuses to overwrite existing files unless --force.",
    )
    process.exit(0)
  } else if (!arg.startsWith("-")) {
    dir = resolve(arg)
  }
}

try {
  const results = writeDefaultPromptsFiles(dir, { overwrite: force })
  const wrote = results.filter((r) => r.written)
  const skip = results.filter((r) => !r.written)
  for (const r of wrote) console.log(`Wrote ${r.filePath}`)
  for (const r of skip) console.log(`Skipped (exists): ${r.filePath}`)
  console.log(`\n${wrote.length} written, ${skip.length} skipped under ${getPromptsDir(dir)}`)
  if (wrote.length === 0 && skip.length > 0) {
    console.error("All files already exist — re-run with --force to replace them.")
    process.exit(2)
  }
} catch (err) {
  console.error(`Failed to write prompt files: ${err?.message ?? err}`)
  process.exit(1)
}
