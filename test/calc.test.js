// The `calc` tool (src/calc.js): exact arithmetic on figures an agent already
// holds, answered without a model call or a subagent run.
//
// Pinned here: every operator, suffix and function; precedence and
// associativity; floor division and modulo on negatives; bindings across
// statements; comparison results; the output forms; the 2^53 mark; that every
// error comes back as one `calc: … at column <n>` line instead of a throw; the
// three bounds; that no name reaches anything but an earlier binding; and the
// tool's registration under its kill switch in both agent modes.
//
// Run: node --test test/calc.test.js

import test, { beforeEach, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  evaluateCalc,
  formatCalcValue,
  isCalcEnabled,
  createCalcTool,
  CALC_MAX_INPUT_CHARS,
  CALC_MAX_STATEMENTS,
  CALC_MAX_DEPTH,
} from "../src/calc.js"
import { createTools } from "../src/tools.js"
import { resetState } from "../src/state.js"
import { setSettingsPath, resetSettings, soloModeActive } from "../src/settings.js"

const KILL_SWITCH = "OPENCODE_AGENT_INTERCOM_DISABLE_CALC"
const MODE_ENV = "OPENCODE_AGENT_INTERCOM_AGENT_MODE"

const fixtureDir = mkdtempSync(join(tmpdir(), "intercom-calc-"))
const settingsFile = join(fixtureDir, "agent-intercom.json")
setSettingsPath(settingsFile)

after(() => rmSync(fixtureDir, { recursive: true, force: true }))

beforeEach(() => {
  delete process.env[KILL_SWITCH]
  delete process.env[MODE_ENV]
  rmSync(settingsFile, { force: true })
  resetState()
  resetSettings()
})

const calc = (text) => evaluateCalc(text)

// ---- operators and precedence -------------------------------------------------

test("each arithmetic operator", () => {
  assert.equal(calc("7 + 5"), "12")
  assert.equal(calc("7 - 5"), "2")
  assert.equal(calc("7 * 5"), "35")
  assert.equal(calc("7 / 2"), "3.5")
  assert.equal(calc("7 // 2"), "3")
  assert.equal(calc("7 % 5"), "2")
  assert.equal(calc("2 ** 10"), "1024 (1_024, 0x400)")
  assert.equal(calc("-(3)"), "-3")
  assert.equal(calc("+3"), "3")
})

test("precedence and associativity", () => {
  assert.equal(calc("2+3*4**2"), "50")
  assert.equal(calc("(2+3)*4"), "20")
  assert.equal(calc("2**3**2"), "512 (0x200)", "** is right-associative")
  assert.equal(calc("-2**2"), "-4", "** binds tighter than a unary minus on its left")
  assert.equal(calc("2**-1"), "0.5", "the exponent takes a unary minus")
  assert.equal(calc("10 - 4 - 3"), "3", "- is left-associative")
  assert.equal(calc("100 // 7 % 3"), "2")
})

test("// floors and % takes the sign of the divisor, on negatives too", () => {
  assert.equal(calc("-7 // 2"), "-4")
  assert.equal(calc("-7 % 2"), "1")
  assert.equal(calc("7 // -2"), "-4")
  assert.equal(calc("7 % -2"), "-1")
  // a == (a // b) * b + a % b holds on every sign combination.
  for (const [a, b] of [[-7, 2], [7, -2], [-7, -2], [7, 2]]) {
    assert.equal(calc(`(${a}) == ((${a}) // (${b})) * (${b}) + (${a}) % (${b})`), "true")
  }
})

// ---- number literals ------------------------------------------------------------

test("number forms: separators, exponent, hex, binary", () => {
  assert.equal(calc("1_000_000"), "1000000 (1_000_000, 0xF4240)")
  assert.equal(calc("1.5e3"), "1500 (1_500, 0x5DC)")
  assert.equal(calc("2E-3"), "0.002")
  assert.equal(calc("0xff"), "255")
  assert.equal(calc("0b1010"), "10")
  assert.equal(calc(".5 + .25"), "0.75")
})

