import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
  TuiSlotContext,
  TuiThemeCurrent,
} from "@opencode-ai/plugin/tui";
import type { BoxRenderable, KeyEvent } from "@opentui/core";
import {
  For,
  Show,
  createEffect,
  createMemo,
  createRoot,
  createSignal,
} from "solid-js";
import { readFileSync, writeFileSync, mkdirSync, existsSync, utimesSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

const TUI_PLUGIN_ID = "agent-intercom.tui";
const ELAPSED_TICK_MS = 1000;
// Toggle rate for the pulsing status dot of a busy subagent.
const PULSE_TICK_MS = 600;
const POLL_FALLBACK_MS = 5000;
const REFRESH_DEBOUNCE_MS = 250;
const TOKEN_REFRESH_MS = 8000;
// Press-and-hold on +/- buttons. After firing once on mousedown we wait for
// HOLD_DELAY (so a tap is just a single increment), then auto-repeat every
// INTERVAL ms. Both timers cancel on mouseup or mouseout so moving the cursor
// off the button reliably stops the run — terminals can drop button-release
// events under load.
const HOLD_REPEAT_DELAY_MS = 350;
const HOLD_REPEAT_INTERVAL_MS = 60;
const FOCUS_LIST_COMMAND = "agent-intercom.focus-sidebar-list";
const ABORT_COMMAND = "agent-intercom.abort-selected";

// Shared with the main agent-intercom plugin: it reads this file (file > env >
// default) for the subagent cap and context budget. Writing it here changes
// those limits live, no opencode restart needed.
const SETTINGS_PATH = join(homedir(), ".config", "opencode", "agent-intercom.json");
const DEFAULT_MAX_SUBAGENTS = 1;
const DEFAULT_MAX_CONTEXT = 40000;

// Shared with the main plugin's chat.params hook: per-agent LLM parameter
// overrides. Each agent is configured individually (no "*" global fallback;
// legacy "*" blocks are dropped on read). Writing this file makes the next
// LLM request pick up the new values — no opencode restart.
const LLM_PARAMS_PATH = join(homedir(), ".config", "opencode", "llm-params.json");

// Per-project, per-agent prompt overrides. The main plugin reads each file at
// every LLM call (mtime-cached) — touching them via `utimesSync` busts that
// cache without editing the body. Directory resolved against `process.cwd()`:
// opencode serve's working directory, which for the common single-project
// workflow is the project root. Run `npx opencode-agent-intercom-init-prompts`
// to seed the directory with defaults (one .md per agent).
const PROMPTS_DIR_PATH = join(process.cwd(), ".opencode", "agent-intercom");
const PROMPT_AGENT_FILES = [
  "orchestrator.md",
  "planner.md",
  "coder.md",
  "debugger.md",
  "reviewer.md",
  "documenter.md",
  "researcher.md",
  "designer.md",
  "gitter.md",
];
const LLM_AGENTS = [
  "orchestrator",
  "planner",
  "coder",
  "debugger",
  "reviewer",
  "documenter",
  "researcher",
  "designer",
  "gitter",
];
interface LlmParamDef {
  key: string;
  label: string;
  step: number;
  min: number;
  max: number;
  decimals: number;
  fallback: number;
}
const LLM_PARAM_DEFS: LlmParamDef[] = [
  { key: "temperature",    label: "temperature", step: 0.05, min: 0,   max: 2,    decimals: 2, fallback: 0.3 },
  { key: "top_p",          label: "top_p",       step: 0.05, min: 0,   max: 1,    decimals: 2, fallback: 0.95 },
  { key: "top_k",          label: "top_k",       step: 5,    min: 0,   max: 200,  decimals: 0, fallback: 20 },
  { key: "min_p",          label: "min_p",       step: 0.01, min: 0,   max: 0.5,  decimals: 2, fallback: 0.05 },
  { key: "repeat_penalty", label: "rep_penalty", step: 0.05, min: 0.5, max: 1.5,  decimals: 2, fallback: 1.0 },
];

// Column widths used by every settings/limits/LLM row. Keep label + value
// columns at fixed widths so the [-]/[+] buttons never shift sideways when the
// displayed value changes from 1 to 999 digits, or from "not set" to "0.30".
const ROW_LABEL_W = 15;     // label field, after the 2-space indent
const NUM_W = 3;            // fits up to 999 (max subagents, max Token(k))
const LLM_VAL_W = 7;        // fits "not set" and every numeric format
const AGENT_NAME_W = 12;    // fits "orchestrator", the longest agent name

const rowLabel = (s: string): string => "  " + s.padEnd(ROW_LABEL_W);
const numCell = (n: number | string, w = NUM_W): string =>
  ` ${String(n).padStart(w)} `;

type LlmParams = Record<string, Record<string, number>>;

function readLlmParams(): LlmParams {
  try {
    const raw = JSON.parse(readFileSync(LLM_PARAMS_PATH, "utf8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      // Drop any legacy "*" global block — each agent is configured
      // individually now. Next write will persist the cleanup.
      const { ["*"]: _drop, ...rest } = raw as LlmParams;
      return rest;
    }
  } catch {
    // no file -> empty
  }
  return {};
}

function writeLlmParams(p: LlmParams): void {
  try {
    mkdirSync(dirname(LLM_PARAMS_PATH), { recursive: true });
    writeFileSync(LLM_PARAMS_PATH, JSON.stringify(p, null, 2) + "\n");
  } catch {
    // best-effort
  }
}

// Opencode's resolved per-agent defaults, fetched from `client.app.agents()`.
// Lets the UI fall back to whatever opencode has merged from opencode.json +
// AGENTS.md + plugin agents — so the user sees what each agent actually runs
// with, not a hardcoded fallback or "not set" when there is in fact a value.
type OpencodeDefaults = Record<string, Partial<Record<string, number>>>;

// Resolve a parameter for an agent. Priority:
//   1. file[agent].<key>   — user's per-agent override (shows ★)
//   2. opencode[agent]     — what opencode resolved for this agent
//   3. null                — truly unset ("not set" in UI; opencode/model decides)
function resolveLlmValue(
  params: LlmParams,
  defaults: OpencodeDefaults,
  agent: string,
  def: LlmParamDef,
): { value: number | null; source: "agent" | "opencode" | null } {
  const own = params[agent]?.[def.key];
  if (typeof own === "number") return { value: own, source: "agent" };
  const oc = defaults[agent]?.[def.key];
  if (typeof oc === "number") return { value: oc, source: "opencode" };
  return { value: null, source: null };
}

function roundToStep(value: number, step: number, decimals: number): number {
  const stepped = Math.round(value / step) * step;
  const f = Math.pow(10, decimals);
  return Math.round(stepped * f) / f;
}

function formatLlmValue(value: number | null, decimals: number): string {
  if (value === null) return "not set";
  if (decimals === 0) return String(Math.round(value));
  return value.toFixed(decimals);
}

interface Settings {
  maxSubagents: number;
  maxContext: number;
}

function envNum(name: string, def: number): number {
  const env = process.env[name];
  if (env === undefined || env === "") return def;
  const n = Number(env);
  return Number.isInteger(n) && n >= 0 ? n : def;
}

// Resolve current limits the same way the main plugin does: file > env var >
// default, so the inputs show whatever is actually in effect.
function readSettings(): Settings {
  const s: Settings = {
    maxSubagents: envNum("OPENCODE_AGENT_INTERCOM_MAX_SUBAGENTS", DEFAULT_MAX_SUBAGENTS),
    maxContext: envNum("OPENCODE_AGENT_INTERCOM_MAX_CONTEXT", DEFAULT_MAX_CONTEXT),
  };
  try {
    const raw = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
    if (Number.isInteger(raw?.maxSubagents) && raw.maxSubagents >= 0) {
      s.maxSubagents = raw.maxSubagents;
    }
    if (Number.isInteger(raw?.maxContext) && raw.maxContext >= 0) {
      s.maxContext = raw.maxContext;
    }
  } catch {
    // no file -> env/defaults
  }
  return s;
}

function writeSettings(s: Settings): void {
  try {
    mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
    writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2) + "\n");
  } catch {
    // best-effort — a failed write just means the limit is not changed
  }
}

