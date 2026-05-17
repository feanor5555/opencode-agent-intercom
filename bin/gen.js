#!/usr/bin/env node
// `gen` — minimal image-generation CLI for the `designer` subagent.
//
// Two free, no-key-required backends:
//
//   1. Stable Horde (default) — crowdsourced SD/FLUX workers via
//      stablehorde.net. Anonymous via dummy key "0000000000". Real SDXL /
//      FLUX models, larger images possible (multiples of 64). Slower:
//      async submit → poll queue → download (typical 20-90 s).
//
//   2. Pollinations (fallback) — synchronous endpoint
//      https://image.pollinations.ai/prompt/{prompt}. Fast (~3-10 s) but
//      currently only exposes one model (sana) and the anonymous tier is
//      hard-capped at 1024 px on the longest side. Pollinations registers a
//      free account at https://auth.pollinations.ai to lift the cap; set
//      $POLLINATIONS_TOKEN to use it.
//
// The dispatcher (`--backend auto`, default) tries Horde first; if Horde
// fails or times out, it falls back to Pollinations automatically.
//
// Use: `gen "<prompt>" [--out <path>] [--width N] [--height N] [--seed N]
//                       [--model <name>] [--backend <auto|horde|pollinations>]
//                       [--timeout <seconds>] [--token <pollinations-key>]`

import fs from "node:fs"
import path from "node:path"

const POLL_ENDPOINT = "https://image.pollinations.ai/prompt/"
const POLL_ANON_MAX = 1024
// Pollinations currently exposes only the `sana` model on its anonymous tier
// — the documented `flux` / `turbo` / `sdxl` names map back to `sana` silently.
// Default to the name that actually serves so the request matches the log.
const POLL_DEFAULT_MODEL = "sana"

const HORDE_BASE = "https://stablehorde.net/api/v2"
const HORDE_ANON_KEY = "0000000000"
const HORDE_CLIENT_AGENT = "opencode-agent-intercom:1.0:https://github.com/feanor5555/opencode-agent-intercom"
const HORDE_DEFAULT_TIMEOUT_MS = 120_000
// Worker preference: common high-quality models. Empty list = any worker; the
// listed names target FLUX and SDXL workers which dominate the public horde.
const HORDE_DEFAULT_MODELS = ["Flux.1-Schnell fp8 (Compact)", "AlbedoBase XL", "SDXL 1.0"]

const argv = process.argv.slice(2)
if (!argv.length || argv[0] === "-h" || argv[0] === "--help") {
  printHelp()
  process.exit(argv.length ? 0 : 1)
}

const opts = parseArgs(argv)
if (!opts) process.exit(2)

await dispatch(opts)

// ─── dispatcher ────────────────────────────────────────────────────────────

async function dispatch(opts) {
  if (opts.backend === "pollinations") return generatePollinations(opts)
  if (opts.backend === "horde") return generateHorde(opts)
  // auto: try horde first, fall back to pollinations
  try {
    return await generateHorde(opts)
  } catch (err) {
    console.warn(`gen: horde failed (${err.message}) — falling back to pollinations`)
    return generatePollinations(opts)
  }
}

// ─── horde backend ─────────────────────────────────────────────────────────

