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
//
// Sizing is done in terminal columns, not in UTF-16 code units: a CJK ideograph
// occupies two columns, a combining mark none, and an astral code point is two
// code units wide but one character. Cutting happens on grapheme clusters, so
// no cut can split a surrogate pair or part a base character from its combining
// marks. The title comes from a session the panel does not control and is
// sanitized before it is composed in: what a fixed-width cell cannot draw as a
// plain glyph is dropped rather than handed to the renderer, which would show
// it as an empty rectangle.

import stringWidth from "string-width";

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

// The marker a cut leaves behind, and the columns it occupies.
const ELLIPSIS = "…";
const ELLIPSIS_W = 1;

// One entry of the panel's model pick list: the reference plus its display name.
export interface ModelChoiceLike extends ModelRef {
  label: string;
}

// ANSI escape sequences: the OSC form terminated by BEL or ST, the CSI form
// (`ESC [ … final byte`), and a bare ESC plus one byte for the short
// two-character sequences.
const ANSI_RE =
  /\u001B\][\s\S]*?(?:\u0007|\u001B\\)|\u001B\[[0-?]*[ -\/]*[@-~]|\u001B[@-Z\\-_]/g;

// Line and tab breaks become a plain space before anything is dropped, so a
// newline separates its neighbours instead of welding them together. They are
// control characters and would otherwise fall to INVISIBLE_RE.
const BREAK_RE = /[\t\n\v\f\r\u0085\u2028\u2029]/g;

// The space separators, the no-break space among them, become a plain space
// too. This runs after the invisible characters are gone, because the
// byte-order mark counts as whitespace to a JavaScript regex while being a
// zero-width character that has to disappear rather than widen the label.
const SPACE_SEPARATOR_RE = /\p{Zs}/gu;

// Control and format characters — the zero-width joiner, the zero-width space
// and the bidi marks are format characters — private-use code points, and
// unpaired surrogates. A valid surrogate pair is one code point of another
// category and stays whole.
const INVISIBLE_RE = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}]/gu;

// Variation selectors VS1-VS16 and the supplementary set VS17-VS256.
const VARIATION_SELECTOR_RE = /[\uFE00-\uFE0F]|[\u{E0100}-\u{E01EF}]/gu;

// Emoji and pictographs: the pictographic block itself, the skin-tone
// modifiers, the regional indicators that pair into flags, and the enclosing
// keycap mark.
const PICTOGRAPHIC_RE =
  /\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|\u{20E3}/gu;

// Runs of spaces left behind by the removals above.
const SPACE_RUN_RE = / {2,}/g;

// Grapheme clusters are the unit every cut is measured in. The segmenter is
// stateless and its construction is the expensive part, so there is one.
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

// The grapheme clusters of a string, in order.
export function graphemes(s: string): string[] {
  const out: string[] = [];
  for (const { segment } of GRAPHEME_SEGMENTER.segment(s)) out.push(segment);
  return out;
}

// The terminal columns a string occupies: a wide character counts two, a
// combining mark none.
export function displayWidth(s: string): number {
  return stringWidth(s);
}

// The free-form title of a foreign session, reduced to what a fixed-width cell
// can draw: escape sequences, control and zero-width characters, private-use
// code points, unpaired surrogates, variation selectors and pictographs go, and
// runs of whitespace collapse to a single space. Letters, digits, punctuation
// and combining marks stay as they are, umlauts and other accented Latin
// included.
export function sanitizeTitle(title: string): string {
  return title
    .replace(ANSI_RE, "")
    .replace(BREAK_RE, " ")
    .replace(INVISIBLE_RE, "")
    .replace(SPACE_SEPARATOR_RE, " ")
    .replace(VARIATION_SELECTOR_RE, "")
    .replace(PICTOGRAPHIC_RE, "")
    .replace(SPACE_RUN_RE, " ")
    .trim();
}

// Cut to `w` columns, the last one carrying the ellipsis. Cuts fall between
// grapheme clusters, so a surrogate pair is never halved and a combining mark
// never parted from its base; a cluster that no longer fits whole is left out
// entirely, which can leave the result a column short of the budget but never a
// column over it. A width of zero or less leaves nothing.
export function truncate(s: string, w: number): string {
  if (w <= 0) return "";
  if (displayWidth(s) <= w) return s;
  const budget = w - ELLIPSIS_W;
  let out = "";
  let used = 0;
  for (const cluster of graphemes(s)) {
    const clusterWidth = displayWidth(cluster);
    if (used + clusterWidth > budget) break;
    out += cluster;
    used += clusterWidth;
  }
  return out + ELLIPSIS;
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

// The topic part: the sanitized session title without the redundant
// `${agent}: ` prefix of a fallback title, cut to `maxW` columns. Empty where
// the title holds nothing else.
export function subagentTopic(
  agent: string,
  title: string,
  maxW: number = TOPIC_MAX_W,
): string {
  let topic = sanitizeTitle(title);
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
// where it still fits, and the topic takes what is left over. The composed
// result is clamped against the budget one last time, so no combination of
// parts can push the label past the columns the row has.
export function composeSubagentLabel(
  entry: { handle: string; agent: string; title: string },
  models: LlmModels,
  choices: readonly ModelChoiceLike[],
  panelWidth?: number,
): string {
  const budget = subagentLabelWidth(panelWidth);
  const handle = truncate(entry.handle, budget);
  const handleWidth = displayWidth(handle);

  const model = subagentModel(entry.agent, models, choices);
  const modelPart = model === "" ? "" : ` (${model})`;
  const withModel =
    handleWidth + displayWidth(modelPart) <= budget ? modelPart : "";

  const topicBudget =
    budget - handleWidth - displayWidth(withModel) - displayWidth(TOPIC_SEP);
  const topic =
    topicBudget >= MIN_TOPIC_W
      ? subagentTopic(
          entry.agent,
          entry.title,
          Math.min(topicBudget, TOPIC_MAX_W),
        )
      : "";

  const composed = handle + (topic === "" ? "" : TOPIC_SEP + topic) + withModel;
  return truncate(composed, budget);
}