type SubagentStatus = "busy" | "idle" | "retry" | "aborted" | "error";

interface SubagentEntry {
  sessionID: string;
  parentID: string;
  agent: string;
  handle: string;
  title: string;
  status: SubagentStatus;
  // True once the subagent has been observed running. A subagent that has run
  // and is no longer running is finished and gets dropped from the panel.
  wasBusy: boolean;
  createdAt: number;
  updatedAt: number;
  ctxTokens?: number;
  lastTokenFetch: number;
}

function formatAge(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

function formatTokens(tokens: number | undefined): string {
  if (tokens === undefined) return "";
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
  return String(tokens);
}

function statusMarker(status: SubagentStatus): string {
  switch (status) {
    case "busy":
      return "●";
    case "retry":
      return "◐";
    case "aborted":
      return "✕";
    case "error":
      return "✕";
    default:
      return "✓";
  }
}

function statusColor(status: SubagentStatus, theme: TuiThemeCurrent) {
  switch (status) {
    case "busy":
      return theme.warning;
    case "retry":
      return theme.info;
    case "aborted":
    case "error":
      return theme.error;
    default:
      return theme.success;
  }
}

// Context size of a subagent = prompt+output tokens of its newest message that
// has a non-zero token count (assistant messages carry it). Mirrors the main
// plugin's check_status. Walk newest-first; an in-progress assistant step has a
// `tokens` object that is still all-zero, so skip zero sums and keep walking
// back to the last completed step — otherwise the panel shows a stale "0 ctx".
function latestContextTokens(
  messages: Array<{ info: unknown }> | undefined,
): number | undefined {
  if (!messages) return undefined;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const t = (messages[i]?.info as { tokens?: unknown } | undefined)
      ?.tokens as
      | {
          input?: number;
          output?: number;
          cache?: { read?: number; write?: number };
        }
      | undefined;
    if (!t) continue;
    const sum =
      (t.input ?? 0) +
      (t.output ?? 0) +
      (t.cache?.read ?? 0) +
      (t.cache?.write ?? 0);
    if (sum > 0) return sum;
  }
  return undefined;
}

