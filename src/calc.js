// The `calc` tool: exact arithmetic on figures an agent already holds — sizes,
// budgets, offsets, token sums — answered in milliseconds, with no model call
// and no subagent run. Held by the orchestrator (a member of PRIMARY_TOOLS,
// src/hooks.js) and by every subagent, since no role's permission map denies it.
//
// The evaluator is a hand-written recursive-descent parser over a closed
// grammar. It never reaches `eval`, `Function` or a property of any object:
// names resolve only against the bindings of earlier statements (a Map, so
// `constructor` or `__proto__` are unknown names like any other) and the fixed
// function table below.
//
// Grammar:
//   input      = statement { (";" | newline) statement }
//   statement  = [ name "=" ] comparison
//   comparison = sum [ ("<" | "<=" | ">" | ">=" | "==" | "!=") sum ]
//   sum        = product { ("+" | "-") product }
//   product    = unary { ("*" | "/" | "//" | "%") unary }
//   unary      = "-" unary | "+" unary | power
//   power      = atom [ "**" unary ]
//   atom       = number | name | name "(" args ")" | "(" comparison ")"
//
// `**` is right-associative and binds tighter than a unary minus on its left
// (`-2**2` is -4); `//` floors and `%` takes the sign of the divisor, so the
// two always satisfy `a == (a // b) * b + a % b`.
//
// Numbers are doubles. Every value a statement touches — literal, bound name,
// intermediate, result — beyond Number.MAX_SAFE_INTEGER marks that statement's
// result `(not exact: beyond 2^53)`, and a name bound from such a statement
// carries the mark into every statement that uses it.
//
// The tool never throws into the model: every parse error, domain error and
// bound refusal comes back as one line `calc: <message> at column <n>`, the
// column counted from 1 over the whole input, so the caller reads what to
// correct and calls again.
//
// Disable the whole tool with OPENCODE_AGENT_INTERCOM_DISABLE_CALC=1.

import { tool } from "@opencode-ai/plugin"

const z = tool.schema

export const CALC_MAX_INPUT_CHARS = 4000
export const CALC_MAX_STATEMENTS = 100
export const CALC_MAX_DEPTH = 64

const DECIMAL_SUFFIXES = { k: 1e3, M: 1e6, G: 1e9, T: 1e12 }
const BINARY_SUFFIXES = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4 }

// Name → [arity, implementation]. An arity of -1 takes one or more arguments.
const FUNCTIONS = new Map([
  ["min", [-1, (...xs) => Math.min(...xs)]],
  ["max", [-1, (...xs) => Math.max(...xs)]],
  ["abs", [1, Math.abs]],
  ["floor", [1, Math.floor]],
  ["ceil", [1, Math.ceil]],
  ["round", [1, Math.round]],
  ["sqrt", [1, Math.sqrt]],
  ["log2", [1, Math.log2]],
  ["log10", [1, Math.log10]],
  ["ln", [1, Math.log]],
  ["pow", [2, (a, b) => a ** b]],
])

// Functions whose argument has a domain narrower than every number.
const DOMAIN_CHECKS = {
  sqrt: (x) => (x < 0 ? "sqrt of a negative number" : ""),
  log2: (x) => (x <= 0 ? "log2 of a number that is not positive" : ""),
  log10: (x) => (x <= 0 ? "log10 of a number that is not positive" : ""),
  ln: (x) => (x <= 0 ? "ln of a number that is not positive" : ""),
}

class CalcError extends Error {
  constructor(message, offset) {
    super(message)
    this.offset = offset
  }
}

// ---- tokenizer ---------------------------------------------------------------

const OPERATORS = ["**", "//", "<=", ">=", "==", "!=", "+", "-", "*", "/", "%", "<", ">", "(", ")", ",", "="]

function isDigit(c) {
  return c >= "0" && c <= "9"
}

function isNameStart(c) {
  return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_"
}

function isNameChar(c) {
  return isNameStart(c) || isDigit(c)
}