test("each decimal and binary suffix", () => {
  assert.equal(calc("1k"), "1000 (1_000, 0x3E8)")
  assert.equal(calc("1M == 1_000_000"), "true")
  assert.equal(calc("1G == 10**9"), "true")
  assert.equal(calc("1T == 10**12"), "true")
  assert.equal(calc("1Ki"), "1024 (1_024, 0x400)")
  assert.equal(calc("1Mi == 1024**2"), "true")
  assert.equal(calc("1Gi == 1024**3"), "true")
  assert.equal(calc("1Ti == 1024**4"), "true")
  assert.equal(calc("1.5k"), "1500 (1_500, 0x5DC)")
})

test("an unknown suffix is an error, not a silent name", () => {
  assert.equal(calc("12ki"), 'calc: unknown number suffix "ki" at column 3')
  assert.equal(calc("3x"), 'calc: unknown number suffix "x" at column 2')
})

// ---- functions, comparisons, bindings -------------------------------------------

test("each function", () => {
  assert.equal(calc("min(3, 1, 2)"), "1")
  assert.equal(calc("max(3, 1, 2)"), "3")
  assert.equal(calc("abs(-4)"), "4")
  assert.equal(calc("floor(2.7)"), "2")
  assert.equal(calc("ceil(2.1)"), "3")
  assert.equal(calc("round(2.5)"), "3")
  assert.equal(calc("sqrt(16)"), "4")
  assert.equal(calc("log2(1024)"), "10")
  assert.equal(calc("log10(1000)"), "3")
  assert.equal(calc("ln(1)"), "0")
  assert.equal(calc("pow(2, 8)"), "256 (0x100)")
})

test("a function called with the wrong number of arguments says so", () => {
  assert.equal(calc("pow(2)"), "calc: pow takes 2 arguments, got 1 at column 1")
  assert.equal(calc("abs(1, 2)"), "calc: abs takes 1 argument, got 2 at column 1")
  assert.equal(calc("min()"), "calc: min takes one or more arguments, got 0 at column 1")
})

test("comparisons answer true or false", () => {
  assert.equal(calc("204k <= 200k"), "false")
  assert.equal(calc("3 < 4"), "true")
  assert.equal(calc("3 > 4"), "false")
  assert.equal(calc("4 >= 4"), "true")
  assert.equal(calc("4 == 4"), "true")
  assert.equal(calc("4 != 4"), "false")
  assert.equal(calc("1 < 2 < 3"), "calc: compare two values at a time; split a chained comparison at column 7")
  assert.equal(calc("(1 < 2) + 1"), "calc: the left side is a comparison result (true/false), not a number at column 9")
})

test("bindings carry across statements separated by ; and new lines", () => {
  assert.equal(
    calc("budget = 200k; used = 204_000\nused <= budget"),
    "budget = 200000 (200_000, 0x30D40)\nused = 204000 (204_000, 0x31CE0)\nfalse",
  )
  assert.equal(calc("a = 2; a = a * 3; a"), "a = 2\na = 6\n6", "a later binding replaces an earlier one")
  assert.equal(calc("x = 1;;\n\n x + 1"), "x = 1\n2", "empty statements are skipped")
})

test("a function name cannot be bound", () => {
  assert.equal(calc("min = 3"), 'calc: "min" is a function; bind the value to another name at column 1')
})

// ---- output --------------------------------------------------------------------

test("integers show grouped from 1000 and hex from 256; others to 15 digits", () => {
  assert.equal(formatCalcValue(255), "255")
  assert.equal(formatCalcValue(256), "256 (0x100)")
  assert.equal(formatCalcValue(-4096), "-4096 (-4_096, -0x1000)")
  assert.equal(formatCalcValue(0.1 + 0.2), "0.3")
  assert.equal(formatCalcValue(-0), "0")
  assert.equal(formatCalcValue(true), "true")
})

test("a value beyond 2^53 is marked not exact, and a name bound from it carries the mark", () => {
  assert.equal(
    calc("2**60"),
    "1152921504606846976 (1_152_921_504_606_846_976, 0x1000000000000000) (not exact: beyond 2^53)",
  )
  assert.equal(calc("2**52 + (2**52 - 1)"), "9007199254740991 (9_007_199_254_740_991, 0x1FFFFFFFFFFFFF)")
  const lines = calc("x = 2**60 / 2**20; x + 1").split("\n")
  assert.match(lines[0], /\(not exact: beyond 2\^53\)$/, "an intermediate beyond 2^53 marks the result")
  assert.match(lines[1], /\(not exact: beyond 2\^53\)$/, "the mark travels with the name")
})

