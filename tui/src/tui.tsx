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
import { existsSync, utimesSync } from "node:fs";
import { join } from "node:path";
import {
  type LlmParams,
  type LlmParamStep,
  clearLlmParamsAgent,
  readLlmParams,
  stepLlmParam,
} from "./llm-params-file.ts";
import {
  type LlmModels,
  type ModelRef,
  cycleLlmModel,
  isModelRef,
  readLlmModels,
  sameModel,
  setLlmModel,
} from "./llm-models-file.ts";
import { composeSubagentLabel, truncate } from "./subagent-label.ts";
import {
  type LimitKey,
  type Settings,
  effectiveAgentContext,
  readSettings,
  stepAgentContext,
  stepSetting,
  toggleEndlessMode,
  toggleHideChatter,
} from "./settings-file.ts";

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
// The cycler list of the context-ceiling row while the live agent list from
// opencode has not landed yet. The budget governs subagents only, so the
// orchestrator is not in it.
const CONTEXT_AGENTS_FALLBACK = LLM_AGENTS.filter((a) => a !== "orchestrator");
// Step of the [-]/[+] buttons on the context-ceiling row, in tokens.
const CONTEXT_STEP = 5000;
// The stepping rule of one parameter row plus the label it carries; the rule
// itself is the store's, which applies it inside its read-modify-write.
interface LlmParamDef extends LlmParamStep {
  label: string;
}
const LLM_PARAM_DEFS: LlmParamDef[] = [
  { key: "temperature",    label: "temperature", step: 0.05, min: 0,   max: 2,    decimals: 2 },
  { key: "top_p",          label: "top_p",       step: 0.05, min: 0,   max: 1,    decimals: 2 },
  { key: "top_k",          label: "top_k",       step: 5,    min: 0,   max: 200,  decimals: 0 },
  { key: "min_p",          label: "min_p",       step: 0.01, min: 0,   max: 0.5,  decimals: 2 },
  { key: "repeat_penalty", label: "rep_penalty", step: 0.05, min: 0.5, max: 1.5,  decimals: 2 },
];

// Column widths used by every settings/limits/LLM row. Keep label + value
// columns at fixed widths so the [-]/[+] buttons never shift sideways when the
// displayed value changes from 1 to 999 digits, or from "not set" to "0.30".
const ROW_LABEL_W = 15;     // label field, after the 2-space indent
const NUM_W = 3;            // fits up to 999 (max subagents, max Token(k))
const LLM_VAL_W = 7;        // fits "not set" and every numeric format
const AGENT_NAME_W = 12;    // fits "orchestrator", the longest agent name
// Model names are unbounded; same width as the agent cell so the two cycler
// rows line their [<]/[>] buttons up, longer names are cut.
const MODEL_NAME_W = AGENT_NAME_W;

const rowLabel = (s: string): string => "  " + s.padEnd(ROW_LABEL_W);
const numCell = (n: number | string, w = NUM_W): string =>
  ` ${String(n).padStart(w)} `;
// Fixed-width left-aligned cell; anything longer is cut with a trailing "…" so
// a long model name cannot push the [>] button off the sidebar.
const fitCell = (s: string, w: number): string =>
  ` ${truncate(s, w).padEnd(w)} `;

// One entry of the flat pick list built from `client.config.providers()`:
// the model reference plus the label the row shows for it.
interface ModelChoice extends ModelRef {
  label: string;
}