// Reads one number literal starting at `i`; returns [value, end].
function readNumber(text, i) {
  const start = i
  let value
  const prefix = text.slice(i, i + 2).toLowerCase()
  if (prefix === "0x" || prefix === "0b") {
    const radix = prefix === "0x" ? 16 : 2
    const valid = radix === 16 ? /[0-9a-fA-F_]/ : /[01_]/
    i += 2
    let digits = ""
    while (i < text.length && valid.test(text[i])) {
      if (text[i] !== "_") digits += text[i]
      i += 1
    }
    if (digits === "") throw new CalcError(`"${text.slice(start, i + 1)}" has no digits`, start)
    value = Number(BigInt(`0${radix === 16 ? "x" : "b"}${digits}`))
  } else {
    let literal = ""
    while (i < text.length && (isDigit(text[i]) || text[i] === "_")) {
      if (text[i] !== "_") literal += text[i]
      i += 1
    }
    if (text[i] === "." && isDigit(text[i + 1] ?? "")) {
      literal += "."
      i += 1
      while (i < text.length && (isDigit(text[i]) || text[i] === "_")) {
        if (text[i] !== "_") literal += text[i]
        i += 1
      }
    }
    if ((text[i] === "e" || text[i] === "E") && /^[eE][+-]?[0-9]/.test(text.slice(i, i + 3))) {
      literal += "e"
      i += 1
      if (text[i] === "+" || text[i] === "-") {
        literal += text[i]
        i += 1
      }
      while (i < text.length && isDigit(text[i])) {
        literal += text[i]
        i += 1
      }
    }
    value = Number(literal)
  }
  const two = text.slice(i, i + 2)
  if (BINARY_SUFFIXES[two] !== undefined && !isNameChar(text[i + 2] ?? "")) {
    value *= BINARY_SUFFIXES[two]
    i += 2
  } else if (DECIMAL_SUFFIXES[text[i]] !== undefined && !isNameChar(text[i + 1] ?? "")) {
    value *= DECIMAL_SUFFIXES[text[i]]
    i += 1
  }
  if (isNameChar(text[i] ?? "")) {
    throw new CalcError(`unknown number suffix "${readWord(text, i)}"`, i)
  }
  return [value, i]
}

function readWord(text, i) {
  let end = i
  while (end < text.length && isNameChar(text[end])) end += 1
  return text.slice(i, end)
}

// Splits the input into tokens: { type, value, offset }. Types: "number",
// "name", "op", "end" (statement separator) and "eof".
function tokenize(text) {
  const tokens = []
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (c === ";" || c === "\n") {
      tokens.push({ type: "end", value: c, offset: i })
      i += 1
      continue
    }
    if (c === " " || c === "\t" || c === "\r") {
      i += 1
      continue
    }
    if (isDigit(c) || (c === "." && isDigit(text[i + 1] ?? ""))) {
      const [value, end] = readNumber(text, i)
      tokens.push({ type: "number", value, offset: i })
      i = end
      continue
    }
    if (isNameStart(c)) {
      const word = readWord(text, i)
      tokens.push({ type: "name", value: word, offset: i })
      i += word.length
      continue
    }
    const op = OPERATORS.find((o) => text.startsWith(o, i))
    if (op) {
      tokens.push({ type: "op", value: op, offset: i })
      i += op.length
      continue
    }
    throw new CalcError(`unexpected character "${c}"`, i)
  }
  tokens.push({ type: "eof", value: "", offset: text.length })
  return tokens
}

// ---- parser and evaluator ----------------------------------------------------

const COMPARISONS = new Set(["<", "<=", ">", ">=", "==", "!="])

