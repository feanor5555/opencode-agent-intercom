// Unit tests for the reply token ceiling's foundation: the conservative
// estimator and the truncation in src/format.js, and the overflow file in
// src/resultfile.js.
//
// What the ceiling promises is that no text is ever lost: the part of a
// subagent's final reply that does not reach the orchestrator's context is
// written to a file whose path the notice carries. So the assertions here are
// (a) the kept prefix is provably at or under the ceiling in the estimator's
// own unit, (b) the file holds the reply byte for byte INCLUDING the cut part,
// and (c) a write that fails still yields a usable notice text.
//
// The two wake paths in src/hooks.js are covered where they are driven end to
// end (test/plugin.test.js, test/result-recovery.test.js,
// test/nested-delegation.test.js); what stands here is the modules plus the
// wiring that is not a wake — the uncapped fetch, the prompt block, and the
// prune at plugin load.
//
// HOME is repointed at a temp dir so the real ~/.cache is never touched:
// os.homedir() reads $HOME on POSIX, and cacheDir() resolves it per call.
//
// Run: node --test --test-timeout=5000 test/result-token-ceiling.test.js

import test from "node:test"
import assert from "node:assert/strict"
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  statSync,
  existsSync,
  readdirSync,
  utimesSync,
  rmSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { estimateReplyTokens, estimateTokens, cutToTokens } from "../src/format.js"
import {
  RESULT_FILE_TTL_MS,
  resultsDir,
  resultFileName,
  writeOverflow,
  capReplyForAgent,
  pruneResultFiles,
} from "../src/resultfile.js"
import { setSettingsPath, resetSettings } from "../src/settings.js"
import { fetchSnapshot } from "../src/client.js"
import plugin from "../src/index.js"
import { _stopWatchdogForTests } from "../src/watchdog.js"
import { guideBlocks, replyCapBlock, SUBAGENT_GUIDE_CORE } from "../src/prompts.js"

const ENV_NAME = "OPENCODE_AGENT_INTERCOM_MAX_RESULT_TOKENS"
const realHome = process.env.HOME
const dirs = []

// A fresh HOME (so a fresh results dir) and a fresh settings file per test.
// Both are pointed at temp dirs; nothing here reads the developer's own state.
function isolate(fileContent) {
  const home = mkdtempSync(join(tmpdir(), "intercom-result-home-"))
  const cfg = mkdtempSync(join(tmpdir(), "intercom-result-cfg-"))
  dirs.push(home, cfg)
  process.env.HOME = home
  delete process.env[ENV_NAME]
  const settingsFile = join(cfg, "agent-intercom.json")
  if (fileContent !== undefined) writeFileSync(settingsFile, JSON.stringify(fileContent))
  setSettingsPath(settingsFile)
  resetSettings()
  return home
}