// Normalise what an agent record carries as its model. The runtime `Agent` type
// gives the pair; the config form of the same field is the string
// "providerID/modelID", so both are accepted and anything else is dropped.
function toModelRef(v: unknown): ModelRef | null {
  if (isModelRef(v)) return { providerID: v.providerID, modelID: v.modelID };
  if (typeof v === "string") {
    const slash = v.indexOf("/");
    if (slash > 0 && slash < v.length - 1) {
      return { providerID: v.slice(0, slash), modelID: v.slice(slash + 1) };
    }
  }
  return null;
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

// Resolve the model for an agent, on the same priority the numeric rows use:
//   1. models file[agent]  — user's choice (shows ★)
//   2. opencode's resolved agent model
//   3. null                — "not set"
function resolveLlmModel(
  models: LlmModels,
  defaults: Record<string, ModelRef>,
  agent: string,
): { value: ModelRef | null; source: "agent" | "opencode" | null } {
  const own = models[agent];
  if (isModelRef(own)) return { value: own, source: "agent" };
  const oc = defaults[agent];
  if (isModelRef(oc)) return { value: oc, source: "opencode" };
  return { value: null, source: null };
}

// Label for a resolved model: the display name from the provider list where the
// model is still in it, otherwise its bare id — a choice whose provider is no
// longer configured must stay visible rather than turn into "not set".
function formatLlmModel(value: ModelRef | null, choices: ModelChoice[]): string {
  if (value === null) return "not set";
  return choices.find((c) => sameModel(c, value))?.label ?? value.modelID;
}

// Label for a context ceiling: thousands of tokens, or "off" for the 0 that
// disables the budget for that agent type — the same distinction "unlimited"
// draws on the subagent cap.
function formatContextCeiling(tokens: number): string {
  return tokens === 0 ? "off" : String(tokens / 1000);
}

function formatLlmValue(value: number | null, decimals: number): string {
  if (value === null) return "not set";
  if (decimals === 0) return String(Math.round(value));
  return value.toFixed(decimals);
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

  // Runtime settings, shared with the main plugin via the settings file. The
  // inputs edit these and auto-save on change. One signal for the whole
  // resolved state: the context row needs three of its members at once to work
  // out the ceiling in effect, and every store call hands the whole state back
  // anyway.
  const [settings, setSettingsState] = createSignal<Settings>(readSettings());
  const maxSubagents = (): number => settings().maxSubagents;
  const endlessMode = (): boolean => settings().endlessMode;
  const endlessContext = (): number => settings().endlessContext;
  const hideChatter = (): boolean => settings().hideChatter;

  // Every store call hands back the whole merged file state, so one place puts
  // it into the signal — the panel then shows the true file state, including
  // the keys the write did not touch.
  const showSettings = (s: Settings): void => {
    setSettingsState(s);
  };

  // Step a setting by delta and save. Deltas are in the setting's own unit:
  // subagents ±1, endless context ±10000 tokens (= 10k on the display). Both
  // are clamped at 0. maxSubagents=0 means "no cap" (unlimited concurrent
  // subagents); endlessContext=0 arms no endless cycle.
  const adjustSetting = (key: LimitKey, delta: number): void => {
    // Read-modify-write inside the store: the file may have been edited outside
    // the panel since the last read, so the base value comes from the file and
    // only the stepped limit goes into what disk currently holds. The merged
    // result is what the signals show from here on.
    showSettings(stepSetting(key, delta, 0));
  };

  // Flip endless mode and save. Same read-modify-write: the value flipped is
  // the one on disk, not the panel's copy, which may be stale — the plugin
  // writes this key back to false itself when one of the mode's bounds ends the
  // loop.
  const toggleEndless = (): void => {
    showSettings(toggleEndlessMode());
  };

  // Flip the chatter switch and save. Read-modify-write like the one above: the
  // value flipped is the one on disk, which a hand edit may have changed since
  // the panel read it.
  const toggleChatter = (): void => {
    showSettings(toggleHideChatter());
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
  // Per-agent model choice, shared with the main plugin's chat.message hook.
  const [llmModels, setLlmModels] = createSignal<LlmModels>(readLlmModels());
  const [llmExpanded, setLlmExpanded] = createSignal(false);
  const [llmAgentIdx, setLlmAgentIdx] = createSignal(0);
  const currentLlmAgent = (): string => LLM_AGENTS[llmAgentIdx()];

  // The three files are shared with the main plugin and are hand-edited, so the
  // copies seeded at mount go stale. Re-read them on the same timer that
  // refreshes opencode's own defaults, and whenever the user turns to a view
  // that shows them — three small JSON reads.
  const refreshFileState = (): void => {
    if (disposed) return;
    showSettings(readSettings());
    setLlmParams(readLlmParams());
    setLlmModels(readLlmModels());
  };

  // Opening a section that shows file-backed values re-reads them first, so what
  // appears is the current file state rather than the copy from the last read.
  const toggleTuiSettings = (): void => {
    if (!tuiSettingsExpanded()) refreshFileState();
    setTuiSettingsExpanded((v) => !v);
  };
  const toggleLlm = (): void => {
    if (!llmExpanded()) refreshFileState();
    setLlmExpanded((v) => !v);
  };

  // Opencode's resolved per-agent defaults — fetched async, refreshed on a
  // timer and on agent cycle. Empty until the first successful fetch (opencode
  // may not have read its config + AGENTS.md yet at TUI init).
  const [opencodeDefaults, setOpencodeDefaults] = createSignal<OpencodeDefaults>({});
  // The model side of the same fetch: what opencode resolved as each agent's
  // model, shown when the user has chosen none.
  const [opencodeModels, setOpencodeModels] = createSignal<Record<string, ModelRef>>({});
  // The spawnable agents of the same fetch — every one this instance resolved
  // that is not the primary, so a project's own agents are editable too. Empty
  // until the first successful fetch; the context row falls back to the
  // hardcoded list until then.
  const [subagentNames, setSubagentNames] = createSignal<string[]>([]);
  const refreshOpencodeDefaults = async (): Promise<void> => {
    try {
      const res = await api.client.app.agents({});
      const list = ((res as { data?: unknown[] })?.data ?? []) as Array<{
        name?: string;
        mode?: string;
        temperature?: number;
        topP?: number;
        model?: unknown;
        options?: Record<string, unknown>;
      }>;
      const map: OpencodeDefaults = {};
      const models: Record<string, ModelRef> = {};
      const spawnable: string[] = [];
      for (const a of list) {
        if (!a || typeof a.name !== "string") continue;
        if (a.mode !== "primary") spawnable.push(a.name);
        const resolvedModel = toModelRef(a.model);
        if (resolvedModel) models[a.name] = resolvedModel;
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
      if (!disposed) {
        setOpencodeDefaults(map);
        setOpencodeModels(models);
        setSubagentNames(spawnable);
      }
    } catch {
      // best-effort — leave previous defaults in place
    }
  };
  void refreshOpencodeDefaults();
  const opencodeDefaultsTimer = setInterval(() => {
    refreshFileState();
    void refreshOpencodeDefaults();
  }, 30_000);

  // The models the user has configured, as the running opencode instance
  // resolves them (config + auth + opencode.json overrides) — not the raw
  // catalogue. Flattened across providers and sorted, so [<]/[>] walks a stable
  // order. Empty until the first successful fetch; the row then shows the
  // stored/resolved model by its bare id and cycling does nothing.
  const [modelChoices, setModelChoices] = createSignal<ModelChoice[]>([]);
  const refreshModelChoices = async (): Promise<void> => {
    try {
      const res = await api.client.config.providers();
      const providers = ((res as { data?: { providers?: unknown[] } })?.data?.providers ??
        []) as Array<{
        id?: string;
        models?: Record<string, { id?: string; providerID?: string; name?: string }>;
      }>;
      const list: ModelChoice[] = [];
      for (const p of providers) {
        for (const m of Object.values(p?.models ?? {})) {
          const providerID = m?.providerID ?? p?.id;
          const modelID = m?.id;
          if (typeof providerID !== "string" || typeof modelID !== "string") continue;
          if (providerID === "" || modelID === "") continue;
          list.push({ providerID, modelID, label: m?.name || modelID });
        }
      }
      list.sort(
        (a, b) =>
          a.providerID.localeCompare(b.providerID) || a.label.localeCompare(b.label),
      );
      if (!disposed) setModelChoices(list);
    } catch {
      // best-effort — leave the previous list in place
    }
  };
  void refreshModelChoices();
  const modelChoicesTimer = setInterval(refreshModelChoices, 60_000);

  const cycleLlmAgent = (delta: number): void => {
    setLlmAgentIdx((i) => (i + delta + LLM_AGENTS.length) % LLM_AGENTS.length);
    refreshFileState();
    void refreshOpencodeDefaults();
  };

  // The agent whose context ceiling the row above the endless switch edits.
  // The list is the live one where the fetch has landed and the hardcoded one
  // until then; it never shrinks to nothing, so the index always resolves. The
  // modulo keeps a stale index inside a list that shrank between two fetches.
  const [contextAgentIdx, setContextAgentIdx] = createSignal(0);
  const contextAgents = (): string[] => {
    const live = subagentNames();
    return live.length > 0 ? live : CONTEXT_AGENTS_FALLBACK;
  };
  const currentContextAgent = (): string => {
    const list = contextAgents();
    return list[contextAgentIdx() % list.length];
  };
  const cycleContextAgent = (delta: number): void => {
    const size = contextAgents().length;
    setContextAgentIdx((i) => (i + delta + size) % size);
    refreshFileState();
  };

  // Step the selected agent's context ceiling and save. The first such step
  // migrates the file — see stepAgentContext — so the cycler's whole list goes
  // with it: those are the types whose effective ceiling is frozen.
  const adjustAgentContext = (delta: number): void => {
    showSettings(stepAgentContext(currentContextAgent(), delta, contextAgents()));
  };

  // Walk the pick list by one. Position and write are one read-modify-write in
  // the store, so a choice made outside the panel is stepped from rather than
  // overwritten, and the merged result is what the signal shows from here on.
  const cycleModel = (delta: number): void => {
    setLlmModels(cycleLlmModel(currentLlmAgent(), delta, modelChoices()));
  };

  const adjustLlmParam = (def: LlmParamDef, delta: number): void => {
    const agent = currentLlmAgent();
    // Only what is not in the file comes from the panel's own state: the value
    // opencode resolved for this agent, which the step falls back to when the
    // file holds none. Base value and write are one read-modify-write in the
    // store.
    const inherited = opencodeDefaults()[agent]?.[def.key] ?? null;
    setLlmParams(stepLlmParam(agent, def, delta, inherited));
  };

  // Clears everything the panel shows with a ★ for this agent — the sampling
  // overrides and the model choice — so the row values fall back to what
  // opencode resolved.
  const resetLlmAgent = (): void => {
    const agent = currentLlmAgent();
    // Same read-modify-write as a single parameter change: only this agent's
    // block goes away, whatever else the file has gained meanwhile stays.
    setLlmParams(clearLlmParamsAgent(agent));
    setLlmModels(setLlmModel(agent, null));
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
    clearInterval(modelChoicesTimer);
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
            settings={settings}
            contextAgent={currentContextAgent}
            onCycleContextAgent={cycleContextAgent}
            onAdjustContext={adjustAgentContext}
            endlessMode={endlessMode}
            endlessContext={endlessContext}
            onAdjust={adjustSetting}
            onToggleEndless={toggleEndless}
            hideChatter={hideChatter}
            onToggleHideChatter={toggleChatter}
            thinkingOn={thinkingOn}
            onToggleThinking={toggleThinking}
            actionsOn={actionsOn}
            onToggleActions={toggleActions}
            subagentsExpanded={subagentsExpanded}
            onToggleSubagents={() => setSubagentsExpanded((v) => !v)}
            tuiSettingsExpanded={tuiSettingsExpanded}
            onToggleTuiSettings={toggleTuiSettings}
            promptsExpanded={promptsExpanded}
            onTogglePrompts={() => setPromptsExpanded((v) => !v)}
            promptsFileCount={countPromptFiles}
            onReloadPrompts={reloadPrompts}
            llmParams={llmParams}
            opencodeDefaults={opencodeDefaults}
            llmModels={llmModels}
            opencodeModels={opencodeModels}
            modelChoices={modelChoices}
            onCycleLlmModel={cycleModel}
            llmExpanded={llmExpanded}
            onToggleLlm={toggleLlm}
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
  // The whole resolved settings state: the context row works its ceiling out of
  // three of its members at once.
  settings: () => Settings;
  contextAgent: () => string;
  onCycleContextAgent: (delta: number) => void;
  onAdjustContext: (delta: number) => void;
  endlessMode: () => boolean;
  endlessContext: () => number;
  onAdjust: (key: LimitKey, delta: number) => void;
  onToggleEndless: () => void;
  hideChatter: () => boolean;
  onToggleHideChatter: () => void;
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
  llmModels: () => LlmModels;
  opencodeModels: () => Record<string, ModelRef>;
  modelChoices: () => ModelChoice[];
  onCycleLlmModel: (delta: number) => void;
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

  // The columns the panel occupies. The host gives the slot no width and the
  // box takes the one its parent stretches it to, so the only place that width
  // exists is the laid-out renderable itself; it is read off the box and kept
  // in a signal the rows size their label against. Undefined until the first
  // layout has run, which is the label module's fallback case.
  const [panelWidth, setPanelWidth] = createSignal<number | undefined>(
    undefined,
  );
  const syncWidth = (): void => {
    const w = listBox?.width;
    if (typeof w === "number" && w > 0 && w !== panelWidth()) setPanelWidth(w);
  };

  // Both mirrors run off the box's own render pass, which is the one moment
  // focus and layout are settled.
  const syncPanelState = (): void => {
    syncFocus();
    syncWidth();
  };

  const Row = (rowProps: { entry: SubagentEntry }) => {
    const selected = createMemo(
      () => props.selectedID() === rowProps.entry.sessionID,
    );
    const age = createMemo(() =>
      formatAge(props.nowMs() - rowProps.entry.createdAt),
    );
    const label = createMemo(() =>
      composeSubagentLabel(
        rowProps.entry,
        props.llmModels(),
        props.modelChoices(),
        panelWidth(),
      ),
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
            {label()}
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
      renderBefore={syncPanelState}
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
          {/* Context ceiling of one agent type: the [<]/[>] cycler picks the
              type, the row under it steps that type's own ceiling. ★ marks a
              type carrying a value of its own; without one the row shows the
              inherited ceiling, and [-] below zero drops the own value so the
              inherited one shows again. "off" is a ceiling of 0, i.e. no budget
              for that type. */}
          <box flexDirection="row">
            <text fg={props.theme.textMuted}>{rowLabel("agent")}</text>
            <text fg={props.theme.accent} onMouseDown={() => props.onCycleContextAgent(-1)}>
              {"[<]"}
            </text>
            <text fg={props.theme.text}>{fitCell(props.contextAgent(), AGENT_NAME_W)}</text>
            <text fg={props.theme.accent} onMouseDown={() => props.onCycleContextAgent(1)}>
              {"[>]"}
            </text>
          </box>
          {(() => {
            const ceiling = createMemo(() =>
              effectiveAgentContext(props.settings(), props.contextAgent()),
            );
            return (
              <box flexDirection="row">
                <text fg={props.theme.textMuted}>{rowLabel("max Token(k)")}</text>
                <text
                  fg={props.theme.accent}
                  {...holdRepeat(() => props.onAdjustContext(-CONTEXT_STEP))}
                >
                  {"[-]"}
                </text>
                <text fg={props.theme.text}>
                  {numCell(formatContextCeiling(ceiling().value))}
                </text>
                <text
                  fg={props.theme.accent}
                  {...holdRepeat(() => props.onAdjustContext(CONTEXT_STEP))}
                >
                  {"[+]"}
                </text>
                <Show when={ceiling().source === "agent"}>
                  <text fg={props.theme.success}>{" ★"}</text>
                </Show>
              </box>
            );
          })()}
          <box flexDirection="row">
            <text fg={props.theme.textMuted}>{rowLabel("endless")}</text>
            <text
              fg={props.endlessMode() ? props.theme.success : props.theme.textMuted}
              onMouseDown={props.onToggleEndless}
            >
              {props.endlessMode() ? "[on] " : "[off]"}
            </text>
          </box>
          <box flexDirection="row">
            <text fg={props.theme.textMuted}>{rowLabel("endless (k)")}</text>
            <text fg={props.theme.accent} {...holdRepeat(() => props.onAdjust("endlessContext", -10000))}>
              {"[-]"}
            </text>
            <text fg={props.theme.text}>{numCell(props.endlessContext() / 1000)}</text>
            <text fg={props.theme.accent} {...holdRepeat(() => props.onAdjust("endlessContext", 10000))}>
              {"[+]"}
            </text>
          </box>
          <box flexDirection="row">
            <text fg={props.theme.textMuted}>{rowLabel("hide chatter")}</text>
            <text
              fg={props.hideChatter() ? props.theme.success : props.theme.textMuted}
              onMouseDown={props.onToggleHideChatter}
            >
              {props.hideChatter() ? "[on] " : "[off]"}
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
          {/* Model for the selected agent. Same [<]/[>] cycler as the agent row
              above it, over the models this opencode instance has configured,
              with a "not set" slot in front of the first entry — [<] there
              hands the agent back to opencode's own model. */}
          {(() => {
            const resolvedModel = createMemo(() =>
              resolveLlmModel(props.llmModels(), props.opencodeModels(), props.llmAgent()),
            );
            return (
              <box flexDirection="row">
                <text fg={props.theme.textMuted}>{rowLabel("model")}</text>
                <text
                  fg={props.theme.accent}
                  {...holdRepeat(() => props.onCycleLlmModel(-1))}
                >
                  {"[<]"}
                </text>
                <text fg={props.theme.text}>
                  {fitCell(
                    formatLlmModel(resolvedModel().value, props.modelChoices()),
                    MODEL_NAME_W,
                  )}
                </text>
                <text
                  fg={props.theme.accent}
                  {...holdRepeat(() => props.onCycleLlmModel(1))}
                >
                  {"[>]"}
                </text>
                <Show when={resolvedModel().source === "agent"}>
                  <text fg={props.theme.success}>{" ★"}</text>
                </Show>
              </box>
            );
          })()}
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