// Evaluates one statement's tokens against `bindings` (name → { value,
// inexact }). Returns { name?, value, inexact }.
function evaluateStatement(tokens, bindings) {
  let pos = 0
  let depth = 0
  let inexact = false

  const peek = () => tokens[pos]
  const next = () => tokens[pos++]
  const isOp = (value) => peek().type === "op" && peek().value === value

  const describe = (token) => (token.type === "eof" || token.type === "end" ? "the end of the statement" : `"${token.value}"`)

  const expect = (value) => {
    if (!isOp(value)) throw new CalcError(`expected "${value}" but found ${describe(peek())}`, peek().offset)
    return next()
  }

  // Every number a statement touches passes here.
  const note = (value, offset) => {
    if (typeof value === "number") {
      if (Number.isNaN(value)) throw new CalcError("the result is not a real number", offset)
      if (!Number.isFinite(value)) throw new CalcError("the result is too large to represent", offset)
      if (Math.abs(value) > Number.MAX_SAFE_INTEGER) inexact = true
    }
    return value
  }

  const number = (value, token, role) => {
    if (typeof value !== "number") {
      throw new CalcError(`${role} is a comparison result (true/false), not a number`, token.offset)
    }
    return value
  }

  const enter = (token) => {
    depth += 1
    if (depth > CALC_MAX_DEPTH) {
      throw new CalcError(`nesting is deeper than ${CALC_MAX_DEPTH} levels`, token.offset)
    }
  }

  function comparison() {
    const left = sum()
    if (peek().type === "op" && COMPARISONS.has(peek().value)) {
      const op = next()
      const right = sum()
      if (peek().type === "op" && COMPARISONS.has(peek().value)) {
        throw new CalcError("compare two values at a time; split a chained comparison", peek().offset)
      }
      const a = number(left, op, "the left side")
      const b = number(right, op, "the right side")
      switch (op.value) {
        case "<":
          return a < b
        case "<=":
          return a <= b
        case ">":
          return a > b
        case ">=":
          return a >= b
        case "==":
          return a === b
        default:
          return a !== b
      }
    }
    return left
  }

  function sum() {
    let value = product()
    while (isOp("+") || isOp("-")) {
      const op = next()
      const a = number(value, op, "the left side")
      const b = number(product(), op, "the right side")
      value = note(op.value === "+" ? a + b : a - b, op.offset)
    }
    return value
  }

  function product() {
    let value = unary()
    while (isOp("*") || isOp("/") || isOp("//") || isOp("%")) {
      const op = next()
      const a = number(value, op, "the left side")
      const b = number(unary(), op, "the right side")
      if (op.value !== "*" && b === 0) throw new CalcError("division by zero", op.offset)
      if (op.value === "*") value = a * b
      else if (op.value === "/") value = a / b
      else if (op.value === "//") value = Math.floor(a / b)
      else value = a - b * Math.floor(a / b)
      value = note(value, op.offset)
    }
    return value
  }

  function unary() {
    if (isOp("-") || isOp("+")) {
      const op = next()
      enter(op)
      const value = number(unary(), op, "the operand")
      depth -= 1
      return op.value === "-" ? -value : value
    }
    return power()
  }

  function power() {
    const base = atom()
    if (isOp("**")) {
      const op = next()
      enter(op)
      const a = number(base, op, "the base")
      const b = number(unary(), op, "the exponent")
      depth -= 1
      return note(a ** b, op.offset)
    }
    return base
  }

  function call(nameToken) {
    const [arity, fn] = FUNCTIONS.get(nameToken.value)
    const open = expect("(")
    enter(open)
    const args = []
    if (!isOp(")")) {
      args.push(number(comparison(), nameToken, "an argument"))
      while (isOp(",")) {
        next()
        args.push(number(comparison(), nameToken, "an argument"))
      }
    }
    expect(")")
    depth -= 1
    if (arity === -1 ? args.length === 0 : args.length !== arity) {
      const wanted = arity === -1 ? "one or more arguments" : `${arity} argument${arity === 1 ? "" : "s"}`
      throw new CalcError(`${nameToken.value} takes ${wanted}, got ${args.length}`, nameToken.offset)
    }
    const domainError = DOMAIN_CHECKS[nameToken.value]?.(args[0])
    if (domainError) throw new CalcError(domainError, nameToken.offset)
    return note(fn(...args), nameToken.offset)
  }

  function atom() {
    const token = next()
    if (token.type === "number") return note(token.value, token.offset)
    if (token.type === "name") {
      if (FUNCTIONS.has(token.value)) return call(token)
      if (isOp("(")) throw new CalcError(`unknown function "${token.value}"`, token.offset)
      const bound = bindings.get(token.value)
      if (!bound) throw new CalcError(`unknown name "${token.value}"`, token.offset)
      if (bound.inexact) inexact = true
      return bound.value
    }
    if (token.type === "op" && token.value === "(") {
      enter(token)
      const value = comparison()
      expect(")")
      depth -= 1
      return value
    }
    throw new CalcError(`expected a number, a name or "(" but found ${describe(token)}`, token.offset)
  }

  let name
  if (peek().type === "name" && tokens[pos + 1]?.type === "op" && tokens[pos + 1].value === "=") {
    const nameToken = next()
    if (FUNCTIONS.has(nameToken.value)) {
      throw new CalcError(`"${nameToken.value}" is a function; bind the value to another name`, nameToken.offset)
    }
    next()
    name = nameToken.value
  }
  const value = comparison()
  if (peek().type !== "eof") {
    throw new CalcError(`unexpected ${describe(peek())}`, peek().offset)
  }
  return { name, value, inexact }
}

