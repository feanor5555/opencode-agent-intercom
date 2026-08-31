// Press-and-hold auto-repeat for the sidebar's [<]/[>] and [-]/[+] buttons.
// After firing once on mousedown the run waits HOLD_REPEAT_DELAY_MS (so a tap
// is a single step), then repeats every HOLD_REPEAT_INTERVAL_MS. Mouseup and
// mouseout from the owning button end it, so moving the cursor off that button
// reliably stops the run — terminals can drop button-release events under load.
//
// The two timers belong to the module, not to the handler object that started
// them: a terminal reports one held button at a time, so there is exactly one
// run in flight. The run also remembers its button key, so a mouseout from a
// different button cannot cancel it while a reactive row is being rebuilt.
// Module ownership makes the run cancellable across a remount. A row whose
// handlers sit in a reactive JSX spread is rebuilt by the very signal its
// action writes, so the mouseup that ends the press reaches a *different*
// handler object than the mousedown that began it; with per-closure timers that
// mouseup cancelled nothing and the repeat ran on untouched, stepping the value
// every interval forever.

export const HOLD_REPEAT_DELAY_MS = 350;
export const HOLD_REPEAT_INTERVAL_MS = 60;

export interface HoldRepeatHandlers {
  onMouseDown: () => void;
  onMouseUp: () => void;
  onMouseOut: () => void;
}

// The one press in flight. `hold` is the delay before the repeat starts,
// `repeat` the repeat itself; both are cleared together.
interface HoldRun {
  owner: string;
  hold?: ReturnType<typeof setTimeout>;
  repeat?: ReturnType<typeof setInterval>;
}

let activeRun: HoldRun | undefined;

// Ends the press in flight when it belongs to `owner`. An omitted owner is the
// lifecycle-wide stop used when the panel is disposed.
export function stopHoldRepeat(owner?: string): void {
  const run = activeRun;
  if (run === undefined || (owner !== undefined && run.owner !== owner)) return;
  activeRun = undefined;
  if (run.hold !== undefined) clearTimeout(run.hold);
  if (run.repeat !== undefined) clearInterval(run.repeat);
  run.hold = undefined;
  run.repeat = undefined;
}

// Whether a press is still in flight — i.e. whether a timer is armed. False
// after every release; the panel does not read it, the tests do.
export function isHoldRepeatActive(): boolean {
  return activeRun !== undefined;
}

// Mouse handlers that fire `action` once on press and then auto-repeat for as
// long as the button is held. The timers are armed before `action` runs, so an
// action that rebuilds the element it is mounted on cannot leave the run
// unreachable; a run the action itself ends stays ended, because the delayed
// start checks that it is still the active one. Release events only stop their
// own key's run; mousedown still unconditionally takes over the one global run.
export function holdRepeat(key: string, action: () => void): HoldRepeatHandlers {
  return {
    onMouseDown: () => {
      stopHoldRepeat();
      const run: HoldRun = { owner: key };
      run.hold = setTimeout(() => {
        run.hold = undefined;
        if (activeRun !== run) return;
        run.repeat = setInterval(action, HOLD_REPEAT_INTERVAL_MS);
      }, HOLD_REPEAT_DELAY_MS);
      activeRun = run;
      action();
    },
    onMouseUp: () => stopHoldRepeat(key),
    onMouseOut: () => stopHoldRepeat(key),
  };
}
