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
  EFFORT_LADDER,
  cycleLlmModel,
  formatLlmEffort,
  cycleLlmVariant,
  isModelRef,
  readLlmModels,
  sameModel,
  setLlmModel,
} from "./llm-models-file.ts";
import { holdRepeat, stopHoldRepeat } from "./hold-repeat.ts";
import {
  composeSubagentLabel,
  subagentLabelWidth,
  truncate,
} from "./subagent-label.ts";
import {
  ABORT_CONFIRM_MS,
  ABORT_CONFIRM_TEXT,
  DROP_CONFIRM_TEXT,
  type ArmedAbort,
  armingAfterSelection,
  decideAbort,
  isAbortArmed,
} from "./abort-arming.ts";
import {
  type SessionChild,
  type SubagentEntry,
  type SubagentStatus,
  assembleSubagentEntry,
  decideRow,
  isRetained,
  readSessionChildren,
  reapRows,
  retainedRowNote,
  statusMarker,
  statusRank,
} from "./subagent-store.ts";
import { AGENT_NAMES, PROMPT_AGENT_FILES } from "./agent-roles.ts";
import {
  type LimitKey,
  type Settings,
  RETAINED_SUBAGENT_TTL_STEP_MS,
  effectiveAgentContext,
  effectiveResultTokens,
  effectiveReuseContext,
  readSettings,
  stepAgentContext,
  stepResultTokens,
  stepReuseContext,
  stepSetting,
  toggleEndlessMode,
  toggleShowAgentcom,
} from "./settings-file.ts";

const TUI_PLUGIN_ID = "agent-intercom.tui";
const ELAPSED_TICK_MS = 1000;
// Toggle rate for the pulsing status dot of a busy subagent.
const PULSE_TICK_MS = 600;
const POLL_FALLBACK_MS = 5000;
const REFRESH_DEBOUNCE_MS = 250;
const TOKEN_REFRESH_MS = 8000;
const FOCUS_LIST_COMMAND = "agent-intercom.focus-sidebar-list";
const ABORT_COMMAND = "agent-intercom.abort-selected";