// ---- output ------------------------------------------------------------------

function group(digits) {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, "_")
}

// One value as the tool prints it: a comparison as true/false; an integer as
// its exact decimal, plus the grouped form where it has more than three digits
// and hex where it is at least 256; any other number to 15 significant digits.
export function formatCalcValue(value) {
  if (typeof value === "boolean") return String(value)
  if (Object.is(value, -0)) return "0"
  if (!Number.isInteger(value)) return String(Number(value.toPrecision(15)))
  const negative = value < 0
  const magnitude = BigInt(Math.abs(value))
  const sign = negative ? "-" : ""
  const plain = `${sign}${magnitude.toString()}`
  const forms = []
  if (magnitude >= 1000n) forms.push(`${sign}${group(magnitude.toString())}`)
  if (magnitude >= 256n) forms.push(`${sign}0x${magnitude.toString(16).toUpperCase()}`)
  return forms.length > 0 ? `${plain} (${forms.join(", ")})` : plain
}

// ---- entry point ---------------------------------------------------------------

// Evaluates `text` and answers the tool's text: one line per statement, or one
// `calc: … at column <n>` line. Pure; never throws.
export function evaluateCalc(text) {
  try {
    const input = typeof text === "string" ? text : ""
    if (input.length > CALC_MAX_INPUT_CHARS) {
      throw new CalcError(`the input is longer than ${CALC_MAX_INPUT_CHARS} characters`, CALC_MAX_INPUT_CHARS)
    }
    const tokens = tokenize(input)
    const statements = []
    let current = []
    for (const token of tokens) {
      if (token.type === "end" || token.type === "eof") {
        if (current.length > 0) {
          if (statements.length === CALC_MAX_STATEMENTS) {
            throw new CalcError(`more than ${CALC_MAX_STATEMENTS} statements`, current[0].offset)
          }
          statements.push([...current, { type: "eof", value: "", offset: token.offset }])
        }
        current = []
        continue
      }
      current.push(token)
    }
    if (statements.length === 0) throw new CalcError("the expression is empty", 0)
    const bindings = new Map()
    const lines = []
    for (const statement of statements) {
      const { name, value, inexact } = evaluateStatement(statement, bindings)
      if (name !== undefined) bindings.set(name, { value, inexact })
      const shown = formatCalcValue(value) + (inexact ? " (not exact: beyond 2^53)" : "")
      lines.push(name !== undefined ? `${name} = ${shown}` : shown)
    }
    return lines.join("\n")
  } catch (err) {
    if (err instanceof CalcError) return `calc: ${err.message} at column ${err.offset + 1}`
    return `calc: ${err?.message ?? String(err)} at column 1`
  }
}

export function isCalcEnabled() {
  return process.env.OPENCODE_AGENT_INTERCOM_DISABLE_CALC !== "1"
}

export function createCalcTool() {
  return tool({
    description:
      "Exact arithmetic on numbers you already hold — sizes, budgets, offsets, token sums. " +
      "Answers at once. Write one or more statements, separated by `;` or new lines; " +
      "`name = expr` keeps a value for the later statements. " +
      "Operators: + - * / // % ** and parentheses; comparisons < <= > >= == != answer true or false. " +
      "Functions: min max abs floor ceil round sqrt log2 log10 ln pow. " +
      "Numbers take `_` separators, exponents, 0x and 0b, and the suffixes k M G T (×1000) and Ki Mi Gi Ti (×1024). " +
      "An error comes back as a line naming its column: correct it and call again.",
    args: {
      expression: z
        .string()
        .describe("The statements to compute. Example: budget = 200k; used = 204_000; used <= budget"),
    },
    execute: async (args) => ({ output: evaluateCalc(args?.expression) }),
  })
}
