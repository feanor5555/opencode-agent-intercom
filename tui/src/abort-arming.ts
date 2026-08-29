// Two-step confirmation of a subagent abort.
//
// Aborting kills a running session mid-work and cannot be undone, and the panel
// offers it from three places at once: the red cross at the end of a row, the
// `x` and `d` keys of the focused list, and the `agent-intercom.abort-selected`
// command. All three ask the same question first. The first request arms one
// entry, its row then asks for the confirmation, and only a second request for
// that same entry carries the abort out.
//
// The arming holds a single entry and is deliberately short-lived: it falls
// away by itself once ABORT_CONFIRM_MS have passed, on Escape, and as soon as
// the selection moves to another entry — so a keypress can never confirm a
// question the user has already left behind.

// How long an armed entry stays armed. Long enough to move the hand from the
// key to the mouse, short enough that the row does not sit in the confirm state
// while the user has gone on to something else.
export const ABORT_CONFIRM_MS = 4000;

// What the row shows in place of its label while it is armed: it names both
// ways to confirm, the cross of that row and the key that armed it.
export const ABORT_CONFIRM_TEXT = "abort? \u2715 or x again";

// The one entry whose abort is armed, and when it was armed.
export interface ArmedAbort {
  readonly sessionID: string;
  readonly armedAt: number;
}

// What a request against the current arming amounts to: arming this entry, or
// carrying out the abort the user has now confirmed.
export type AbortDecision =
  | { readonly kind: "arm"; readonly armed: ArmedAbort }
  | { readonly kind: "abort"; readonly sessionID: string };

// Whether `sessionID` is the armed entry and its arming is still live. An
// arming stamped in the future counts as live: a clock that jumped must not
// turn a fresh arming into an expired one.
export function isAbortArmed(
  armed: ArmedAbort | undefined,
  sessionID: string,
  nowMs: number,
  timeoutMs: number = ABORT_CONFIRM_MS,
): boolean {
  if (!armed || armed.sessionID !== sessionID) return false;
  return nowMs - armed.armedAt < timeoutMs;
}

// The single decision point every abort entry point goes through: a request for
// the entry that is armed and still live aborts, every other request arms.
export function decideAbort(
  armed: ArmedAbort | undefined,
  sessionID: string,
  nowMs: number,
  timeoutMs: number = ABORT_CONFIRM_MS,
): AbortDecision {
  if (isAbortArmed(armed, sessionID, nowMs, timeoutMs)) {
    return { kind: "abort", sessionID };
  }
  return { kind: "arm", armed: { sessionID, armedAt: nowMs } };
}

// The arming that survives a selection change: only the armed entry's own
// selection keeps it. Moving on to another row, or to no row at all, disarms.
export function armingAfterSelection(
  armed: ArmedAbort | undefined,
  selectedID: string | undefined,
): ArmedAbort | undefined {
  if (!armed) return undefined;
  return armed.sessionID === selectedID ? armed : undefined;
}

// The arming that survives the passage of time.
export function armingAfterTimeout(
  armed: ArmedAbort | undefined,
  nowMs: number,
  timeoutMs: number = ABORT_CONFIRM_MS,
): ArmedAbort | undefined {
  if (!armed) return undefined;
  return nowMs - armed.armedAt < timeoutMs ? armed : undefined;
}
