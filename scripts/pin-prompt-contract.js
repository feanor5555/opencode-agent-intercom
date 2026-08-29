#!/usr/bin/env node
// Regenerates the pin of the prompt contract's element text:
// `test/fixtures/prompt-contract.json`, written from `CONTRACT_ELEMENTS` and
// `PROMPT_CONTRACT` in src/prompts.js.
//
// Run it after an edit to one of the four contract elements, once the decision
// the failing pin test asks for has been made:
//
//   - a change to what the contract requires → bump PROMPT_CONTRACT first, then
//     run this;
//   - a cosmetic edit that requires nothing new of a prompt file → run this
//     alone, and the diff shows an element's text moving under an unchanged
//     contract number.
//
// A maintainer tool, not part of the published package: `scripts/` is outside
// the `files` array in package.json. Wired as `npm run pin:contract`.

import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { CONTRACT_ELEMENTS, contractElementText, PROMPT_CONTRACT } from "../src/prompts.js"

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
const fixturePath = join(repoRoot, "test", "fixtures", "prompt-contract.json")

const elements = {}
for (const element of CONTRACT_ELEMENTS) elements[element.id] = contractElementText(element.id)

mkdirSync(dirname(fixturePath), { recursive: true })
writeFileSync(fixturePath, `${JSON.stringify({ contract: PROMPT_CONTRACT, elements }, null, 2)}\n`)

const lineCount = Object.values(elements).reduce((sum, lines) => sum + lines.length, 0)
console.log(
  `pinned contract ${PROMPT_CONTRACT}: ` +
    `${Object.keys(elements).length} elements, ${lineCount} lines → ${fixturePath}`,
)
