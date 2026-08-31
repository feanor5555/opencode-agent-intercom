// Press-and-hold auto-repeat for the sidebar's [<]/[>] and [-]/[+] buttons.
// After firing once on mousedown the run waits HOLD_REPEAT_DELAY_MS (so a tap
// is a single step), then repeats every HOLD_REPEAT_INTERVAL_MS. Mouseup and
// mouseout both end it, so moving the cursor off the button reliably stops the
// run — terminals can drop button-release events under load.
//
// The two timers belong to the module, not to the handler object that started
// them: a terminal reports one held button at a time, so there is exactly one
// run in flight, and any handler's stop ends it. That ownership is what makes
// the run cancellable across a remount. A row whose handlers sit in a reactive
// JSX spread is rebuilt by the very signal its action writes, so the mouseup
// that ends the press reaches a *different* handler object than the mousedown
// that began it; with per-closure timers that mouseup cancelled nothing and the
// repeat ran on untouched, stepping the value every interval forever.

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
  hold?: ReturnType<typeof setTimeout>;
  repeat?: ReturnType<typeof setInterval>;
}

let activeRun: HoldRun | undefined;

// Ends the press in flight, whichever handler object started it.
export function stopHoldRepeat(): void {
  const run = activeRun;
  activeRun = undefined;
  if (run === undefined) return;
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
// start checks that it is still the active one.
export function holdRepeat(action: () => void): HoldRepeatHandlers {
  return {
    onMouseDown: () => {
      stopHoldRepeat();
      const run: HoldRun = {};
      run.hold = setTimeout(() => {
        run.hold = undefined;
        if (activeRun !== run) return;
        run.repeat = setInterval(action, HOLD_REPEAT_INTERVAL_MS);
      }, HOLD_REPEAT_DELAY_MS);
      activeRun = run;
      action();
    },
    onMouseUp: stopHoldRepeat,
    onMouseOut: stopHoldRepeat,
  };
}