async function generateHorde({ prompt, out, width, height, seed, timeoutMs }) {
  // Horde requires width/height to be multiples of 64.
  const w = roundTo64(width)
  const h = roundTo64(height)

  // Steps low enough to satisfy anonymous-tier quota across all workers
  // (anonymous users are 403'd above ~15 steps on the FLUX workers).
  // FLUX-Schnell converges in 4 steps, SDXL is fine at 12. Keep cfg moderate.
  const body = {
    prompt,
    params: {
      width: w,
      height: h,
      steps: 8,
      cfg_scale: 5,
      sampler_name: "k_euler",
      n: 1,
      ...(seed != null ? { seed: String(seed) } : {}),
    },
    models: HORDE_DEFAULT_MODELS,
    nsfw: false,
    censor_nsfw: false,
    r2: true,
  }

  console.log(`gen: horde submit ${w}x${h}${seed != null ? ` seed=${seed}` : ""}${w !== width || h !== height ? ` (rounded from ${width}x${height})` : ""}`)
  const submit = await fetch(`${HORDE_BASE}/generate/async`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: HORDE_ANON_KEY,
      "Client-Agent": HORDE_CLIENT_AGENT,
    },
    body: JSON.stringify(body),
  })
  if (!submit.ok) {
    const text = await submit.text().catch(() => "")
    throw new Error(`submit ${submit.status} ${text.slice(0, 200)}`)
  }
  const { id, message } = await submit.json()
  if (!id) throw new Error(`no id in submit response: ${message ?? "(none)"}`)

  // Poll the cheap /check endpoint until done.
  const deadline = Date.now() + (timeoutMs ?? HORDE_DEFAULT_TIMEOUT_MS)
  let lastReport = 0
  while (Date.now() < deadline) {
    await sleep(3000)
    const check = await fetch(`${HORDE_BASE}/generate/check/${id}`, {
      headers: { "Client-Agent": HORDE_CLIENT_AGENT },
    })
    if (!check.ok) continue  // transient
    const s = await check.json()
    const now = Date.now()
    if (now - lastReport > 5000) {
      console.log(`gen: horde queue_pos=${s.queue_position ?? "?"} wait=${s.wait_time ?? "?"}s done=${s.done}`)
      lastReport = now
    }
    if (s.faulted) throw new Error("generation faulted on horde")
    if (s.done) break
  }
  if (Date.now() >= deadline) {
    // Best-effort cancel so we don't leave a request hanging in the queue.
    fetch(`${HORDE_BASE}/generate/status/${id}`, {
      method: "DELETE",
      headers: { apikey: HORDE_ANON_KEY, "Client-Agent": HORDE_CLIENT_AGENT },
    }).catch(() => {})
    throw new Error(`timed out after ${(timeoutMs ?? HORDE_DEFAULT_TIMEOUT_MS) / 1000}s in queue`)
  }

  const status = await fetch(`${HORDE_BASE}/generate/status/${id}`, {
    headers: { "Client-Agent": HORDE_CLIENT_AGENT },
  })
  if (!status.ok) throw new Error(`status ${status.status}`)
  const data = await status.json()
  const gen = data.generations?.[0]
  if (!gen?.img) throw new Error("no image url in status response")

  const imgRes = await fetch(gen.img)
  if (!imgRes.ok) throw new Error(`image download ${imgRes.status}`)
  const buf = Buffer.from(await imgRes.arrayBuffer())
  const final = matchExtensionToContent(out, imgRes.headers.get("content-type"), buf)
  fs.mkdirSync(path.dirname(final), { recursive: true })
  fs.writeFileSync(final, buf)
  console.log(`gen: horde ${(buf.length / 1024).toFixed(1)} KB → ${final} (worker: ${gen.worker_name ?? "?"}, model: ${gen.model ?? "?"})`)
}

function roundTo64(n) {
  return Math.max(64, Math.round(n / 64) * 64)
}

// ─── pollinations backend ──────────────────────────────────────────────────

async function generatePollinations({ prompt, out, width, height, model, seed, token }) {
  // Without a token, pollinations silently downscales anything past 1024 px on
  // the longest side. Clamp here proactively so the printed dimensions match
  // what is actually saved.
  if (!token) {
    const longest = Math.max(width, height)
    if (longest > POLL_ANON_MAX) {
      const scale = POLL_ANON_MAX / longest
      const cw = Math.round(width * scale)
      const ch = Math.round(height * scale)
      console.log(`gen: pollinations anonymous tier capped at ${POLL_ANON_MAX}px — clamping ${width}x${height} → ${cw}x${ch} (set POLLINATIONS_TOKEN to lift)`)
      width = cw
      height = ch
    }
  }

  const url = new URL(POLL_ENDPOINT + encodeURIComponent(prompt))
  url.searchParams.set("width", String(width))
  url.searchParams.set("height", String(height))
  url.searchParams.set("model", model)
  url.searchParams.set("nologo", "true")
  if (seed != null) url.searchParams.set("seed", String(seed))

  const headers = token ? { Authorization: `Bearer ${token}` } : undefined
  const auth = token ? " (auth)" : ""
  console.log(`gen: pollinations ${width}x${height} ${model}${seed != null ? ` seed=${seed}` : ""}${auth}`)
  let res
  try {
    res = await fetch(url, headers ? { headers } : undefined)
  } catch (err) {
    console.error(`gen: pollinations network error — ${err.message}`)
    process.exit(1)
  }
  if (!res.ok) {
    console.error(`gen: pollinations ${res.status} ${res.statusText}`)
    process.exit(1)
  }
  const buf = Buffer.from(await res.arrayBuffer())
  const final = matchExtensionToContent(out, res.headers.get("content-type"), buf)
  fs.mkdirSync(path.dirname(final), { recursive: true })
  fs.writeFileSync(final, buf)
  console.log(`gen: pollinations ${(buf.length / 1024).toFixed(1)} KB → ${final}`)
}