// ---- errors ----------------------------------------------------------------------

test("every error comes back as one line naming its column, never a throw", () => {
  assert.equal(calc("1 / 0"), "calc: division by zero at column 3")
  assert.equal(calc("1 // 0"), "calc: division by zero at column 3")
  assert.equal(calc("1 % 0"), "calc: division by zero at column 3")
  assert.equal(calc("sqrt(-1)"), "calc: sqrt of a negative number at column 1")
  assert.equal(calc("ln(0)"), "calc: ln of a number that is not positive at column 1")
  assert.equal(calc("pow(-8, 1/3)"), "calc: the result is not a real number at column 1")
  assert.equal(calc("10**400"), "calc: the result is too large to represent at column 3")
  assert.equal(calc("1 +"), 'calc: expected a number, a name or "(" but found the end of the statement at column 4')
  assert.equal(calc("(1 + 2"), 'calc: expected ")" but found the end of the statement at column 7')
  assert.equal(calc("1 $ 2"), 'calc: unexpected character "$" at column 3')
  assert.equal(calc("x = 1; y + 1"), 'calc: unknown name "y" at column 8', "the column counts over the whole input")
  assert.equal(calc("foo(1)"), 'calc: unknown function "foo" at column 1')
  assert.equal(calc(""), "calc: the expression is empty at column 1")
  assert.equal(calc(undefined), "calc: the expression is empty at column 1")
})

test("the parser reaches no property and no global: such names are unknown", () => {
  for (const name of ["constructor", "__proto__", "process", "globalThis", "toString", "hasOwnProperty"]) {
    assert.equal(calc(name), `calc: unknown name "${name}" at column 1`, name)
    assert.equal(calc(`${name}(1)`), `calc: unknown function "${name}" at column 1`, name)
  }
})

test("the three bounds are refused with a line of their own", () => {
  const long = "1+".repeat(CALC_MAX_INPUT_CHARS / 2) + "1"
  assert.equal(
    calc(long),
    `calc: the input is longer than ${CALC_MAX_INPUT_CHARS} characters at column ${CALC_MAX_INPUT_CHARS + 1}`,
  )

  const statements = Array.from({ length: CALC_MAX_STATEMENTS }, () => "1").join(";")
  assert.equal(calc(statements).split("\n").length, CALC_MAX_STATEMENTS)
  assert.equal(
    calc(`${statements};1`),
    `calc: more than ${CALC_MAX_STATEMENTS} statements at column ${CALC_MAX_STATEMENTS * 2 + 1}`,
  )

  const nested = (n) => "(".repeat(n) + "1" + ")".repeat(n)
  assert.equal(calc(nested(CALC_MAX_DEPTH)), "1")
  assert.equal(
    calc(nested(CALC_MAX_DEPTH + 1)),
    `calc: nesting is deeper than ${CALC_MAX_DEPTH} levels at column ${CALC_MAX_DEPTH + 1}`,
  )
  assert.match(calc("-".repeat(CALC_MAX_DEPTH + 1) + "1"), /nesting is deeper than/)
})

// ---- the tool -------------------------------------------------------------------

test("the tool answers the evaluator's text as its output", async () => {
  const out = await createCalcTool().execute({ expression: "6 * 7" }, {})
  assert.deepEqual(out, { output: "42" })
})

const toolNames = () =>
  Object.keys(createTools({ client: {}, directory: fixtureDir, permissionGuard: null }))

test("the tool is registered in orchestrator mode and absent under the kill switch", () => {
  assert.equal(isCalcEnabled(), true)
  assert.ok(toolNames().includes("calc"))

  process.env[KILL_SWITCH] = "1"
  assert.equal(isCalcEnabled(), false)
  assert.ok(!toolNames().includes("calc"))
})

test("the tool is registered in solo mode", () => {
  writeFileSync(settingsFile, JSON.stringify({ agentMode: "solo" }))
  resetSettings()
  assert.equal(soloModeActive(), true)
  const names = toolNames()
  assert.ok(names.includes("calc"))
  assert.ok(!names.includes("spawn"), "solo mode is really in effect")
})
