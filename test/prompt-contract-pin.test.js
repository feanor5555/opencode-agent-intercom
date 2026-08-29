// The PIN — `fixtures/prompt-contract.json`, the rendered text of the four
// contract elements as of the contract number it names. A probe keeps matching a
// reworded element; the pin does not, so a reword fails here until the
// maintainer either bumps PROMPT_CONTRACT and re-pins, or re-pins alone.
//
// Nothing here touches the filesystem beyond reading the fixture, and nothing
// here loads the plugin: this is the contract's own text against the contract's
// own tables. The files on disk are judged in
// test/prompt-file-staleness.test.js.
//
// Run: node --test test/prompt-contract-pin.test.js

import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { PROMPT_CONTRACT, CONTRACT_ELEMENTS, contractElementText } from "../src/prompts.js"
import { PROMPT_FILE_PROBES } from "../src/overrides.js"

// The pin: the rendered text of the four contract elements as of the contract
// number it names. Written by `npm run pin:contract`, never by hand.
const pinPath = fileURLToPath(new URL("./fixtures/prompt-contract.json", import.meta.url))
const pin = JSON.parse(readFileSync(pinPath, "utf8"))

const elementIds = CONTRACT_ELEMENTS.map((element) => element.id)

// The decision a failing pin asks the maintainer for. It is the whole mechanism
// — everything else here only makes sure this text is reached.
const PIN_DECISION =
  "- a change to what the contract requires → bump PROMPT_CONTRACT in\n" +
  "  src/prompts.js, then `npm run pin:contract`\n" +
  "- a cosmetic edit that requires nothing new of a prompt file →\n" +
  "  `npm run pin:contract` alone"

// Names the lines that moved, so the maintainer decides on the actual diff
// rather than on "some object differs".
function elementDrift(id, pinned, current) {
  const rows = []
  for (let i = 0; i < Math.max(pinned.length, current.length); i++) {
    const was = pinned[i]
    const now = current[i]
    if (was && now && was.block === now.block && was.line === now.line) continue
    rows.push(
      `  [${i}] ${now?.block ?? was?.block ?? "(no block)"}\n` +
        `    pinned:  ${was ? JSON.stringify(was.line) : "(nothing — the element gained a line)"}\n` +
        `    current: ${now ? JSON.stringify(now.line) : "(nothing — the element lost a line)"}`,
    )
  }
  return `Contract element "${id}" was reworded.\n${rows.join("\n")}\n${PIN_DECISION}`
}

test("the pinned contract text is the text the guides carry today", () => {
  // The pin covers exactly the table: an element added to CONTRACT_ELEMENTS
  // without a re-pin has no pinned text to fail against, so it is caught here.
  assert.deepEqual(
    Object.keys(pin.elements).sort(),
    [...elementIds].sort(),
    `the pin names other elements than src/prompts.js does — \`npm run pin:contract\``,
  )

  for (const id of elementIds) {
    const current = contractElementText(id)
    const pinned = pin.elements[id]
    assert.deepEqual(current, pinned, elementDrift(id, pinned, current))
  }
})

test("the pin names the contract it belongs to", () => {
  // The mirror image: a bump that forgot the re-pin. The pinned text is the
  // definition of what contract `pin.contract` requires, so it may not outlive
  // the number it was taken under.
  assert.equal(
    pin.contract,
    PROMPT_CONTRACT,
    `the pin was taken under contract ${pin.contract}, PROMPT_CONTRACT is now ` +
      `${PROMPT_CONTRACT} — re-pin the element text with \`npm run pin:contract\``,
  )
})

test("every contract element has a probe, and every probe an element", () => {
  // The two tables are one contract seen twice: overrides.js probes a file for
  // an element, prompts.js says which text that element is. An id in one and
  // not the other means a file is judged on something that is not pinned, or
  // text is pinned that no file is judged on.
  assert.deepEqual([...elementIds].sort(), PROMPT_FILE_PROBES.map((probe) => probe.id).sort())

  // The `select` regexes go stale the same way the probe regexes do — an
  // element whose matcher stops selecting anything would otherwise pin an empty
  // array and pass for ever after.
  for (const id of elementIds) {
    assert.ok(
      contractElementText(id).length > 0,
      `contract element ${id} selects no line — its select regex no longer matches its guide`,
    )
  }
})
