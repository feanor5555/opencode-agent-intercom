// The label of one subagent row in the sidebar: the agent's handle, the topic
// it is working on, then the model it runs on.
//
//   researcher#2 · Searching for latest Spring API (Luna)
//
// The topic is the opencode session title. The spawn tool sets it from its
// `description` argument, and where the caller gave none it falls back to
// `${agent}: ${prompt}` — that leading `${agent}: ` is dropped here, because the
// agent already stands at the front of the label. A session with no title at all
// shows the handle alone.
//
// The model is the user's own per-agent choice from llm-models.json. An agent
// without an entry there runs on whatever opencode resolved for it, which the
// panel does not know per subagent session, so the parenthesised part is left
// off entirely rather than naming a model that may be wrong.
//
// The whole label has to fit on one line: the row is two lines high and the
// second one carries the age and the context size, so a label that wraps eats
// that metadata. Every part is therefore sized against the width the panel
// reports for itself, and the composed label never exceeds it.

import {
  isModelRef,
  sameModel,
  type LlmModels,
  type ModelRef,
} from "./llm-models-file.ts";

// Columns of the row that are not the label: the two-space indent of the list
// body, the selection caret, the status dot and its trailing space, and the
// space plus the abort cross at the end.
export const ROW_CHROME_W = 7;

// Panel width assumed while the box has not reported a measured one — the width
// the host sidebar has in its default layout. The label budget is derived from
// it exactly as from a measured width, so this is the single place to change
// what an unmeasured panel is taken to be.
export const FALLBACK_PANEL_W = 42;

// Below this the topic is dropped rather than cut to a stub of two or three
// letters, which carries no information and only crowds the row.
export const MIN_TOPIC_W = 8;

// Upper bound on the topic on a panel wide enough to allow more. The topic is
// the only free-form text in the panel and the one part that has no length of
// its own, so it is capped even where the row would have room.
export const TOPIC_MAX_W = 32;

// Model names are unbounded, so they are cut at the same width the LLM section's
// model row cuts them at.
export const MODEL_MAX_W = 12;

// The separator between handle and topic.
const TOPIC_SEP = " · ";

// One entry of the panel's model pick list: the reference plus its display name.
export interface ModelChoiceLike extends ModelRef {
  label: string;
}

// Cut to `w` columns, the last one carrying the ellipsis. A width of zero or
// less leaves nothing.
export function truncate(s: string, w: number): string {
  if (w <= 0) return "";
  return s.length > w ? s.slice(0, w - 1) + "…" : s;
}

// The columns a row's label may occupy in a panel `panelWidth` columns wide.
// Without a measured width the fallback panel width stands in.
export function subagentLabelWidth(panelWidth?: number): number {
  const panel =
    typeof panelWidth === "number" && panelWidth > 0
      ? panelWidth
      : FALLBACK_PANEL_W;
  return Math.max(0, panel - ROW_CHROME_W);
}

// The display name of a model, without the parenthesised part a pick-list label
// carries: `Luna (gpt-5-luna)` is `Luna`. The label goes into parentheses of the
// row's own, so anything that would nest a second pair is dropped; a label that
// is nothing but a parenthesised part keeps its inner text.
export function modelDisplayName(label: string): string {
  const head = label.split("(")[0]!.replace(/\)/g, "").trim();
  if (head !== "") return head;
  return label.replace(/[()]/g, " ").replace(/\s+/g, " ").trim();
}

// The topic part: the session title without the redundant `${agent}: ` prefix of
// a fallback title, cut to `maxW`. Empty where the title holds nothing else.
export function subagentTopic(
  agent: string,
  title: string,
  maxW: number = TOPIC_MAX_W,
): string {
  let topic = title.trim();
  const prefix = `${agent}:`;
  if (topic.startsWith(prefix)) topic = topic.slice(prefix.length).trim();
  return truncate(topic, maxW);
}

// The model part: the display name of the model configured for that agent, or
// its bare id where the provider list no longer carries it. Empty where the
// agent has no configured model.
export function subagentModel(
  agent: string,
  models: LlmModels,
  choices: readonly ModelChoiceLike[],
  maxW: number = MODEL_MAX_W,
): string {
  const own = models[agent];
  if (!isModelRef(own)) return "";
  const label = choices.find((c) => sameModel(c, own))?.label ?? own.modelID;
  return truncate(modelDisplayName(label), maxW);
}

// Handle, topic and model joined into the row's label, cut to the columns the
// panel leaves the row. A part that resolves to nothing takes its separator with
// it. The handle stays whole as long as the budget allows, the model follows
// where it still fits, and the topic takes what is left over.
export function composeSubagentLabel(
  entry: { handle: string; agent: string; title: string },
  models: LlmModels,
  choices: readonly ModelChoiceLike[],
  panelWidth?: number,
): string {
  const budget = subagentLabelWidth(panelWidth);
  const handle = truncate(entry.handle, budget);

  const model = subagentModel(entry.agent, models, choices);
  const modelPart = model === "" ? "" : ` (${model})`;
  const withModel =
    handle.length + modelPart.length <= budget ? modelPart : "";

  const topicBudget =
    budget - handle.length - withModel.length - TOPIC_SEP.length;
  const topic =
    topicBudget >= MIN_TOPIC_W
      ? subagentTopic(entry.agent, entry.title, Math.min(topicBudget, TOPIC_MAX_W))
      : "";

  return handle + (topic === "" ? "" : TOPIC_SEP + topic) + withModel;
}