// ─── arg parsing ───────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = {
    prompt: "",
    out: null,
    width: 1024,
    height: 1024,
    model: POLL_DEFAULT_MODEL,
    seed: null,
    backend: "auto",
    token: process.env.POLLINATIONS_TOKEN || null,
    timeoutMs: null,
  }
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      const v = argv[++i]
      if (v == null) { console.error(`gen: ${a} expects a value`); return null }
      return v
    }
    if (a === "--out" || a === "-o") { const v = next(); if (v == null) return null; opts.out = v }
    else if (a === "--width") { const v = next(); if (v == null) return null; opts.width = Number(v) }
    else if (a === "--height") { const v = next(); if (v == null) return null; opts.height = Number(v) }
    else if (a === "--model") { const v = next(); if (v == null) return null; opts.model = v }
    else if (a === "--seed") { const v = next(); if (v == null) return null; opts.seed = Number(v) }
    else if (a === "--backend") {
      const v = next(); if (v == null) return null
      if (!["auto", "horde", "pollinations"].includes(v)) { console.error(`gen: --backend must be one of auto|horde|pollinations (got ${v})`); return null }
      opts.backend = v
    }
    else if (a === "--token") { const v = next(); if (v == null) return null; opts.token = v }
    else if (a === "--timeout") { const v = next(); if (v == null) return null; opts.timeoutMs = Number(v) * 1000 }
    else if (a.startsWith("--")) { console.error(`gen: unknown flag ${a}`); return null }
    else positional.push(a)
  }
  if (!positional.length) { console.error("gen: missing <prompt>"); return null }
  opts.prompt = positional.join(" ")
  if (!Number.isFinite(opts.width) || opts.width <= 0) { console.error("gen: --width must be a positive number"); return null }
  if (!Number.isFinite(opts.height) || opts.height <= 0) { console.error("gen: --height must be a positive number"); return null }
  if (opts.seed != null && !Number.isFinite(opts.seed)) { console.error("gen: --seed must be a number"); return null }
  if (opts.timeoutMs != null && !Number.isFinite(opts.timeoutMs)) { console.error("gen: --timeout must be a number (seconds)"); return null }
  if (!opts.out) opts.out = `gen-${Date.now()}.jpg`
  opts.out = path.resolve(opts.out)
  return opts
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

// Rewrite the output path to match the actual image format. Backends may
// return WebP even when the caller asks for `.jpg`, so the saved file would
// otherwise be a mislabelled blob (cosmetic for browsers, but confusing for
// LLMs and tooling that trusts the extension). Detection: prefer the
// Content-Type header, fall back to magic bytes.
function matchExtensionToContent(out, contentType, buf) {
  const ext =
    detectFromContentType(contentType) ??
    detectFromMagic(buf)
  if (!ext) return out
  const current = path.extname(out).slice(1).toLowerCase()
  const norm = current === "jpeg" ? "jpg" : current
  if (norm === ext) return out
  const renamed = out.replace(/\.[^./]+$/, `.${ext}`)
  if (renamed === out) return out + `.${ext}`
  console.log(`gen: response is ${ext} — saving to ${renamed} (asked for .${current || "?"})`)
  return renamed
}

function detectFromContentType(ct) {
  if (!ct) return null
  const c = ct.toLowerCase()
  if (c.includes("webp")) return "webp"
  if (c.includes("png")) return "png"
  if (c.includes("jpeg") || c.includes("jpg")) return "jpg"
  if (c.includes("gif")) return "gif"
  return null
}

function detectFromMagic(buf) {
  if (!buf || buf.length < 12) return null
  if (buf[0] === 0xff && buf[1] === 0xd8) return "jpg"
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png"
  if (buf.slice(0, 4).toString() === "RIFF" && buf.slice(8, 12).toString() === "WEBP") return "webp"
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return "gif"
  return null
}

function printHelp() {
  process.stdout.write(`gen — image generation for the designer subagent

  gen "<prompt>" [options]

Options:
  --out, -o <path>           output file (default: ./gen-<timestamp>.jpg)
  --width <px>               image width  (default: 1024)
  --height <px>              image height (default: 1024)
  --seed <n>                 deterministic seed (default: random)
  --backend <auto|horde|pollinations>
                             which backend to use (default: auto — try horde,
                             fall back to pollinations on failure)
  --timeout <seconds>        max wait for the horde queue (default: 120)
  --model <name>             pollinations model only (default: sana)
  --token <key>              pollinations API key — also read from
                             $POLLINATIONS_TOKEN; lifts the anonymous 1024 cap

Backends:
  horde         stablehorde.net — real SDXL/FLUX workers, no key needed
                (uses anonymous "0000000000"). Slower (20-90 s typical) but
                better quality. Sizes are rounded to multiples of 64.
  pollinations  image.pollinations.ai — fast (~3-10 s) but currently
                exposes only one model (sana); anonymous output capped at
                1024 px on the longest side. Set $POLLINATIONS_TOKEN to
                lift the cap (free signup at auth.pollinations.ai).

Common aspect ratios for UI work:
  square      --width 1024 --height 1024
  16:9 hero   --width 1920 --height 1080
  9:16 phone  --width 1080 --height 1920
  4:3 tablet  --width 1600 --height 1200
`)
}