test.after(() => {
  process.env.HOME = realHome
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------- estimator

// No tokenizer is in the tree and none is added, so the reference each sample
// is measured against is a computed PROXY, not a BPE count: whitespace words
// for prose, lexical atoms (identifier runs and single symbols) for code, and
// code points for CJK, which is exact — every CJK code point costs at least one
// token in every tokenizer in use. All three are lower bounds on what a real
// BPE emits, and the estimator's contract is that it never falls below them.
function wordProxy(text) {
  return text.trim().split(/\s+/).length
}
function atomProxy(text) {
  return (text.match(/[A-Za-z0-9_]+|[^\sA-Za-z0-9_]/g) ?? []).length
}

test("estimateReplyTokens runs at or above a reference count for prose, code and CJK", () => {
  const prose =
    "The orchestrator spawns a subagent, waits for nothing, and is woken when " +
    "the subagent finishes its work and reports back with its findings."
  assert.ok(
    estimateReplyTokens(prose) >= wordProxy(prose),
    `prose estimate ${estimateReplyTokens(prose)} < ${wordProxy(prose)}`,
  )

  const code =
    "export function resultCeilingFor(agent) {\n  const s = getSettings()\n  return s.maxResultTokens\n}\n"
  assert.ok(
    estimateReplyTokens(code) >= atomProxy(code),
    `code estimate ${estimateReplyTokens(code)} < ${atomProxy(code)}`,
  )

  // The case chars/4 gets wrong by a factor of three: one CJK code point is at
  // least one token for every tokenizer in use, and often more than one.
  const cjk = "文字化けの原因を調べる"
  assert.equal(estimateReplyTokens(cjk), [...cjk].length)
  assert.ok(
    estimateReplyTokens(cjk) > estimateTokens(cjk),
    "the reply estimator must not underestimate CJK the way chars/4 does",
  )
})

test("estimateReplyTokens is 0 for empty input and counts a surrogate pair once", () => {
  assert.equal(estimateReplyTokens(""), 0)
  assert.equal(estimateReplyTokens(null), 0)
  assert.equal(estimateReplyTokens(undefined), 0)
  // "🔔" is one code point in two UTF-16 units — one token, not two.
  assert.equal(estimateReplyTokens("🔔"), 1)
  assert.equal(estimateReplyTokens("a".repeat(7)), 2) // ceil(7 / 3.5)
})

// -------------------------------------------------------------- cutToTokens

test("cutToTokens keeps a prefix at or under the ceiling, down to a ceiling of 1", () => {
  const text = "a".repeat(1000)
  for (const ceiling of [1, 2, 7, 100, 285]) {
    const { kept, omittedTokens } = cutToTokens(text, ceiling)
    assert.ok(
      estimateReplyTokens(kept) <= ceiling,
      `ceiling ${ceiling}: kept estimates ${estimateReplyTokens(kept)}`,
    )
    assert.ok(omittedTokens > 0, `ceiling ${ceiling} must have cut something`)
    assert.equal(
      omittedTokens,
      estimateReplyTokens(text) - estimateReplyTokens(kept),
      "the omitted count is the difference of the two estimates",
    )
  }
})

test("cutToTokens leaves an exactly-at-ceiling text alone and cuts one code point over", () => {
  const atCeiling = "a".repeat(35) // ceil(35 / 3.5) = 10 tokens exactly
  assert.equal(estimateReplyTokens(atCeiling), 10)
  assert.deepEqual(cutToTokens(atCeiling, 10), { kept: atCeiling, omittedTokens: 0 })

  const over = atCeiling + "b" // 36 ASCII chars -> ceil(36 / 3.5) = 11
  assert.equal(estimateReplyTokens(over), 11)
  const cut = cutToTokens(over, 10)
  assert.equal(cut.omittedTokens, 1)
  assert.ok(estimateReplyTokens(cut.kept) <= 10)
  assert.ok(over.startsWith(cut.kept), "the kept text is a prefix of the original")
})

test("cutToTokens never splits a surrogate pair and treats ceiling 0 as no ceiling", () => {
  const text = "🔔".repeat(50)
  const { kept } = cutToTokens(text, 10)
  assert.equal([...kept].length, 10)
  assert.equal(kept, "🔔".repeat(10))
  // No lone surrogate survives the cut.
  assert.equal(kept.length % 2, 0)

  assert.deepEqual(cutToTokens(text, 0), { kept: text, omittedTokens: 0 })
  assert.deepEqual(cutToTokens("", 5), { kept: "", omittedTokens: 0 })
})

// ------------------------------------------------------------ overflow file

const META = {
  handle: "researcher#1",
  agent: "researcher",
  sessionID: "ses_7c1f",
  taskId: "T5",
}

function onlyResultFile(home) {
  const dir = join(home, ".cache", "opencode-agent-intercom", "results")
  const names = readdirSync(dir)
  assert.equal(names.length, 1, `expected one result file, found ${names.join(", ")}`)
  return join(dir, names[0])
}

test("a reply over the ceiling: marker with the path, file 0600, body byte-identical", () => {
  const home = isolate({ maxResultTokens: 100 })
  const reply = "finding: the loader resolves plugins once.\n" + "x".repeat(5000)

  const capped = capReplyForAgent(reply, META)

  assert.equal(capped.cut, true)
  assert.equal(capped.error, null)
  assert.match(capped.text, /\[cut at 100 tokens — \d+ more tokens of this reply are not shown here\./)
  assert.ok(capped.text.includes(capped.path), "the marker carries the file path")
  assert.ok(
    capped.text.startsWith("finding: the loader resolves plugins once."),
    "the kept prefix is the reply's own opening",
  )
  assert.ok(
    capped.text.includes("You cannot read that file yourself"),
    "the orchestrator is told it cannot read the file itself",
  )
  assert.ok(capped.text.includes("the subagent's session is gone"))

  const file = onlyResultFile(home)
  assert.equal(file, capped.path)
  assert.equal(file, join(resultsDir(), "researcher-1-ses_7c1f.md"))
  assert.equal(statSync(file).mode & 0o777, 0o600, "the overflow file is user-only")
  assert.equal(statSync(join(resultsDir())).mode & 0o777, 0o700, "the results dir is user-only")

  const written = readFileSync(file, "utf8")
  const [header, body] = splitAtSeparator(written)
  assert.equal(body, reply, "the file holds the reply in full, cut part included")
  assert.match(header, /^# subagent result — researcher#1 \(researcher\)\n/)
  assert.match(header, /\nsession: ses_7c1f\n/)
  assert.match(header, /\nfinished: \d{4}-\d\d-\d\dT[\d:.]+Z\n/)
  assert.match(header, /\ntask: T5\n/)
  assert.match(header, /\nsize: ~\d+ tokens \(estimated\), cut to 100 in the orchestrator's notice\n/)
})

// Everything after the first "\n---\n\n" is the reply verbatim.
function splitAtSeparator(written) {
  const sep = "\n---\n\n"
  const at = written.indexOf(sep)
  assert.ok(at > 0, "the file carries the header/body separator")
  return [written.slice(0, at + 1), written.slice(at + sep.length)]
}

test("a reply under the ceiling passes verbatim and writes no file", () => {
  const home = isolate({ maxResultTokens: 2000 })
  const reply = "done. see src/hooks.js:1345 for the idle path."

  const capped = capReplyForAgent(reply, META)

  assert.deepEqual(capped, { text: reply, path: null, error: null, cut: false })
  assert.equal(existsSync(join(home, ".cache", "opencode-agent-intercom", "results")), false)
})

test("the task line is omitted where the spawn carried no T<n> prefix", () => {
  isolate({ maxResultTokens: 10 })
  const capped = capReplyForAgent("y".repeat(500), { ...META, taskId: undefined })
  const written = readFileSync(capped.path, "utf8")
  assert.equal(written.includes("\ntask:"), false)
})

test("a per-type entry raises the ceiling for that type alone", () => {
  isolate({ maxResultTokens: 100, resultTokens: { researcher: 20000 } })
  const reply = "z".repeat(5000) // ~1429 estimated tokens

  const raised = capReplyForAgent(reply, META)
  assert.equal(raised.cut, false)
  assert.equal(raised.text, reply)
  assert.equal(raised.path, null)

  const plain = capReplyForAgent(reply, { ...META, agent: "coder", handle: "coder#2" })
  assert.equal(plain.cut, true)
  assert.match(plain.text, /\[cut at 100 tokens/)
})

test("resultTokens 0 for a type: no cut, no file, no marker", () => {
  const home = isolate({ maxResultTokens: 100, resultTokens: { researcher: 0 } })
  const reply = "q".repeat(9000)

  const capped = capReplyForAgent(reply, META)

  assert.deepEqual(capped, { text: reply, path: null, error: null, cut: false })
  assert.equal(existsSync(join(home, ".cache", "opencode-agent-intercom", "results")), false)
})

test("a failed write yields the not-filed marker naming the reason, and still a usable text", () => {
  const home = isolate({ maxResultTokens: 50 })
  // The results dir's place is taken by a plain file: the mkdir fails, and so
  // does every write beneath it.
  mkdirSync(join(home, ".cache", "opencode-agent-intercom"), { recursive: true, mode: 0o700 })
  writeFileSync(join(home, ".cache", "opencode-agent-intercom", "results"), "not a directory")

  const capped = capReplyForAgent("w".repeat(4000), META)

  assert.equal(capped.cut, true)
  assert.equal(capped.path, null)
  assert.ok(capped.error, "the failure reason comes back on the result")
  assert.match(capped.text, /\[cut at 50 tokens — \d+ more tokens/)
  assert.ok(capped.text.includes("the overflow file could not be written"))
  assert.ok(capped.text.includes(capped.error), "the marker names the reason verbatim")
  assert.ok(capped.text.includes("exists only in subagent session ses_7c1f"))
  assert.ok(capped.text.startsWith("w"), "the kept prefix still reaches the orchestrator")
})

test("retention granted: the marker names reuse and the file is written all the same", () => {
  const home = isolate({ maxResultTokens: 50 })

  const capped = capReplyForAgent("r".repeat(4000), { ...META, retained: true })

  assert.equal(capped.cut, true)
  assert.ok(capped.text.includes('reuse("researcher#1", "…") can ask it about the cut part'))
  assert.equal(capped.text.includes("the subagent's session is gone"), false)
  assert.equal(readFileSync(onlyResultFile(home), "utf8").endsWith("r".repeat(4000)), true)
})

test("a follow-up run of a held session gets its own file", () => {
  isolate({ maxResultTokens: 50 })
  assert.equal(resultFileName({ handle: "researcher#1", sessionID: "ses_1" }), "researcher-1-ses_1.md")
  assert.equal(resultFileName({ handle: "researcher#1", sessionID: "ses_1", runs: 1 }), "researcher-1-ses_1.md")
  assert.equal(resultFileName({ handle: "researcher#1", sessionID: "ses_1", runs: 3 }), "researcher-1-ses_1-run3.md")

  const first = capReplyForAgent("a".repeat(4000), META)
  const second = capReplyForAgent("b".repeat(4000), { ...META, runs: 2 })
  assert.notEqual(first.path, second.path)
  assert.ok(second.path.endsWith("-run2.md"))
  assert.ok(readFileSync(first.path, "utf8").endsWith("a".repeat(4000)), "the first run's file survives")
})

test("a handle carrying path characters cannot steer the file out of the results dir", () => {
  isolate({ maxResultTokens: 50 })
  const capped = capReplyForAgent("p".repeat(4000), {
    ...META,
    handle: "../../etc/passwd",
    sessionID: "ses/../x",
  })
  // The separators are gone, so what is left is a single file NAME: the dots
  // that survive cannot traverse without one.
  assert.equal(capped.path, join(resultsDir(), "..-..-etc-passwd-ses-..-x.md"))
  assert.equal(capped.path.includes("/etc/passwd"), false)
  assert.equal(existsSync(capped.path), true)
  assert.deepEqual(readdirSync(resultsDir()), ["..-..-etc-passwd-ses-..-x.md"])
})

test("writeOverflow reports its failure instead of throwing", () => {
  const home = isolate({})
  writeFileSync(join(home, "blocked"), "")
  // A cache dir that is a file: mkdir and write both fail, nothing throws.
  mkdirSync(join(home, ".cache"), { recursive: true })
  writeFileSync(join(home, ".cache", "opencode-agent-intercom"), "not a directory")
  const out = writeOverflow({ ...META, text: "x", ceiling: 10 })
  assert.equal(out.path, undefined)
  assert.ok(out.error)
})

// --------------------------------------------------------------- the prune

test("pruneResultFiles drops a file past the TTL and keeps a fresh one", () => {
  const home = isolate({ maxResultTokens: 50 })
  const stale = capReplyForAgent("s".repeat(4000), { ...META, sessionID: "ses_old" }).path
  const fresh = capReplyForAgent("f".repeat(4000), { ...META, sessionID: "ses_new" }).path

  const old = (Date.now() - RESULT_FILE_TTL_MS - 60000) / 1000
  utimesSync(stale, old, old)

  assert.equal(pruneResultFiles(), 1)
  assert.equal(existsSync(stale), false)
  assert.equal(existsSync(fresh), true)
  // A second pass has nothing left to do.
  assert.equal(pruneResultFiles(), 0)
  assert.equal(readdirSync(join(home, ".cache", "opencode-agent-intercom", "results")).length, 1)
})

test("pruneResultFiles is 0 and silent where the results dir does not exist", () => {
  isolate({})
  assert.equal(pruneResultFiles(), 0)
})

test("RESULT_FILE_TTL_MS is seven days", () => {
  assert.equal(RESULT_FILE_TTL_MS, 7 * 24 * 3600 * 1000)
})

// ------------------------------------------------------------- the wiring

// Where the ceiling is NOT applied. `fetchSnapshot` used to cap inside the
// fetch, which reached every caller — including the one that never pushes the
// text into a context: the handoff's open-points / doc-summaries reply
// (handoffwiring.js `fetchResult`), which is PARSED into todo entries. A cut
// there loses open points, which is the loss the endless cycle exists to
// prevent. The cap sits at the crossing points in hooks.js now, so the fetch
// hands back what the session said, whole.
test("fetchSnapshot does not cap: the open-points reply comes back whole", async () => {
  const home = isolate({ maxResultTokens: 50 })
  const reply = "OPEN POINTS\n" + "p".repeat(20000) + "\nLAST_POINT"
  const client = {
    session: {
      messages: async () => ({
        data: [
          {
            info: { role: "assistant", tokens: { input: 900, output: 10 } },
            parts: [{ type: "text", text: reply }],
          },
        ],
      }),
    },
  }

  const snap = await fetchSnapshot(client, "ses_primary")
  assert.equal(snap.result, reply, "the parsed reply must not be shortened")
  assert.equal(
    existsSync(join(home, ".cache", "opencode-agent-intercom", "results")),
    false,
    "a read must write no overflow file",
  )
})

// The prompt half of the split (§2.3). The block names the type's OWN figure,
// and a type whose ceiling is 0 is never cut, so it is told nothing at all.
test("the reply-cap block names the type's own ceiling and is absent at 0", () => {
  isolate({ maxResultTokens: 2000, resultTokens: { researcher: 20000, gitter: 0 } })

  assert.match(replyCapBlock("coder"), /at most ~2000 tokens \(~7000 characters\)/)
  assert.match(replyCapBlock("researcher"), /at most ~20000 tokens \(~70000 characters\)/)
  assert.equal(replyCapBlock("gitter"), "")

  // And through the assembly the transform really injects.
  const guide = guideBlocks({ agent: "coder", delegates: false })
  assert.ok(guide.includes(replyCapBlock("coder")), "the block belongs to the subagent branch")
  assert.doesNotMatch(
    guideBlocks({ agent: "gitter", delegates: false }),
    /your final reply is capped/,
  )
  // The primary is not capped and is never told about a ceiling of its own.
  assert.doesNotMatch(guideBlocks({ primary: true }), /your final reply is capped/)
})

// The figure moved out of the core block and into the per-type one, so the
// character cap's number must be gone from the shared text.
test("the guide core no longer names a character cap", () => {
  isolate({})
  assert.doesNotMatch(SUBAGENT_GUIDE_CORE, /8000|hard-capped/)
  assert.match(SUBAGENT_GUIDE_CORE, /Final reply: brief plain text\. Reference files by path:line/)
})

// Step 6: the prune runs at plugin load, on the next event-loop turn, so a
// results dir that survived a restart is bounded without anything on the wake
// path having to remove a file that is the only copy of its text. Once per
// process — this is the only plugin() call in this file, so it is this call
// that prunes.
test("the plugin's load prunes the results dir", async () => {
  const home = isolate({ maxResultTokens: 50 })
  const stale = capReplyForAgent("s".repeat(4000), { ...META, sessionID: "ses_old" }).path
  const old = (Date.now() - RESULT_FILE_TTL_MS - 60000) / 1000
  utimesSync(stale, old, old)

  const client = {
    session: {
      create: async () => ({ data: { id: "ses_child" } }),
      promptAsync: async () => ({ data: undefined }),
      list: async () => ({ data: [] }),
      delete: async () => ({ data: true }),
      get: async () => ({ data: { directory: home } }),
      messages: async () => ({ data: [] }),
    },
    tui: { showToast: async () => ({ data: true }) },
    config: { get: async () => ({ data: { agent: {} } }) },
  }
  await plugin({ client, directory: home, worktree: home, project: {} })
  // The prune is deferred to the next turn so it cannot hold up the factory.
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(existsSync(stale), false, "the stale overflow file survived the load")
  _stopWatchdogForTests()
})