function initializeTui(api: TuiPluginApi, disposeRoot: () => void): void {
  const [subagents, setSubagents] = createSignal<Map<string, SubagentEntry>>(
    new Map(),
  );
  const [nowMs, setNowMs] = createSignal(Date.now());
  // Flips on a timer; a busy subagent's dot alternates with it so it visibly
  // pulses, signalling "still working".
  const [pulseOn, setPulseOn] = createSignal(true);
  const [listFocused, setListFocused] = createSignal(false);
  const [selectedID, setSelectedID] = createSignal<string | undefined>();
  // Cumulative count of subagents that have finished and been removed from the
  // list — keeps "something completed" visible without cluttering the panel.
  const [completedCount, setCompletedCount] = createSignal(0);

  // Runtime limits, shared with the main plugin via SETTINGS_PATH. The inputs
  // edit these and auto-save on change.
  const initialSettings = readSettings();
  const [maxSubagents, setMaxSubagents] = createSignal(initialSettings.maxSubagents);
  const [maxContext, setMaxContext] = createSignal(initialSettings.maxContext);

  // Step a setting by delta and save. Deltas are in the setting's own unit:
  // subagents ±1, context ±5000 tokens (= 5k on the display).
  // Both settings are clamped at 0. maxSubagents=0 means "no cap" (unlimited
  // concurrent subagents); maxContext=0 means "no budget" (lockdown disabled).
  const adjustSetting = (key: keyof Settings, delta: number): void => {
    if (key === "maxSubagents") setMaxSubagents((v) => Math.max(0, v + delta));
    else setMaxContext((v) => Math.max(0, v + delta));
    writeSettings({ maxSubagents: maxSubagents(), maxContext: maxContext() });
  };

  // Section collapse state. Subagents-section is the workhorse and stays open
  // by default; tui-settings + LLM params are tucked away to keep the sidebar
  // compact.
  const [subagentsExpanded, setSubagentsExpanded] = createSignal(true);
  const [tuiSettingsExpanded, setTuiSettingsExpanded] = createSignal(false);
  const [promptsExpanded, setPromptsExpanded] = createSignal(false);

  // LLM-parameter overrides, shared with the main plugin's chat.params hook.
  // Cycling through LLM_AGENTS lets the user tune one role at a time without
  // inflating the UI to a grid.
  const [llmParams, setLlmParams] = createSignal<LlmParams>(readLlmParams());
  const [llmExpanded, setLlmExpanded] = createSignal(false);
  const [llmAgentIdx, setLlmAgentIdx] = createSignal(0);
  const currentLlmAgent = (): string => LLM_AGENTS[llmAgentIdx()];

  // Opencode's resolved per-agent defaults — fetched async, refreshed on a
  // timer and on agent cycle. Empty until the first successful fetch (opencode
  // may not have read its config + AGENTS.md yet at TUI init).
  const [opencodeDefaults, setOpencodeDefaults] = createSignal<OpencodeDefaults>({});
  const refreshOpencodeDefaults = async (): Promise<void> => {
    try {
      const res = await api.client.app.agents({});
      const list = ((res as { data?: unknown[] })?.data ?? []) as Array<{
        name?: string;
        temperature?: number;
        topP?: number;
        options?: Record<string, unknown>;
      }>;
      const map: OpencodeDefaults = {};
      for (const a of list) {
        if (!a || typeof a.name !== "string") continue;
        const entry: Record<string, number> = {};
        if (typeof a.temperature === "number") entry.temperature = a.temperature;
        if (typeof a.topP === "number") entry.top_p = a.topP;
        const opts = a.options ?? {};
        const pick = (k: string, src: string): void => {
          const v = opts[src];
          if (typeof v === "number") entry[k] = v;
        };
        pick("top_k", "top_k");
        if (entry.top_k === undefined) pick("top_k", "topK");
        pick("min_p", "min_p");
        if (entry.min_p === undefined) pick("min_p", "minP");
        pick("repeat_penalty", "repeat_penalty");
        map[a.name] = entry;
      }
      if (!disposed) setOpencodeDefaults(map);
    } catch {
      // best-effort — leave previous defaults in place
    }
  };
  void refreshOpencodeDefaults();
  const opencodeDefaultsTimer = setInterval(refreshOpencodeDefaults, 30_000);

  const cycleLlmAgent = (delta: number): void => {
    setLlmAgentIdx((i) => (i + delta + LLM_AGENTS.length) % LLM_AGENTS.length);
    void refreshOpencodeDefaults();
  };

  const adjustLlmParam = (def: LlmParamDef, delta: number): void => {
    const agent = currentLlmAgent();
    const params = llmParams();
    const resolved = resolveLlmValue(params, opencodeDefaults(), agent, def);
    let next: number | null;
    if (resolved.value === null) {
      // Nothing anywhere — emerge at the bottom of the range on +. Pressing -
      // while already "not set" is a no-op.
      if (delta <= 0) return;
      next = def.min;
    } else if (
      resolved.source === "agent" &&
      delta < 0 &&
      resolved.value <= def.min + 1e-9
    ) {
      // User-set on this agent and already at the floor → drop the override.
      // What's underneath (opencode default or null) becomes visible again.
      next = null;
    } else {
      // Start from whatever the user currently sees, even if it's inherited
      // from "*" or opencode — that becomes the new agent-specific value.
      const raw = Math.min(def.max, Math.max(def.min, resolved.value + delta));
      next = roundToStep(raw, def.step, def.decimals);
    }
    const updated: LlmParams = { ...params };
    const bucket: Record<string, number> = { ...(updated[agent] ?? {}) };
    if (next === null) {
      delete bucket[def.key];
    } else {
      bucket[def.key] = next;
    }
    if (Object.keys(bucket).length === 0) {
      delete updated[agent];
    } else {
      updated[agent] = bucket;
    }
    setLlmParams(updated);
    writeLlmParams(updated);
  };

  const resetLlmAgent = (): void => {
    const agent = currentLlmAgent();
    const params = llmParams();
    if (!params[agent]) return;
    const updated: LlmParams = { ...params };
    delete updated[agent];
    setLlmParams(updated);
    writeLlmParams(updated);
  };

  // Toggles for opencode's "thinking blocks" and "tool details" visibility. The
  // label is read straight from opencode's KV store — the same store its session
  // view binds these signals to — so it reflects the real value: correct after a
  // restart and in sync even when the user toggles via /thinking or a keybind.
  // The toggle itself goes through the keymap command, which also clears the
  // layout cache that a raw KV write would miss. `api.kv.get` reads the reactive
  // store, so the label re-renders when the value changes.
  const thinkingOn = (): boolean =>
    (api.kv?.get?.<string>("thinking_mode", "hide") ?? "hide") === "show";
  const toggleThinking = (): void => {
    api.keymap?.dispatchCommand?.("session.toggle.thinking");
  };
  const actionsOn = (): boolean =>
    api.kv?.get?.("tool_details_visibility", true) ?? true;
  const toggleActions = (): void => {
    api.keymap?.dispatchCommand?.("session.toggle.actions");
  };

  // Bumps each prompt file's mtime so the main plugin's mtime-keyed cache
  // picks it up on the next LLM call. Editing a file in an external editor
  // already does this — the button is for the case where you want to force a
  // fresh read without an edit (debugging, scripted writes, etc).
  const countPromptFiles = (): number => {
    let n = 0;
    for (const name of PROMPT_AGENT_FILES) {
      if (existsSync(join(PROMPTS_DIR_PATH, name))) n++;
    }
    return n;
  };
  const reloadPrompts = (): void => {
    try {
      const now = new Date();
      let touched = 0;
      for (const name of PROMPT_AGENT_FILES) {
        const p = join(PROMPTS_DIR_PATH, name);
        if (existsSync(p)) {
          utimesSync(p, now, now);
          touched++;
        }
      }
      if (touched === 0) {
        api.ui.toast({
          variant: "warning",
          message: `No prompt files under ${PROMPTS_DIR_PATH} — run: npx opencode-agent-intercom-init-prompts`,
        });
        return;
      }
      api.ui.toast({
        variant: "success",
        message: `prompts cache busted (${touched}/${PROMPT_AGENT_FILES.length} files) — next LLM call reloads`,
      });
    } catch (err) {
      api.ui.toast({
        variant: "error",
        message: `reload failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };

  // Sessions whose children we track. Seeded from the slot context and from
  // session.created events that carry a parentID.
  const primaryIDs = new Set<string>();
  // Sessions the user aborted from this panel — server status alone does not
  // distinguish "aborted" from "idle", so we remember it locally.
  const aborted = new Set<string>();
  // Subagents that have finished and been removed — kept so a later poll does
  // not re-add them as fresh entries (their wasBusy flag is gone with them).
  const finished = new Set<string>();
  const handleCounters = new Map<string, number>();
  let disposed = false;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let refreshInFlight = false;
  let refreshQueued = false;

  const nextHandle = (agent: string): string => {
    const n = (handleCounters.get(agent) ?? 0) + 1;
    handleCounters.set(agent, n);
    return `${agent}#${n}`;
  };

  const refresh = async (): Promise<void> => {
    if (disposed) return;
    if (refreshInFlight) {
      refreshQueued = true;
      return;
    }
    refreshInFlight = true;
    try {
      const statusRes = await api.client.session.status({});
      const statuses = (statusRes?.data ?? {}) as Record<
        string,
        { type?: string }
      >;

      const next = new Map(subagents());
      const seen = new Set<string>();
      let completedDelta = 0;

      for (const primaryID of primaryIDs) {
        const childRes = await api.client.session.children({
          sessionID: primaryID,
        });
        const children = (childRes?.data ?? []) as Array<{
          id: string;
          parentID?: string;
          agent?: string;
          title?: string;
          time?: { created?: number; updated?: number };
        }>;
        for (const child of children) {
          seen.add(child.id);
          // Already finished and removed — keep it gone, do not re-add.
          if (finished.has(child.id)) {
            next.delete(child.id);
            continue;
          }
          // A primary (orchestrator) session is never a subagent row, even if
          // it shows up as a child of some higher-level session.
          if (primaryIDs.has(child.id)) continue;

          const existing = next.get(child.id);
          const agent = child.agent ?? existing?.agent ?? "subagent";
          const serverStatus = statuses[child.id]?.type;
          const running = serverStatus === "busy" || serverStatus === "retry";
          const wasBusy = (existing?.wasBusy ?? false) || running;

          // A subagent that has run (or was aborted) and is no longer running
          // is finished — drop it so the panel only shows live work.
          if (!running && (wasBusy || aborted.has(child.id))) {
            if (existing && !aborted.has(child.id)) completedDelta += 1;
            next.delete(child.id);
            finished.add(child.id);
            aborted.delete(child.id);
            continue;
          }

          // Upgrade the placeholder handle once the real agent name is known
          // (session.created often fires before the agent is assigned).
          const handle =
            existing && existing.agent !== "subagent"
              ? existing.handle
              : existing && agent !== "subagent"
                ? nextHandle(agent)
                : (existing?.handle ?? nextHandle(agent));

          const status: SubagentStatus = aborted.has(child.id)
            ? "aborted"
            : serverStatus === "retry"
              ? "retry"
              : running
                ? "busy"
                : "idle";
          const entry: SubagentEntry = {
            sessionID: child.id,
            parentID: child.parentID ?? primaryID,
            agent,
            handle,
            title: child.title ?? existing?.title ?? "",
            status,
            wasBusy,
            createdAt: child.time?.created ?? existing?.createdAt ?? Date.now(),
            updatedAt: child.time?.updated ?? existing?.updatedAt ?? Date.now(),
            ctxTokens: existing?.ctxTokens,
            lastTokenFetch: existing?.lastTokenFetch ?? 0,
          };
          next.set(child.id, entry);
        }
      }
      if (completedDelta > 0) {
        setCompletedCount((count) => count + completedDelta);
      }

      // Refresh context-token counts (throttled per entry).
      const now = Date.now();
      for (const entry of next.values()) {
        if (!seen.has(entry.sessionID)) continue;
        if (now - entry.lastTokenFetch < TOKEN_REFRESH_MS) continue;
        entry.lastTokenFetch = now;
        try {
          // No `limit` — it can truncate to the oldest messages and miss the
          // latest assistant step that actually carries the token count.
          const msgRes = await api.client.session.messages({
            sessionID: entry.sessionID,
          });
          const tokens = latestContextTokens(
            (msgRes?.data ?? []) as Array<{ info: unknown }>,
          );
          if (tokens !== undefined) entry.ctxTokens = tokens;
        } catch {
          // best-effort
        }
      }

      setSubagents(next);
    } catch {
      // Defensive: never crash the TUI on a transient server error.
    } finally {
      refreshInFlight = false;
      if (refreshQueued && !disposed) {
        refreshQueued = false;
        scheduleRefresh();
      }
    }
  };

  const scheduleRefresh = (): void => {
    if (disposed) return;
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      void refresh();
    }, REFRESH_DEBOUNCE_MS);
  };

  const trackPrimary = (sessionID: string | undefined): void => {
    // Hard gate: only real session IDs (ses_*) may enter primary tracking.
    // Some event payloads carry a parentID that is NOT a session — e.g.
    // message.updated's info.parentID is the previous MESSAGE (msg_*). A
    // non-session ID in primaryIDs makes the fallback poll call
    // session.children({sessionID: "msg_…"}) forever, which the server
    // rejects with a schema error on every tick.
    if (!sessionID || !sessionID.startsWith("ses_")) return;
    if (primaryIDs.has(sessionID)) return;
    primaryIDs.add(sessionID);
    scheduleRefresh();
  };

  const openSubagent = (id: string): void => {
    api.route.navigate("session", { sessionID: id });
  };

  const abortSubagent = async (id: string): Promise<void> => {
    const entry = subagents().get(id);
    aborted.add(id);
    try {
      await api.client.session.abort({ sessionID: id });
      api.ui.toast({
        variant: "warning",
        message: `Aborted ${entry?.handle ?? id}`,
      });
      // Do NOT wake the parent from here. session.abort() makes opencode emit
      // session.error (MessageAbortedError) for this subagent, and the main
      // intercom plugin's onSessionError already posts a single abort notice
      // to the parent and frees the slot. Posting our own here would produce a
      // second, contradictory wake notice.
    } catch {
      api.ui.toast({ variant: "error", message: `Abort failed for ${id}` });
    }
    scheduleRefresh();
  };

  // Keyboard: Alt+A focuses the list; the focus-aware handler lives in the
  // panel component (so it only fires while the panel box is focused).
  const focusList = (): void => {
    setListFocused(true);
  };
  const abortSelected = (): void => {
    const id = selectedID();
    if (id) void abortSubagent(id);
  };

  const commandDispose =
    api.keymap?.registerLayer?.({
      commands: [
        {
          name: FOCUS_LIST_COMMAND,
          title: "Agent Intercom: Focus subagent panel",
          description: "Focus the subagent sidebar panel for keyboard navigation",
          category: "Agent Intercom",
          run: focusList,
        },
        {
          name: ABORT_COMMAND,
          title: "Agent Intercom: Abort selected subagent",
          description: "Abort the subagent currently selected in the panel",
          category: "Agent Intercom",
          run: abortSelected,
        },
      ],
      bindings: [{ key: "alt+a", cmd: FOCUS_LIST_COMMAND }],
    }) ?? (() => undefined);

  const tick = setInterval(() => setNowMs(Date.now()), ELAPSED_TICK_MS);
  const pulse = setInterval(() => setPulseOn((p) => !p), PULSE_TICK_MS);
  const poll = setInterval(() => void refresh(), POLL_FALLBACK_MS);

  // Event payloads differ per type; we only opportunistically read parentID
  // off session.* events, so narrow defensively from unknown.
  const onSessionEvent = (event: unknown): void => {
    const info = (event as { properties?: { info?: unknown } }).properties
      ?.info as { parentID?: string } | undefined;
    if (info && typeof info.parentID === "string") trackPrimary(info.parentID);
    scheduleRefresh();
  };

  // message.updated's info is a Message whose parentID points at the previous
  // MESSAGE in the chain (msg_*), not at a session — it must never feed the
  // primary tracking. Only use it as a refresh trigger.
  const onMessageEvent = (): void => {
    scheduleRefresh();
  };

  // A child session being created is a subagent spawn. Insert it optimistically
  // as "busy" so even a fast-finishing subagent is marked wasBusy and gets
  // cleaned up when it goes idle, instead of lingering as a stale entry.
  const onSessionCreated = (event: unknown): void => {
    const info = (event as {
      properties?: {
        info?: {
          id?: string;
          parentID?: string;
          agent?: string;
          title?: string;
          time?: { created?: number; updated?: number };
        };
      };
    }).properties?.info;
    if (!info?.id || typeof info.parentID !== "string") {
      scheduleRefresh();
      return;
    }
    trackPrimary(info.parentID);
    const current = subagents();
    if (
      !current.has(info.id) &&
      !finished.has(info.id) &&
      !primaryIDs.has(info.id)
    ) {
      const agent = info.agent ?? "subagent";
      const next = new Map(current);
      next.set(info.id, {
        sessionID: info.id,
        parentID: info.parentID,
        agent,
        handle: nextHandle(agent),
        title: info.title ?? "",
        status: "busy",
        wasBusy: true,
        createdAt: info.time?.created ?? Date.now(),
        updatedAt: info.time?.updated ?? Date.now(),
        ctxTokens: undefined,
        lastTokenFetch: 0,
      });
      setSubagents(next);
    }
    scheduleRefresh();
  };

  // A subagent going idle means it is done — remove it from the panel right
  // away instead of waiting for the next poll.
  const onSessionIdle = (event: unknown): void => {
    const sessionID = (event as { properties?: { sessionID?: string } })
      .properties?.sessionID;
    const entry = sessionID ? subagents().get(sessionID) : undefined;
    if (sessionID && entry && entry.wasBusy) {
      // If the user is currently viewing this subagent, jump back to the
      // parent before the main plugin deletes the session server-side —
      // otherwise the route points at a now-missing session and the TUI
      // falls back to the start page, losing the orchestrator chat.
      if (
        entry.parentID &&
        api.route.current.name === "session" &&
        (api.route.current.params?.sessionID as string | undefined) ===
          sessionID
      ) {
        api.route.navigate("session", { sessionID: entry.parentID });
      }
      const next = new Map(subagents());
      next.delete(sessionID);
      setSubagents(next);
      finished.add(sessionID);
      if (!aborted.has(sessionID)) setCompletedCount((count) => count + 1);
      aborted.delete(sessionID);
      if (selectedID() === sessionID) setSelectedID(undefined);
      return;
    }
    scheduleRefresh();
  };

  const disposers = [
    api.event.on("session.created", onSessionCreated),
    api.event.on("session.updated", onSessionEvent),
    api.event.on("session.idle", onSessionIdle),
    api.event.on("session.error", onSessionEvent),
    api.event.on("session.status", onSessionEvent),
    api.event.on("message.updated", onMessageEvent),
  ];

  api.lifecycle.onDispose(() => {
    disposed = true;
    clearInterval(tick);
    clearInterval(pulse);
    clearInterval(poll);
    clearInterval(opencodeDefaultsTimer);
    if (refreshTimer) clearTimeout(refreshTimer);
    commandDispose();
    for (const dispose of disposers) dispose();
    disposeRoot();
  });

  api.slots.register({
    order: 90,
    slots: {
      sidebar_content(ctx: TuiSlotContext & { session_id?: string }) {
        const sessionID =
          ctx.session_id ??
          (api.route.current.name === "session"
            ? (api.route.current.params?.sessionID as string | undefined)
            : undefined);
        trackPrimary(sessionID);
        return (
          <SubagentPanel
            sessionID={sessionID ?? ""}
            subagents={subagents}
            nowMs={nowMs}
            pulseOn={pulseOn}
            listFocused={listFocused}
            setListFocused={setListFocused}
            selectedID={selectedID}
            setSelectedID={setSelectedID}
            completedCount={completedCount}
            isPrimary={(id: string) => primaryIDs.has(id)}
            onOpen={openSubagent}
            onAbort={(id: string) => void abortSubagent(id)}
            maxSubagents={maxSubagents}
            maxContext={maxContext}
            onAdjust={adjustSetting}
            thinkingOn={thinkingOn}
            onToggleThinking={toggleThinking}
            actionsOn={actionsOn}
            onToggleActions={toggleActions}
            subagentsExpanded={subagentsExpanded}
            onToggleSubagents={() => setSubagentsExpanded((v) => !v)}
            tuiSettingsExpanded={tuiSettingsExpanded}
            onToggleTuiSettings={() => setTuiSettingsExpanded((v) => !v)}
            promptsExpanded={promptsExpanded}
            onTogglePrompts={() => setPromptsExpanded((v) => !v)}
            promptsFileCount={countPromptFiles}
            onReloadPrompts={reloadPrompts}
            llmParams={llmParams}
            opencodeDefaults={opencodeDefaults}
            llmExpanded={llmExpanded}
            onToggleLlm={() => setLlmExpanded((v) => !v)}
            llmAgent={currentLlmAgent}
            onCycleLlmAgent={cycleLlmAgent}
            onAdjustLlmParam={adjustLlmParam}
            onResetLlmAgent={resetLlmAgent}
            theme={ctx.theme.current}
          />
        );
      },
    },
  });

  void refresh();
}

// Returns mouse handlers that fire `action` once on press, then auto-repeat
// for as long as the button is held. Used by the limits +/- buttons so the
// user can sweep from 1 to 20 subagents (or 50 to 500k tokens) without
// clicking 20+ times. Each call creates its own timer pair — one button
// holding does not interfere with another button's state.
function holdRepeat(action: () => void): {
  onMouseDown: () => void;
  onMouseUp: () => void;
  onMouseOut: () => void;
} {
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  let repeatTimer: ReturnType<typeof setInterval> | undefined;
  const stop = (): void => {
    if (holdTimer !== undefined) {
      clearTimeout(holdTimer);
      holdTimer = undefined;
    }
    if (repeatTimer !== undefined) {
      clearInterval(repeatTimer);
      repeatTimer = undefined;
    }
  };
  return {
    onMouseDown: () => {
      stop();
      action();
      holdTimer = setTimeout(() => {
        repeatTimer = setInterval(action, HOLD_REPEAT_INTERVAL_MS);
      }, HOLD_REPEAT_DELAY_MS);
    },
    onMouseUp: stop,
    onMouseOut: stop,
  };
}

function SubagentPanel(props: {
  sessionID: string;
  subagents: () => Map<string, SubagentEntry>;
  nowMs: () => number;
  pulseOn: () => boolean;
  listFocused: () => boolean;
  setListFocused: (focused: boolean) => void;
  selectedID: () => string | undefined;
  setSelectedID: (id: string | undefined) => void;
  completedCount: () => number;
  isPrimary: (id: string) => boolean;
  onOpen: (id: string) => void;
  onAbort: (id: string) => void;
  maxSubagents: () => number;
  maxContext: () => number;
  onAdjust: (key: keyof Settings, delta: number) => void;
  thinkingOn: () => boolean;
  onToggleThinking: () => void;
  actionsOn: () => boolean;
  onToggleActions: () => void;
  subagentsExpanded: () => boolean;
  onToggleSubagents: () => void;
  tuiSettingsExpanded: () => boolean;
  onToggleTuiSettings: () => void;
  promptsExpanded: () => boolean;
  onTogglePrompts: () => void;
  promptsFileCount: () => number;
  onReloadPrompts: () => void;
  llmParams: () => LlmParams;
  opencodeDefaults: () => OpencodeDefaults;
  llmExpanded: () => boolean;
  onToggleLlm: () => void;
  llmAgent: () => string;
  onCycleLlmAgent: (delta: number) => void;
  onAdjustLlmParam: (def: LlmParamDef, delta: number) => void;
  onResetLlmAgent: () => void;
  theme: TuiThemeCurrent;
}) {
  const rows = createMemo(() => {
    const own = [...props.subagents().values()].filter(
      (entry) =>
        entry.parentID === props.sessionID &&
        entry.sessionID !== props.sessionID &&
        !props.isPrimary(entry.sessionID),
    );
    return own.sort((a, b) => {
      const rank = (s: SubagentStatus) => (s === "busy" || s === "retry" ? 0 : 1);
      const byRank = rank(a.status) - rank(b.status);
      if (byRank !== 0) return byRank;
      return a.createdAt - b.createdAt;
    });
  });

  const rowIDs = createMemo(() => rows().map((entry) => entry.sessionID));

  // If the panel is rendered inside a subagent's own session, offer a way back
  // to the orchestrator that spawned it.
  const currentSub = createMemo(() => props.subagents().get(props.sessionID));

  // Finished subagents are removed from `rows`, so "running" counts the live
  // list and "done" is the cumulative count of subagents that have completed.
  const counts = createMemo(() => {
    let running = 0;
    for (const entry of rows()) {
      if (entry.status === "busy" || entry.status === "retry") running += 1;
    }
    return { running, done: props.completedCount() };
  });

  // Keep the selection valid as the list changes.
  createEffect(() => {
    const ids = rowIDs();
    const current = props.selectedID();
    if (ids.length === 0) {
      if (current) props.setSelectedID(undefined);
      return;
    }
    if (!current || !ids.includes(current)) props.setSelectedID(ids[0]);
  });

  const moveSelection = (delta: number): void => {
    const ids = rowIDs();
    if (ids.length === 0) return;
    const idx = ids.findIndex((id) => id === props.selectedID());
    const base = idx < 0 ? (delta > 0 ? -1 : ids.length) : idx;
    const nextIdx = Math.max(0, Math.min(ids.length - 1, base + delta));
    props.setSelectedID(ids[nextIdx]);
  };

  let listBox: BoxRenderable | undefined;

  const focusPanel = (): void => {
    listBox?.focus();
    props.setListFocused(true);
  };
  const blurPanel = (): void => {
    listBox?.blur();
    props.setListFocused(false);
  };

  // onKeyDown only fires while the box is opentui-focused, so this handler is
  // already scoped to "panel is focused" — no extra gating needed.
  const handleKeyDown = (event: KeyEvent): void => {
    const name = event.name?.toLowerCase();
    if (name === "j" || name === "down" || name === "arrowdown") {
      moveSelection(1);
    } else if (name === "k" || name === "up" || name === "arrowup") {
      moveSelection(-1);
    } else if (name === "return" || name === "enter") {
      const id = props.selectedID();
      if (id) props.onOpen(id);
    } else if (name === "x" || name === "d") {
      const id = props.selectedID();
      if (id) props.onAbort(id);
    } else if (name === "escape" || name === "esc") {
      blurPanel();
    } else {
      return;
    }
    event.preventDefault?.();
    event.stopPropagation?.();
  };

  // Alt+A sets the listFocused signal from outside; mirror it onto the box.
  createEffect(() => {
    if (props.listFocused()) listBox?.focus();
  });
  // ...and mirror the box's real focus state back, so the highlight clears
  // when the user tabs/clicks away.
  const syncFocus = (): void => {
    const real = Boolean(listBox?.focused);
    if (real !== props.listFocused()) props.setListFocused(real);
  };

  const Row = (rowProps: { entry: SubagentEntry }) => {
    const selected = createMemo(
      () => props.selectedID() === rowProps.entry.sessionID,
    );
    const age = createMemo(() =>
      formatAge(props.nowMs() - rowProps.entry.createdAt),
    );
    // A busy/retry subagent's dot alternates filled/hollow on the pulse timer
    // so you can see it is still working; finished/aborted dots stay static.
    const marker = createMemo(() => {
      const s = rowProps.entry.status;
      if (s === "busy" || s === "retry") return props.pulseOn() ? "●" : "○";
      return statusMarker(s);
    });
    const openThis = (): void => {
      props.setSelectedID(rowProps.entry.sessionID);
      props.onOpen(rowProps.entry.sessionID);
    };
    const abortThis = (): void => {
      props.setSelectedID(rowProps.entry.sessionID);
      props.onAbort(rowProps.entry.sessionID);
    };
    return (
      <box
        flexDirection="column"
        height={2}
        backgroundColor={
          selected() ? props.theme.backgroundElement : undefined
        }
      >
        <box flexDirection="row">
          <text fg={selected() ? props.theme.accent : props.theme.textMuted}>
            {selected() ? "›" : " "}
          </text>
          <text fg={statusColor(rowProps.entry.status, props.theme)}>
            {`${marker()} `}
          </text>
          <text fg={props.theme.text} onMouseDown={openThis}>
            {rowProps.entry.handle}
          </text>
          <text fg={props.theme.textMuted}> </text>
          <text fg={props.theme.error} onMouseDown={abortThis}>
            {"✕"}
          </text>
        </box>
        <box flexDirection="row" paddingLeft={4}>
          <text fg={props.theme.textMuted}>{`↳ ${age()}`}</text>
          <Show when={rowProps.entry.ctxTokens !== undefined}>
            <text fg={props.theme.textMuted}>
              {` · ${formatTokens(rowProps.entry.ctxTokens)} ctx`}
            </text>
          </Show>
          <Show when={rowProps.entry.status === "aborted"}>
            <text fg={props.theme.error}> · aborting</text>
          </Show>
        </box>
      </box>
    );
  };

  return (
    <box
      ref={(element: BoxRenderable | undefined) => {
        listBox = element;
      }}
      flexDirection="column"
      backgroundColor={
        props.listFocused() ? props.theme.backgroundPanel : undefined
      }
      focusable
      focused={props.listFocused()}
      onKeyDown={handleKeyDown}
      renderBefore={syncFocus}
    >
      <Show when={currentSub()}>
        {(sub: () => SubagentEntry) => (
          <text
            fg={props.theme.accent}
            onMouseDown={() => props.onOpen(sub().parentID)}
          >
            {`← back to orchestrator`}
          </text>
        )}
      </Show>
      {/* Each section is its own column box so the Show body stays anchored
          under its header. @opentui/solid appends Show children to the end of
          the parent on toggle; wrapping per-section pins each body in place. */}
      <box flexDirection="column">
        <box flexDirection="row">
          <text
            fg={props.theme.accent}
            onMouseDown={props.onToggleSubagents}
          >
            {props.subagentsExpanded() ? "[▼]" : "[▶]"}
          </text>
          <text
            fg={props.listFocused() ? props.theme.accent : props.theme.text}
            onMouseDown={focusPanel}
          >
            {` Subagents (${rows().length})`}
          </text>
        </box>
        <Show when={props.subagentsExpanded()}>
          <Show when={rows().length > 0 || props.completedCount() > 0}>
            <box flexDirection="column" paddingLeft={2}>
              <box flexDirection="row">
                <text fg={props.theme.warning}>{`● ${counts().running} running`}</text>
                <text fg={props.theme.textMuted}> · </text>
                <text fg={props.theme.success}>{`✓ ${counts().done} done`}</text>
              </box>
              <box flexDirection="column">
                <For each={rows()}>{(entry) => <Row entry={entry} />}</For>
              </box>
              <Show when={props.listFocused()}>
                <text fg={props.theme.textMuted}>
                  {"j/k move · ⏎ open · x abort · esc"}
                </text>
              </Show>
            </box>
          </Show>
          <box flexDirection="row">
            <text fg={props.theme.textMuted}>{rowLabel("max subagents")}</text>
            <text fg={props.theme.accent} {...holdRepeat(() => props.onAdjust("maxSubagents", -1))}>
              {"[-]"}
            </text>
            <text fg={props.theme.text}>{numCell(props.maxSubagents() === 0 ? "unlimited" : props.maxSubagents())}</text>
            <text fg={props.theme.accent} {...holdRepeat(() => props.onAdjust("maxSubagents", 1))}>
              {"[+]"}
            </text>
          </box>
          <box flexDirection="row">
            <text fg={props.theme.textMuted}>{rowLabel("max Token(k)")}</text>
            <text fg={props.theme.accent} {...holdRepeat(() => props.onAdjust("maxContext", -5000))}>
              {"[-]"}
            </text>
            <text fg={props.theme.text}>{numCell(props.maxContext() / 1000)}</text>
            <text fg={props.theme.accent} {...holdRepeat(() => props.onAdjust("maxContext", 5000))}>
              {"[+]"}
            </text>
          </box>
        </Show>
      </box>
      <box flexDirection="column">
        <box flexDirection="row">
          <text
            fg={props.theme.accent}
            onMouseDown={props.onToggleTuiSettings}
          >
            {props.tuiSettingsExpanded() ? "[▼]" : "[▶]"}
          </text>
          <text
            fg={props.theme.text}
            onMouseDown={props.onToggleTuiSettings}
          >
            {" TUI settings"}
          </text>
        </box>
        <Show when={props.tuiSettingsExpanded()}>
          <box flexDirection="row">
            <text fg={props.theme.textMuted}>{rowLabel("thinking")}</text>
            <text
              fg={props.thinkingOn() ? props.theme.success : props.theme.textMuted}
              onMouseDown={props.onToggleThinking}
            >
              {props.thinkingOn() ? "[on] " : "[off]"}
            </text>
          </box>
          <box flexDirection="row">
            <text fg={props.theme.textMuted}>{rowLabel("tool details")}</text>
            <text
              fg={props.actionsOn() ? props.theme.success : props.theme.textMuted}
              onMouseDown={props.onToggleActions}
            >
              {props.actionsOn() ? "[on] " : "[off]"}
            </text>
          </box>
        </Show>
      </box>
      <box flexDirection="column">
        <box flexDirection="row">
          <text
            fg={props.theme.accent}
            onMouseDown={props.onToggleLlm}
          >
            {props.llmExpanded() ? "[▼]" : "[▶]"}
          </text>
          <text
            fg={props.theme.text}
            onMouseDown={props.onToggleLlm}
          >
            {" LLM params"}
          </text>
        </box>
        <Show when={props.llmExpanded()}>
          <box flexDirection="row">
            <text fg={props.theme.textMuted}>{rowLabel("agent")}</text>
            <text fg={props.theme.accent} onMouseDown={() => props.onCycleLlmAgent(-1)}>
              {"[<]"}
            </text>
            <text fg={props.theme.text}>{` ${props.llmAgent().padEnd(AGENT_NAME_W)} `}</text>
            <text fg={props.theme.accent} onMouseDown={() => props.onCycleLlmAgent(1)}>
              {"[>]"}
            </text>
          </box>
          <box flexDirection="row">
            <text fg={props.theme.textMuted}>{rowLabel("")}</text>
            <text fg={props.theme.accent} onMouseDown={props.onResetLlmAgent}>
              {"[reset current agent]"}
            </text>
          </box>
          <For each={LLM_PARAM_DEFS}>
            {(def) => {
              const resolved = createMemo(() =>
                resolveLlmValue(
                  props.llmParams(),
                  props.opencodeDefaults(),
                  props.llmAgent(),
                  def,
                ),
              );
              return (
                <box flexDirection="row">
                  <text fg={props.theme.textMuted}>{rowLabel(def.label)}</text>
                  <text
                    fg={props.theme.accent}
                    {...holdRepeat(() => props.onAdjustLlmParam(def, -def.step))}
                  >
                    {"[-]"}
                  </text>
                  <text fg={props.theme.text}>
                    {numCell(formatLlmValue(resolved().value, def.decimals), LLM_VAL_W)}
                  </text>
                  <text
                    fg={props.theme.accent}
                    {...holdRepeat(() => props.onAdjustLlmParam(def, def.step))}
                  >
                    {"[+]"}
                  </text>
                  <Show when={resolved().source === "agent"}>
                    <text fg={props.theme.success}>{" ★"}</text>
                  </Show>
                </box>
              );
            }}
          </For>
        </Show>
      </box>
      <box flexDirection="column">
        <box flexDirection="row">
          <text fg={props.theme.accent} onMouseDown={props.onTogglePrompts}>
            {props.promptsExpanded() ? "[▼]" : "[▶]"}
          </text>
          <text fg={props.theme.text} onMouseDown={props.onTogglePrompts}>
            {" Prompts"}
          </text>
        </box>
        <Show when={props.promptsExpanded()}>
          <box flexDirection="row">
            <text fg={props.theme.textMuted}>{rowLabel("files")}</text>
            <text
              fg={
                props.promptsFileCount() > 0
                  ? props.theme.success
                  : props.theme.textMuted
              }
            >
              {`[${props.promptsFileCount()}/9]`}
            </text>
          </box>
          <box flexDirection="row">
            <text fg={props.theme.textMuted}>{rowLabel("")}</text>
            <text fg={props.theme.accent} onMouseDown={props.onReloadPrompts}>
              {"[↻ reload]"}
            </text>
          </box>
        </Show>
      </box>
    </box>
  );
}

const tui: TuiPlugin = async (api: TuiPluginApi) => {
  createRoot((disposeRoot) => initializeTui(api, disposeRoot));
};

const plugin: TuiPluginModule = {
  id: TUI_PLUGIN_ID,
  tui,
};

export default plugin;
