// Type surface for the shared context-figure module, so the TUI bundle
// (`tui/src/tui.tsx`, typed with `strict`) can import the JavaScript
// implementation at `./context-figure.js` without `allowJs`.
//
// The message shape is the one `session.messages()` answers with: the plugin
// reads `info.role`, `info.summary` and `info.tokens` off each entry and
// nothing else, so the parameter is deliberately the loosest type that still
// says which fields are read.

/** The token object an assistant message carries. */
export interface ContextFigureTokens {
  input?: number
  output?: number
  reasoning?: number
  cache?: { read?: number; write?: number }
}

/** The part of a `session.messages()` entry this figure reads. */
export interface ContextFigureMessage {
  info?: {
    role?: string
    summary?: boolean
    tokens?: ContextFigureTokens
  }
}

/**
 * The session's context figure — the sum opencode shows the user, over the
 * newest assistant message with `tokens.output > 0`, stopping at a compaction
 * message. `undefined` where no message qualifies. See the implementation and
 * its comment for the rule and the one place it differs from opencode's own
 * display.
 */
export declare function latestContextTokens(
  messages: ContextFigureMessage[] | undefined,
): number | undefined;