// Per-project, per-agent prompt overrides. The main plugin reads each file at
// every LLM call (mtime-cached) — touching them via `utimesSync` busts that
// cache without editing the body. Directory resolved against `process.cwd()`:
// opencode serve's working directory, which for the common single-project
// workflow is the project root. Run `npx opencode-agent-intercom-init-prompts`
// to seed the directory with defaults (one .md per agent).
const PROMPTS_DIR_PATH = join(process.cwd(), ".opencode", "agent-intercom");
// Step of the [-]/[+] buttons on the context-ceiling row, in tokens.
const CONTEXT_STEP = 5000;
// Step of the [-]/[+] buttons on the result-ceiling row, in tokens. Its own
// step, an order of magnitude smaller: that row holds a reply ceiling in the
// low thousands, which the 5000 of a context budget cannot edit at all.
const RESULT_TOKEN_STEP = 500;
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
// The three per-agent ceiling rows share a wider value cell because the result
// ceiling shows whole tokens rather than thousands, up to 99999 and "off".
const CEILING_NUM_W = 5;
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
// the model reference, the label the row shows for it, and the two
// capabilities the model row badges — everything else the provider list
// carries is dropped.
interface ModelChoice extends ModelRef {
  label: string;
  vision: boolean;
  reasoning: boolean;
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

// The reasoning effort opencode resolved for an agent, read out of the
// provider options it merged for that agent. Every provider family names the
// key differently, so the first string any of the known names carries wins, in
// this order. Lowercased, because the ladder the panel shows is lowercase.
function probeAgentEffort(opts: Record<string, unknown>): string | null {
  const nested = (key: string): Record<string, unknown> | undefined => {
    const v = opts[key];
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : undefined;
  };
  const candidates: unknown[] = [
    opts.reasoningEffort,
    opts.effort,
    nested("reasoning")?.effort,
    nested("thinkingConfig")?.thinkingLevel,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) return c.toLowerCase();
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

// The two capability glyphs of the model row, in the order they are rendered.
// The letter carries the meaning and the colour only reinforces it, so the row
// reads correctly with colour off; all four glyphs are ASCII.
//   V / R  the resolved model is in the pick list and has the capability
//   -      it is in the pick list and has not
//   ?      it is not in the pick list, so nothing is known about it
//   space  there is no resolved model at all
function modelBadges(
  value: ModelRef | null,
  choices: ModelChoice[],
): { vision: string; reasoning: string } {
  if (value === null) return { vision: " ", reasoning: " " };
  const hit = choices.find((c) => sameModel(c, value));
  if (hit === undefined) return { vision: "?", reasoning: "?" };
  return { vision: hit.vision ? "V" : "-", reasoning: hit.reasoning ? "R" : "-" };
}

// What the effort row shows for an agent, and whether its cycler is live.
// Priority, the one the other rows use:
//   1. the effort stored for this agent   — shown as it stands
//   2. the effort opencode resolved       — shown in parentheses and muted
//   3. "default"
// The row goes inert where the ladder cannot be offered: a resolved model
// known to have no reasoning, an unknown model, or none. A stored effort stays
// visible in the unknown case rather than turning silently into "default".
function resolveLlmEffort(
  models: LlmModels,
  efforts: Record<string, string>,
  choices: ModelChoice[],
  agent: string,
  model: ModelRef | null,
): { text: string; source: "agent" | "opencode" | null; live: boolean } {
  const stored = models[agent]?.variant;
  const hit = model === null ? undefined : choices.find((c) => sameModel(c, model));
  if (hit === undefined || !hit.reasoning) {
    if (hit === undefined && stored !== undefined) {
      return { text: stored, source: "agent", live: false };
    }
    return { text: "n/a", source: null, live: false };
  }
  if (stored !== undefined) return { text: stored, source: "agent", live: true };
  const inherited = efforts[agent];
  if (typeof inherited === "string" && inherited.length > 0) {
    return { text: inherited, source: "opencode", live: true };
  }
  return { text: EFFORT_LADDER[0], source: null, live: true };
}

// Label for a context ceiling: thousands of tokens, or "off" for the 0 that
// disables the budget for that agent type — the same distinction "unlimited"
// draws on the subagent cap.
function formatContextCeiling(tokens: number): string {
  return tokens === 0 ? "off" : String(tokens / 1000);
}

// Label for the result ceiling: whole tokens, not thousands, because the value
// lives in the low thousands and rounding it to a k would hide every step the
// row takes. "off" is the 0 that lets a whole reply through uncut — the same
// reading the budget row's 0 has, and the opposite of the reuse row's 0.
function formatResultCeiling(tokens: number): string {
  return tokens === 0 ? "off" : String(tokens);
}

function formatLlmValue(value: number | null, decimals: number): string {
  if (value === null) return "not set";
  if (decimals === 0) return String(Math.round(value));
  return value.toFixed(decimals);
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

// The colour of a row's dot. A held row is finished but not gone, so it takes
// neither the green of a completed run nor the colour of a running one; a
// waiting row is work in flight that opencode reports no run fiber for, so it
// is muted rather than green — green would read as done.
function statusColor(status: SubagentStatus, theme: TuiThemeCurrent) {
  switch (status) {
    case "busy":
      return theme.warning;
    case "retry":
      return theme.info;
    case "retained":
      return theme.info;
    case "aborted":
    case "error":
      return theme.error;
    default:
      return theme.textMuted;
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
  // The one subagent whose abort has been asked for once and is waiting for the
  // confirming second request. Undefined while nothing is armed.
  const [armedAbort, setArmedAbort] = createSignal<ArmedAbort | undefined>();
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
  const showAgentcom = (): boolean => settings().showAgentcom;

  // Every store call hands back the whole merged file state, so one place puts
  // it into the signal — the panel then shows the true file state, including
  // the keys the write did not touch.
  const showSettings = (s: Settings): void => {
    setSettingsState(s);
  };

  // Step a setting by delta and save. Deltas are in the setting's own unit:
  // subagents ±1, endless context ±10000 tokens (= 10k on the display),
  // retained subagents ±1, the retention window ±1 minute in milliseconds. The
  // floor is the store's, one per key: maxSubagents=0 means "no cap" (unlimited
  // concurrent subagents), endlessContext=0 arms no endless cycle,
  // maxRetainedSubagents=0 switches retention off, and the window stops at one
  // whole minute because it has no off state of its own.
  const adjustSetting = (key: LimitKey, delta: number): void => {
    // Read-modify-write inside the store: the file may have been edited outside
    // the panel since the last read, so the base value comes from the file and
    // only the stepped limit goes into what disk currently holds. The merged
    // result is what the signals show from here on.
    showSettings(stepSetting(key, delta));
  };

  // Flip endless mode and save. Same read-modify-write: the value flipped is
  // the one on disk, not the panel's copy, which may be stale — the plugin
  // writes this key back to false itself when one of the mode's bounds ends the
  // loop.
  const toggleEndless = (): void => {
    showSettings(toggleEndlessMode());
  };

  // Flip the agentcom visibility switch and save. Read-modify-write like the
  // one above: the value flipped is the one on disk, which a hand edit may have
  // changed since the panel read it.
  const toggleAgentcom = (): void => {
    showSettings(toggleShowAgentcom());
  };

  // Section collapse state. Subagents-section is the workhorse and stays open
  // by default; tui-settings + LLM params are tucked away to keep the sidebar
  // compact.
  const [subagentsExpanded, setSubagentsExpanded] = createSignal(true);
  const [tuiSettingsExpanded, setTuiSettingsExpanded] = createSignal(false);
  const [promptsExpanded, setPromptsExpanded] = createSignal(false);

  // LLM-parameter overrides, shared with the main plugin's chat.params hook.
  // Cycling through AGENT_NAMES lets the user tune one role at a time without
  // inflating the UI to a grid.
  const [llmParams, setLlmParams] = createSignal<LlmParams>(readLlmParams());
  // Per-agent model choice, shared with the main plugin's chat.message hook.
  const [llmModels, setLlmModels] = createSignal<LlmModels>(readLlmModels());
  const [llmExpanded, setLlmExpanded] = createSignal(false);
  const [llmAgentIdx, setLlmAgentIdx] = createSignal(0);
  const currentLlmAgent = (): string => AGENT_NAMES[llmAgentIdx()];

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
  // The effort side of the same fetch: the reasoning effort opencode resolved
  // per agent, shown on the effort row when the file holds none. Its own signal
  // rather than a key of OpencodeDefaults, which is typed to numbers.
  const [opencodeEfforts, setOpencodeEfforts] = createSignal<Record<string, string>>({});
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
      const efforts: Record<string, string> = {};
      for (const a of list) {
        if (!a || typeof a.name !== "string") continue;
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
        const effort = probeAgentEffort(opts);
        if (effort !== null) efforts[a.name] = effort;
        map[a.name] = entry;
      }
      if (!disposed) {
        setOpencodeDefaults(map);
        setOpencodeModels(models);
        setOpencodeEfforts(efforts);
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
        models?: Record<
          string,
          {
            id?: string;
            providerID?: string;
            name?: string;
            capabilities?: { reasoning?: boolean; input?: { image?: boolean } };
          }
        >;
      }>;
      const list: ModelChoice[] = [];
      for (const p of providers) {
        for (const m of Object.values(p?.models ?? {})) {
          const providerID = m?.providerID ?? p?.id;
          const modelID = m?.id;
          if (typeof providerID !== "string" || typeof modelID !== "string") continue;
          if (providerID === "" || modelID === "") continue;
          list.push({
            providerID,
            modelID,
            label: m?.name || modelID,
            // Strict tests: a provider list without the block reads as "no
            // capability" rather than as unknown.
            vision: m?.capabilities?.input?.image === true,
            reasoning: m?.capabilities?.reasoning === true,
          });
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
    setLlmAgentIdx((i) => (i + delta + AGENT_NAMES.length) % AGENT_NAMES.length);
    refreshFileState();
    void refreshOpencodeDefaults();
  };

  // Step the selected agent's context ceiling and save. The agent is the LLM
  // section's own selection, and the list frozen on the first such step — see
  // stepAgentContext — is that cycler's whole list, AGENT_NAMES: exactly the
  // types the row can be pointed at. Every name in it resolves to a defined
  // effective value, the built-in table or the flat ceiling behind it.
  const adjustAgentContext = (delta: number): void => {
    showSettings(stepAgentContext(currentLlmAgent(), delta, AGENT_NAMES));
  };

  // Step the selected agent's reuse ceiling and save. The same cycler picks the
  // type for all three ceiling rows, and the same freeze applies on the first
  // step — see stepReuseContext.
  const adjustReuseContext = (delta: number): void => {
    showSettings(stepReuseContext(currentLlmAgent(), delta, AGENT_NAMES));
  };

  // Step the selected agent's result ceiling and save. Third row on the same
  // cycler, same freeze on the first step — see stepResultTokens.
  const adjustResultTokens = (delta: number): void => {
    showSettings(stepResultTokens(currentLlmAgent(), delta, AGENT_NAMES));
  };

  // Walk the pick list by one. Position and write are one read-modify-write in
  // the store, so a choice made outside the panel is stepped from rather than
  // overwritten, and the merged result is what the signal shows from here on.
  const cycleModel = (delta: number): void => {
    setLlmModels(cycleLlmModel(currentLlmAgent(), delta, modelChoices()));
  };

  // Walk the effort ladder by one for the selected agent. The model the effort
  // was chosen for is written with it, so an agent still on opencode's own
  // model gains the full entry — and its ★ on the model row — in the same step.
  // Position and write are one read-modify-write in the store, as on the model
  // row. Without a resolved model there is nothing to pin the effort to; the
  // row's buttons are inert in that state anyway.
  const cycleEffort = (delta: number): void => {
    const agent = currentLlmAgent();
    const model = resolveLlmModel(llmModels(), opencodeModels(), agent).value;
    if (model === null) return;
    setLlmModels(cycleLlmVariant(agent, delta, model));
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

  // Sessions whose children the poll asks for. Seeded from this panel's own
  // route/slot session and from nothing else: being somebody's parent is what a
  // subagent that spawns a subagent does, and it must not promote that subagent
  // into an orchestrator — that is what used to make a nested parent's row
  // vanish and freeze.
  const polledIDs = new Set<string>();
  // Every session ever listed as another session's child, or created carrying a
  // parentID. This is the panel's answer to "is this a subagent", and it
  // mirrors the rule the server half applies (src/registry.js: a session that
  // has a registry entry is a subagent, and a subagent is never a primary).
  // It only grows: what has once been spawned as a subagent stays one.
  const subagentIDs = new Set<string>();
  // The children the last COMPLETED poll pass listed. Used by the idle handler,
  // which must not treat a session the server still lists as one that is over.
  let listed: ReadonlySet<string> = new Set<string>();
  // Sessions the user aborted from this panel — the server status alone does
  // not distinguish an abort from any other ending, so we remember it locally.
  const aborted = new Set<string>();
  // Subagents whose row has gone, each with the row it was when it went — kept
  // so an optimistic insert does not re-add a session that is over, and so a
  // row the poll lists again comes back exactly as it stood, under its own
  // handle rather than a fresh one.
  //
  // A row lands here only where something said the subagent is over: opencode
  // published `session.deleted` for it, the reap found it gone from a completed
  // pass, or it was dropped from this panel. The poll no longer files rows here
  // on a status it happened to observe.
  const finished = new Map<string, SubagentEntry | undefined>();
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

  // Whether this session is an orchestrator: one this panel has been rendered
  // for that was never spawned as a subagent. It is the one test for "never a
  // row of its own", and both the poll and the row list take it, so the two
  // cannot drift apart. A subagent the user has navigated into is polled for
  // its own children and still keeps its row in its parent's list.
  const isPrimarySession = (sessionID: string): boolean =>
    polledIDs.has(sessionID) && !subagentIDs.has(sessionID);

  // Whether a row that is going counts as one more completed run. A held row
  // was counted when its run ended and is not counted again when the session it
  // was held on finally goes; an abort is not a completed run either.
  const countableDone = (
    entry: SubagentEntry | undefined,
    sessionID: string,
  ): boolean =>
    entry !== undefined && !isRetained(entry) && !aborted.has(sessionID);

  // Take one row out of a rows map and remember it as gone, with the selection
  // and the local abort mark cleared. The map is either the panel's own state
  // or the one a poll pass is building.
  const retireRow = (
    rows: Map<string, SubagentEntry>,
    sessionID: string,
  ): void => {
    finished.set(sessionID, rows.get(sessionID));
    rows.delete(sessionID);
    aborted.delete(sessionID);
    if (selectedID() === sessionID) setSelectedID(undefined);
  };

  // A row built from a poll's child record alone, for a session this panel
  // holds no memory of: a subagent spawned before this panel existed, or one
  // whose row was rebuilt inside the plugin's retention window.
  const rowFromChild = (
    child: SessionChild,
    primaryID: string,
  ): SubagentEntry => {
    const agent = child.agent ?? "subagent";
    return {
      sessionID: child.id,
      parentID: child.parentID ?? primaryID,
      agent,
      handle: nextHandle(agent),
      title: child.title ?? "",
      status: "waiting",
      wasBusy: false,
      createdAt: child.time?.created ?? Date.now(),
      updatedAt: child.time?.updated ?? Date.now(),
      ctxTokens: undefined,
      lastTokenFetch: 0,
    };
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
      // One clock for the whole pass: a row held in this pass and the window
      // left on a row held in an earlier one are measured against the same
      // moment.
      const now = Date.now();

      for (const parentID of polledIDs) {
        const childRes = await api.client.session.children({
          sessionID: parentID,
        });
        const childRead = readSessionChildren(childRes);
        if (childRead.kind === "missing") {
          polledIDs.delete(parentID);
          continue;
        }
        if (childRead.kind === "error") {
          throw new Error("session.children failed");
        }
        for (const child of childRead.children) {
          seen.add(child.id);
          // Listed as somebody's child: a subagent, now and for good.
          subagentIDs.add(child.id);
          // An orchestrator session is never a subagent row. It can only be one
          // this panel is rendered for that has never been spawned as a
          // subagent — being a parent no longer qualifies.
          if (isPrimarySession(child.id)) continue;

          // The row this session already has, or the one it went with. Either
          // way it is the row that comes back: a session the poll still lists
          // is one the plugin has not finished with, so a row filed away by an
          // event the pass has since disproved is taken back under its own
          // handle rather than re-created as a fresh subagent.
          const existing = next.get(child.id);
          const remembered = existing ?? finished.get(child.id);
          finished.delete(child.id);
          const base = remembered ?? rowFromChild(child, parentID);

          const decision = decideRow({
            sessionID: child.id,
            aborted: aborted.has(child.id),
            title: child.title,
            serverStatus: statuses[child.id]?.type,
          });

          // Upgrade the placeholder handle once the real agent name is known
          // (session.created often fires before the agent is assigned).
          const agent = child.agent ?? base.agent;
          const handle =
            base.agent !== "subagent"
              ? base.handle
              : agent !== "subagent"
                ? nextHandle(agent)
                : base.handle;

          // A run that has ended in a hold counts as done once, on the
          // transition into the held state — not on every poll that finds the
          // row still held, and not again when the held session finally goes.
          if (decision.kind === "hold" && !isRetained(existing)) {
            completedDelta += 1;
          }

          next.set(
            child.id,
            assembleSubagentEntry(base, child, parentID, decision, handle),
          );
        }
      }
      // This pass completed, so `seen` is the whole truth about what the server
      // still lists under the sessions it asked about — and a session the
      // server no longer lists is one the plugin has deleted, which it does at
      // every ending it controls. A row out of the pass's reach (a child of a
      // session nobody asked about) was not disproved and stays. `session.
      // deleted` normally gets there first; this is the backstop for the event
      // that was missed, and for the held row whose window ran out with the
      // session still standing.
      listed = seen;
      for (const sessionID of reapRows(
        next.values(),
        { seen, polled: polledIDs },
        now,
      )) {
        if (countableDone(next.get(sessionID), sessionID)) completedDelta += 1;
        retireRow(next, sessionID);
      }

      if (completedDelta > 0) {
        setCompletedCount((count) => count + completedDelta);
      }

      // Refresh context-token counts (throttled per entry).
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

  // Put one session into the set whose children the poll asks for. Only this
  // panel's own route/slot session is ever passed in: a session seen as some
  // other session's parent is a subagent that has spawned, and asking for its
  // children is the slot's business when the panel is rendered for it. Deleted
  // sessions leave this set on their event or on the next 404 response.
  const trackPolled = (sessionID: string | undefined): void => {
    // Hard gate: only real session IDs (ses_*) may enter the polled set. Some
    // event payloads carry a parentID that is NOT a session — e.g.
    // message.updated's info.parentID is the previous MESSAGE (msg_*). A
    // non-session ID in polledIDs makes the fallback poll call
    // session.children({sessionID: "msg_…"}) forever, which the server
    // rejects with a schema error on every tick.
    if (!sessionID || !sessionID.startsWith("ses_")) return;
    if (polledIDs.has(sessionID)) return;
    polledIDs.add(sessionID);
    scheduleRefresh();
  };

  const openSubagent = (id: string): void => {
    api.route.navigate("session", { sessionID: id });
  };

  // Ending a retention from the panel. A held subagent has finished, so there
  // is no run to abort: what ends the hold is the session going away, which is also
  // what every plugin-side end of a retention does. The plugin notices on its
  // own — a reuse against a session with no messages left refuses and drops the
  // handle — and the row goes as soon as the poll stops listing the session.
  // The row is dropped here as well so the panel answers the keypress at once;
  // a failed delete leaves it standing, because the session is then still there.
  const dropRetained = async (id: string): Promise<void> => {
    const entry = subagents().get(id);
    try {
      await api.client.session.delete({ sessionID: id });
    } catch {
      api.ui.toast({
        variant: "error",
        message: `Drop failed for ${entry?.handle ?? id}`,
      });
      scheduleRefresh();
      return;
    }
    api.ui.toast({
      variant: "warning",
      message: `Dropped ${entry?.handle ?? id} — its session is gone`,
    });
    const next = new Map(subagents());
    retireRow(next, id);
    setSubagents(next);
    scheduleRefresh();
  };

  const abortSubagent = async (id: string): Promise<void> => {
    const entry = subagents().get(id);
    if (isRetained(entry)) {
      await dropRetained(id);
      return;
    }
    aborted.add(id);
    try {
      await api.client.session.abort(
        { sessionID: id },
        { throwOnError: true },
      );
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
      // A failed request did not start a teardown, so the local mark must not
      // turn the next poll into a false aborted row.
      aborted.delete(id);
      api.ui.toast({ variant: "error", message: `Abort failed for ${id}` });
    }
    scheduleRefresh();
  };

  // Every way to abort — the row's cross, the `x`/`d` keys and the abort
  // command — goes through this one request, so none of them can kill a session
  // on a single press. The first request arms the entry and the row asks for
  // the confirmation; the second request for that same entry aborts.
  let armTimer: ReturnType<typeof setTimeout> | undefined;
  const disarmAbort = (): void => {
    if (armTimer) {
      clearTimeout(armTimer);
      armTimer = undefined;
    }
    if (armedAbort()) setArmedAbort(undefined);
  };
  const requestAbort = (id: string): void => {
    const decision = decideAbort(armedAbort(), id, Date.now());
    disarmAbort();
    if (decision.kind === "abort") {
      void abortSubagent(id);
      return;
    }
    setArmedAbort(decision.armed);
    // The arming expires on its own, so a row left in the confirm state does
    // not stay a single keypress away from an abort.
    armTimer = setTimeout(() => {
      armTimer = undefined;
      setArmedAbort(undefined);
    }, ABORT_CONFIRM_MS);
  };
  // Moving the selection to another entry takes the arming with it.
  createEffect(() => {
    const kept = armingAfterSelection(armedAbort(), selectedID());
    if (!kept && armedAbort()) disarmAbort();
  });

  // Keyboard: Alt+A focuses the list; the focus-aware handler lives in the
  // panel component (so it only fires while the panel box is focused).
  const focusList = (): void => {
    setListFocused(true);
  };
  const abortSelected = (): void => {
    const id = selectedID();
    if (id) requestAbort(id);
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

  // A session changed, errored or changed status. Nothing is read off the
  // payload: which sessions the poll asks about is the slot's business alone,
  // and what a session's status is the poll reads for itself. The event is a
  // trigger and nothing more.
  const onSessionEvent = (): void => {
    scheduleRefresh();
  };

  // message.updated's info is a Message whose parentID points at the previous
  // MESSAGE in the chain (msg_*), not at a session. Only a refresh trigger.
  const onMessageEvent = (): void => {
    scheduleRefresh();
  };

  // A child session being created is a subagent spawn: the row appears at once,
  // waiting, which is what it is — the plugin forks the run only after the
  // session exists, so opencode reports no run in it yet. The parent is NOT
  // taken as an orchestrator here; a session that spawns is a subagent doing
  // its work and keeps its own row.
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
    subagentIDs.add(info.id);
    const current = subagents();
    if (
      !current.has(info.id) &&
      !finished.has(info.id) &&
      !isPrimarySession(info.id)
    ) {
      const agent = info.agent ?? "subagent";
      const next = new Map(current);
      next.set(info.id, {
        sessionID: info.id,
        parentID: info.parentID,
        agent,
        handle: nextHandle(agent),
        title: info.title ?? "",
        status: "waiting",
        wasBusy: false,
        createdAt: info.time?.created ?? Date.now(),
        updatedAt: info.time?.updated ?? Date.now(),
        ctxTokens: undefined,
        lastTokenFetch: 0,
      });
      setSubagents(next);
    }
    scheduleRefresh();
  };

  // `session.idle` says one thing and one thing only: opencode has no run fiber
  // in that session at this moment. It is not the end of a subagent — a nested
  // spawn, a run not yet forked and a retained session being re-prompted are
  // all idle — so it no longer takes a row. The row ends where the plugin ends
  // the subagent, which is `session.deleted`.
  //
  // What stays here is the route: if the user is viewing this session and it is
  // about to be torn down, the view has to be moved off it before the session
  // goes, otherwise the route points at a missing session and the TUI falls
  // back to the start page, losing the orchestrator chat. The jump is held back
  // for a session the last completed poll still listed with no retention stamp
  // on it: that is a subagent the plugin has not finished with, and yanking the
  // user out of a session that goes on working is the same mistake as dropping
  // its row.
  const onSessionIdle = (event: unknown): void => {
    const sessionID = (event as { properties?: { sessionID?: string } })
      .properties?.sessionID;
    const entry = sessionID ? subagents().get(sessionID) : undefined;
    if (sessionID && entry && entry.parentID) {
      const stillWorking = listed.has(sessionID) && !isRetained(entry);
      if (
        !stillWorking &&
        api.route.current.name === "session" &&
        (api.route.current.params?.sessionID as string | undefined) ===
          sessionID
      ) {
        api.route.navigate("session", { sessionID: entry.parentID });
      }
    }
    scheduleRefresh();
  };

  // The plugin deletes a subagent's session at every ending it controls
  // (teardownSubagent), so this event is the end of the row — the one signal
  // that means "finished" rather than "not running just now". A row the panel
  // never had is nothing to do here; a row that is still on screen goes, and
  // the route follows it out if the user was inside that session.
  const onSessionDeleted = (event: unknown): void => {
    const sessionID = (event as { properties?: { info?: { id?: string } } })
      .properties?.info?.id;
    // A deleted session cannot produce children again. Remove it before the
    // next fallback pass, including when no row was present for the event.
    if (sessionID) polledIDs.delete(sessionID);
    const current = sessionID ? subagents() : undefined;
    const entry = sessionID && current ? current.get(sessionID) : undefined;
    if (sessionID && current && entry) {
      if (
        entry.parentID &&
        api.route.current.name === "session" &&
        (api.route.current.params?.sessionID as string | undefined) ===
          sessionID
      ) {
        api.route.navigate("session", { sessionID: entry.parentID });
      }
      const done = countableDone(entry, sessionID);
      const next = new Map(current);
      retireRow(next, sessionID);
      setSubagents(next);
      if (done) setCompletedCount((count) => count + 1);
    }
    scheduleRefresh();
  };

  const disposers = [
    api.event.on("session.created", onSessionCreated),
    api.event.on("session.updated", onSessionEvent),
    api.event.on("session.idle", onSessionIdle),
    api.event.on("session.deleted", onSessionDeleted),
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
    if (armTimer) clearTimeout(armTimer);
    commandDispose();
    stopHoldRepeat();
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
        trackPolled(sessionID);
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
            armedAbort={armedAbort}
            onDisarmAbort={disarmAbort}
            completedCount={completedCount}
            isPrimary={isPrimarySession}
            onOpen={openSubagent}
            onAbort={requestAbort}
            maxSubagents={maxSubagents}
            settings={settings}
            onAdjustContext={adjustAgentContext}
            onAdjustReuse={adjustReuseContext}
            onAdjustResultTokens={adjustResultTokens}
            endlessMode={endlessMode}
            endlessContext={endlessContext}
            onAdjust={adjustSetting}
            onToggleEndless={toggleEndless}
            showAgentcom={showAgentcom}
            onToggleShowAgentcom={toggleAgentcom}
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
            opencodeEfforts={opencodeEfforts}
            onCycleLlmEffort={cycleEffort}
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

function SubagentPanel(props: {
  sessionID: string;
  subagents: () => Map<string, SubagentEntry>;
  nowMs: () => number;
  pulseOn: () => boolean;
  listFocused: () => boolean;
  setListFocused: (focused: boolean) => void;
  selectedID: () => string | undefined;
  setSelectedID: (id: string | undefined) => void;
  // The entry whose abort is armed and waiting for its confirming second
  // request, and the way to take that arming back.
  armedAbort: () => ArmedAbort | undefined;
  onDisarmAbort: () => void;
  completedCount: () => number;
  isPrimary: (id: string) => boolean;
  onOpen: (id: string) => void;
  // Asks for the abort of one entry: the first ask arms it, the second aborts.
  onAbort: (id: string) => void;
  maxSubagents: () => number;
  // The whole resolved settings state: the context row works its ceiling out of
  // three of its members at once.
  settings: () => Settings;
  // The three per-agent ceiling rows sit in the LLM params body and read the
  // agent from `llmAgent` below.
  onAdjustContext: (delta: number) => void;
  onAdjustReuse: (delta: number) => void;
  onAdjustResultTokens: (delta: number) => void;
  endlessMode: () => boolean;
  endlessContext: () => number;
  onAdjust: (key: LimitKey, delta: number) => void;
  onToggleEndless: () => void;
  showAgentcom: () => boolean;
  onToggleShowAgentcom: () => void;
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
  opencodeEfforts: () => Record<string, string>;
  onCycleLlmEffort: (delta: number) => void;
  llmExpanded: () => boolean;
  onToggleLlm: () => void;
  llmAgent: () => string;
  onCycleLlmAgent: (delta: number) => void;
  onAdjustLlmParam: (def: LlmParamDef, delta: number) => void;
  onResetLlmAgent: () => void;
  theme: TuiThemeCurrent;
}) {
  // Every subagent of the session this panel is rendered for, whatever its
  // status. A row is here because its session is still listed as a child of
  // this one and the plugin has not finished with it — including a subagent
  // that has spawned a subagent of its own, which is a parent and a subagent
  // at the same time. `isPrimary` excludes only an orchestrator session, i.e.
  // one this panel is rendered for that was never spawned as a subagent.
  const rows = createMemo(() => {
    const own = [...props.subagents().values()].filter(
      (entry) =>
        entry.parentID === props.sessionID &&
        entry.sessionID !== props.sessionID &&
        !props.isPrimary(entry.sessionID),
    );
    return own.sort((a, b) => {
      const byRank = statusRank(a.status) - statusRank(b.status);
      if (byRank !== 0) return byRank;
      return a.createdAt - b.createdAt;
    });
  });

  const rowIDs = createMemo(() => rows().map((entry) => entry.sessionID));

  // If the panel is rendered inside a subagent's own session, offer a way back
  // to the orchestrator that spawned it.
  const currentSub = createMemo(() => props.subagents().get(props.sessionID));

  // A subagent is removed from `rows` when the plugin has finished with it, so
  // "running" counts the rows opencode reports a run fiber for, "retained" the
  // held rows, and "done" is the cumulative count of subagents whose run has
  // completed — the held ones included, their run being over. A waiting row is
  // neither: it is work in flight that opencode has no run fiber for.
  const counts = createMemo(() => {
    let running = 0;
    let retained = 0;
    for (const entry of rows()) {
      if (entry.status === "busy" || entry.status === "retry") running += 1;
      else if (entry.status === "retained") retained += 1;
    }
    return { running, retained, done: props.completedCount() };
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
      // Escape takes back a pending abort question first; only a second Escape
      // gives the panel's focus up.
      if (props.armedAbort()) props.onDisarmAbort();
      else blurPanel();
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
    // While this row's abort is armed the label area carries the question
    // instead of the label, so the confirm state cannot be missed. It is cut to
    // the same budget the label has, so it stays on the one line too.
    const armed = createMemo(() =>
      isAbortArmed(props.armedAbort(), rowProps.entry.sessionID, props.nowMs()),
    );
    const rowText = createMemo(() =>
      armed()
        ? truncate(
            isRetained(rowProps.entry) ? DROP_CONFIRM_TEXT : ABORT_CONFIRM_TEXT,
            subagentLabelWidth(panelWidth()),
          )
        : label(),
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
          <text
            fg={armed() ? props.theme.error : props.theme.text}
            onMouseDown={openThis}
          >
            {rowText()}
          </text>
          <text fg={props.theme.textMuted}> </text>
          <text
            fg={armed() ? props.theme.accent : props.theme.error}
            onMouseDown={abortThis}
          >
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
          {/* A held row says so and says how long it still has. The countdown
              is in whole minutes, the same figure and the same word the `list`
              tool and the orchestrator's per-turn snapshot carry for it. */}
          <Show when={isRetained(rowProps.entry)}>
            <text fg={props.theme.info}>
              {` · ${retainedRowNote(rowProps.entry, props.nowMs())}`}
            </text>
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
                {/* Only where something is actually being held: with retention
                    at its default of 0 this line stays what it always was. */}
                <Show when={counts().retained > 0}>
                  <text fg={props.theme.textMuted}> · </text>
                  <text fg={props.theme.info}>{`◆ ${counts().retained} retained`}</text>
                </Show>
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
            <text fg={props.theme.accent} {...holdRepeat("max-subagents-decrease", () => props.onAdjust("maxSubagents", -1))}>
              {"[-]"}
            </text>
            <text fg={props.theme.text}>{numCell(props.maxSubagents() === 0 ? "unlimited" : props.maxSubagents())}</text>
            <text fg={props.theme.accent} {...holdRepeat("max-subagents-increase", () => props.onAdjust("maxSubagents", 1))}>
              {"[+]"}
            </text>
          </box>
          {/* Retention: how many finished subagents are held as re-promptable
              sessions at once, and for how long one of them is held. "off" is a
              count of 0 — the shipped default, at which a finished subagent is
              destroyed the moment its result is delivered. The window is shown
              and stepped in whole minutes and has no off state of its own: it
              is switched off through the count above it. */}
          <box flexDirection="row">
            <text fg={props.theme.textMuted}>{rowLabel("retained subs")}</text>
            <text
              fg={props.theme.accent}
              {...holdRepeat("retained-subagents-decrease", () => props.onAdjust("maxRetainedSubagents", -1))}
            >
              {"[-]"}
            </text>
            <text fg={props.theme.text}>
              {numCell(
                props.settings().maxRetainedSubagents === 0
                  ? "off"
                  : props.settings().maxRetainedSubagents,
              )}
            </text>
            <text
              fg={props.theme.accent}
              {...holdRepeat("retained-subagents-increase", () => props.onAdjust("maxRetainedSubagents", 1))}
            >
              {"[+]"}
            </text>
          </box>
          <box flexDirection="row">
            <text fg={props.theme.textMuted}>{rowLabel("retain (min)")}</text>
            <text
              fg={props.theme.accent}
              {...holdRepeat(
                "retained-subagent-ttl-decrease",
                () => props.onAdjust("retainedSubagentTtlMs", -RETAINED_SUBAGENT_TTL_STEP_MS),
              )}
            >
              {"[-]"}
            </text>
            <text fg={props.theme.text}>
              {numCell(
                Math.round(
                  props.settings().retainedSubagentTtlMs / RETAINED_SUBAGENT_TTL_STEP_MS,
                ),
              )}
            </text>
            <text
              fg={props.theme.accent}
              {...holdRepeat(
                "retained-subagent-ttl-increase",
                () => props.onAdjust("retainedSubagentTtlMs", RETAINED_SUBAGENT_TTL_STEP_MS),
              )}
            >
              {"[+]"}
            </text>
          </box>
          <box flexDirection="row">
            <text fg={props.theme.textMuted}>{rowLabel("endless mode")}</text>
            <text
              fg={props.endlessMode() ? props.theme.success : props.theme.textMuted}
              onMouseDown={props.onToggleEndless}
            >
              {props.endlessMode() ? "[on] " : "[off]"}
            </text>
          </box>
          <box flexDirection="row">
            <text fg={props.theme.textMuted}>{rowLabel("endless (k)")}</text>
            <text fg={props.theme.accent} {...holdRepeat("endless-context-decrease", () => props.onAdjust("endlessContext", -10000))}>
              {"[-]"}
            </text>
            <text fg={props.theme.text}>{numCell(props.endlessContext() / 1000)}</text>
            <text fg={props.theme.accent} {...holdRepeat("endless-context-increase", () => props.onAdjust("endlessContext", 10000))}>
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
          {/* On, the plugin's own postings render in the transcript; off, they
              are stamped synthetic and only the model still receives them. */}
          <box flexDirection="row">
            <text fg={props.theme.textMuted}>{rowLabel("show agentcom")}</text>
            <text
              fg={props.showAgentcom() ? props.theme.success : props.theme.textMuted}
              onMouseDown={props.onToggleShowAgentcom}
            >
              {props.showAgentcom() ? "[on] " : "[off]"}
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
            const badges = createMemo(() =>
              modelBadges(resolvedModel().value, props.modelChoices()),
            );
            const effort = createMemo(() =>
              resolveLlmEffort(
                props.llmModels(),
                props.opencodeEfforts(),
                props.modelChoices(),
                props.llmAgent(),
                resolvedModel().value,
              ),
            );
            const badgeColour = (glyph: string) =>
              glyph === "V" || glyph === "R" ? props.theme.success : props.theme.textMuted;
            // Built once, outside the JSX, for a stable handler pair. The
            // `live` gate stays inside the action, so the row remains wired while
            // inert and a model without reasoning still shows muted, dead [<] [>].
            const cycleEffort = (delta: number): void => {
              if (effort().live) props.onCycleLlmEffort(delta);
            };
            const effortDown = holdRepeat("llm-effort-decrease", () => cycleEffort(-1));
            const effortUp = holdRepeat("llm-effort-increase", () => cycleEffort(1));
            return (
              <>
                <box flexDirection="row">
                  <text fg={props.theme.textMuted}>{rowLabel("model")}</text>
                  <text
                    fg={props.theme.accent}
                    {...holdRepeat("llm-model-decrease", () => props.onCycleLlmModel(-1))}
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
                    {...holdRepeat("llm-model-increase", () => props.onCycleLlmModel(1))}
                  >
                    {"[>]"}
                  </text>
                  {/* Two columns whether or not the ★ is there, so the badge
                      cell beside it never shifts sideways. */}
                  <text fg={props.theme.success}>
                    {resolvedModel().source === "agent" ? " ★" : "  "}
                  </text>
                  {/* Vision and reasoning of the model under the cursor, one
                      <text> each so the two carry their own colour. */}
                  <text fg={badgeColour(badges().vision)}>{` ${badges().vision}`}</text>
                  <text fg={badgeColour(badges().reasoning)}>{badges().reasoning}</text>
                </box>
                {/* Reasoning effort for the same agent. Inert — muted
                    buttons, a dead cycler — where the model cannot take an
                    effort or is unknown. An effort opencode resolved rather
                    than one chosen here shows muted and in parentheses. */}
                <box flexDirection="row">
                  <text fg={props.theme.textMuted}>{rowLabel("effort")}</text>
                  <text
                    fg={effort().live ? props.theme.accent : props.theme.textMuted}
                    {...effortDown}
                  >
                    {"[<]"}
                  </text>
                  <text
                    fg={effort().source === "opencode" ? props.theme.textMuted : props.theme.text}
                  >
                    {fitCell(formatLlmEffort(effort().text, effort().source), MODEL_NAME_W)}
                  </text>
                  <text
                    fg={effort().live ? props.theme.accent : props.theme.textMuted}
                    {...effortUp}
                  >
                    {"[>]"}
                  </text>
                  <text fg={props.theme.success}>
                    {effort().source === "agent" ? " ★" : "  "}
                  </text>
                </box>
              </>
            );
          })()}
          {/* Context ceiling of the agent the row above picks: the same
              [<]/[>] cycler that chooses the model and the effort chooses the
              type whose own ceiling these three rows step. ★ marks a type
              carrying a value of its own; without one the row shows the
              inherited ceiling, and [-] below zero drops the own value so the
              inherited one shows again. "off" is a ceiling of 0, i.e. no budget
              for that type. */}
          {(() => {
            const ceiling = createMemo(() =>
              effectiveAgentContext(props.settings(), props.llmAgent()),
            );
            return (
              <box flexDirection="row">
                <text fg={props.theme.textMuted}>{rowLabel("max Token(k)")}</text>
                <text
                  fg={props.theme.accent}
                  {...holdRepeat("context-decrease", () => props.onAdjustContext(-CONTEXT_STEP))}
                >
                  {"[-]"}
                </text>
                <text fg={props.theme.text}>
                  {numCell(formatContextCeiling(ceiling().value), CEILING_NUM_W)}
                </text>
                <text
                  fg={props.theme.accent}
                  {...holdRepeat("context-increase", () => props.onAdjustContext(CONTEXT_STEP))}
                >
                  {"[+]"}
                </text>
                <Show when={ceiling().source === "agent"}>
                  <text fg={props.theme.success}>{" ★"}</text>
                </Show>
              </box>
            );
          })()}
          {/* Reuse ceiling of the same agent type, picked by the same cycler:
              the context above which a finished subagent of that type is never
              held and never re-prompted. ★ marks a type carrying a value of its
              own exactly as on the budget row, and [-] below zero drops that
              value so the inherited ceiling shows again. A 0 is spelled out,
              because here it is the strictest value on the row — this type is
              never reused — and not the "off" the budget row's 0 means. */}
          {(() => {
            const ceiling = createMemo(() =>
              effectiveReuseContext(props.settings(), props.llmAgent()),
            );
            return (
              <box flexDirection="row">
                <text fg={props.theme.textMuted}>{rowLabel("reuse Token(k)")}</text>
                <text
                  fg={props.theme.accent}
                  {...holdRepeat("reuse-context-decrease", () => props.onAdjustReuse(-CONTEXT_STEP))}
                >
                  {"[-]"}
                </text>
                <text fg={props.theme.text}>
                  {numCell(ceiling().value / 1000, CEILING_NUM_W)}
                </text>
                <text
                  fg={props.theme.accent}
                  {...holdRepeat("reuse-context-increase", () => props.onAdjustReuse(CONTEXT_STEP))}
                >
                  {"[+]"}
                </text>
                <Show when={ceiling().source === "agent"}>
                  <text fg={props.theme.success}>{" ★"}</text>
                </Show>
                <Show when={ceiling().value === 0}>
                  <text fg={props.theme.textMuted}>{" never"}</text>
                </Show>
              </box>
            );
          })()}
          {/* Result ceiling of the same agent type, picked by the same cycler:
              how many tokens of that type's final reply reach the orchestrator.
              Everything past it is cut out of the wake notice and written to a
              file the notice names. Whole tokens rather than thousands, and its
              own smaller step, because the value lives in the low thousands. ★
              marks a type carrying a value of its own as on the two rows above,
              and [-] below zero drops that value so the inherited ceiling shows
              again. "off" is a ceiling of 0, i.e. that type's reply is never
              cut. */}
          {(() => {
            const ceiling = createMemo(() =>
              effectiveResultTokens(props.settings(), props.llmAgent()),
            );
            return (
              <box flexDirection="row">
                <text fg={props.theme.textMuted}>{rowLabel("result Token")}</text>
                <text
                  fg={props.theme.accent}
                  {...holdRepeat("result-tokens-decrease", () => props.onAdjustResultTokens(-RESULT_TOKEN_STEP))}
                >
                  {"[-]"}
                </text>
                <text fg={props.theme.text}>
                  {numCell(formatResultCeiling(ceiling().value), CEILING_NUM_W)}
                </text>
                <text
                  fg={props.theme.accent}
                  {...holdRepeat("result-tokens-increase", () => props.onAdjustResultTokens(RESULT_TOKEN_STEP))}
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
                    {...holdRepeat(`llm-param-${def.key}-decrease`, () => props.onAdjustLlmParam(def, -def.step))}
                  >
                    {"[-]"}
                  </text>
                  <text fg={props.theme.text}>
                    {numCell(formatLlmValue(resolved().value, def.decimals), LLM_VAL_W)}
                  </text>
                  <text
                    fg={props.theme.accent}
                    {...holdRepeat(`llm-param-${def.key}-increase`, () => props.onAdjustLlmParam(def, def.step))}
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
