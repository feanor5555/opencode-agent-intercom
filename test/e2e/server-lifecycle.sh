#!/bin/bash
# Shared `opencode serve` lifecycle for the end-to-end drivers.
#
# Sourced, never executed:
#
#   HERE=$(cd "$(dirname "$0")" && pwd)
#   . "$HERE/server-lifecycle.sh"
#
# It owns four steps — build the TUI half, start a server, wait for it, stop it
# again — and nothing else: ports, project directories, settings files, sessions
# and captures stay with the caller that knows them.
#
# Everything that differs per caller is an argument. The state the functions
# hand back lives in these globals:
#
#   E2E_SERVER_PID    pid of the opencode process itself (not a wrapper)
#   E2E_SERVER_PGID   its process group, used for the group kill
#   E2E_SERVER_BASE   http://127.0.0.1:<port>
#   E2E_SERVER_LOG    the log file the server's stdout/stderr goes to
#   E2E_TUI_BUILT     1 once the TUI has been built in this process tree;
#                     exported, so a driver started by another driver that
#                     already built does not build a second time
#
# Functions that set these globals must be called directly in the current shell, never in a
# pipeline, command substitution, or other subshell: otherwise the state is lost and
# the server is left orphaned. Redirect output to a file instead of piping through `tee`.
# `e2e_server_start` enforces this itself — see e2e_require_caller_shell — and
# refuses to start anything when it finds it is running in a subshell.
#
# Failures are reported on stderr and returned as a non-zero status; the
# functions never exit the caller's shell, so a driver can add its own message
# and its own exit code.
#
# Requires: curl, setsid, ps, npm, an `opencode` on PATH.

E2E_SERVER_PID=""
E2E_SERVER_PGID=""
E2E_SERVER_BASE=""
E2E_SERVER_LOG=""
E2E_TUI_BUILT=${E2E_TUI_BUILT:-0}

e2e_say() { printf '%s\n' "$*"; }
e2e_fail() { printf '%s\n' "$*" >&2; }

# The URL a server on <port> answers on. One place, so caller and library never
# disagree about the host part.
e2e_server_url() { printf 'http://127.0.0.1:%s' "$1"; }

# ---------- caller-shell guard ---------------------------------------------

# Usage: e2e_require_caller_shell <function_name>
#
# Returns 0 when the caller runs in the shell that sourced this library, and 1
# with a diagnostic when it runs in a subshell — a pipeline stage, a command
# substitution, a background job, an explicit ( … ).
#
# `$$` keeps the pid of the shell the script started as; `$BASHPID` is the pid
# of the shell executing right now. bash forks for every subshell, so the two
# are equal in the caller's own shell and differ in every subshell. A subshell's
# variables and traps die with it, so a server started there is invisible to the
# caller's E2E_SERVER_PID and to its EXIT trap, and nothing stops it afterwards.
#
# The check needs bash: a shell that sets no BASHPID cannot be told apart this
# way and is let through.
e2e_require_caller_shell() {
  local fn="$1"
  if [ -z "${BASHPID:-}" ] || [ "$BASHPID" = "$$" ]; then
    return 0
  fi
  e2e_fail "$fn: refusing to start a server — this call runs in a subshell (pid $BASHPID), not in the caller's shell (pid $$)."
  e2e_fail "  A subshell cannot hand E2E_SERVER_PID, E2E_SERVER_PGID or an EXIT trap back to the caller, so the opencode it starts could not be stopped again and would be left running."
  e2e_fail '  Call it directly in your own shell — not through a pipe (`... | tee log`), not in a command substitution (`$(...)`), not as a background job (`... &`), not inside `( ... )`.'
  e2e_fail '  To keep a transcript, redirect the call itself: e2e_server_start <port> <project_dir> <log_file> <pid_file> >> run.log 2>&1'
  e2e_fail '  Or pipe the whole driver instead of the single call, which keeps its state in its own shell: bash test/e2e/run-all.sh 2>&1 | tee run.log'
  return 1
}

# ---------- plugin wiring --------------------------------------------------

# Usage: e2e_plugin_wired <plugin_root> <project_dir>
#
# True when <project_dir> wires <plugin_root> into the server half, in one of
# the two project-scoped forms opencode accepts: a `plugin` entry naming the
# path in the project's opencode.json, or a drop-in under .opencode/plugin/ or
# .opencode/plugins/. A server started in a project that wires neither drops the
# plugin without a diagnostic, so every driver would then fail on a missing
# `spawn` tool with nothing saying why.
e2e_plugin_wired() {
  local plugin_root="$1" project_dir="$2" f
  if [ -f "$project_dir/opencode.json" ] && grep -qF "$plugin_root" "$project_dir/opencode.json"; then
    return 0
  fi
  for f in "$project_dir"/.opencode/plugin/*.ts "$project_dir"/.opencode/plugin/*.js \
           "$project_dir"/.opencode/plugins/*.ts "$project_dir"/.opencode/plugins/*.js; do
    [ -e "$f" ] && return 0
  done
  return 1
}

# ---------- build ----------------------------------------------------------

# Builds the TUI half of the plugin: the sidebar is served from
# `tui/dist/tui.js`, so a server restart alone would keep running the previous
# bundle. The server half is plain JavaScript loaded by absolute path and needs
# only the restart.
#
# Usage: e2e_build_tui <plugin_root>
# Runs at most once per process tree — a driver that starts several servers
# builds once.
e2e_build_tui() {
  local plugin_root="$1"
  if [ "$E2E_TUI_BUILT" = 1 ]; then
    e2e_say "TUI build: already built in this run — skipped"
    return 0
  fi
  if [ ! -d "$plugin_root/tui" ]; then
    e2e_fail "TUI build: no such directory: $plugin_root/tui"
    return 1
  fi
  e2e_say "TUI build: npm run build in $plugin_root/tui"
  if ! ( cd "$plugin_root/tui" && npm run build ); then
    e2e_fail "TUI build FAILED in $plugin_root/tui — the sidebar would run the previous tui/dist/tui.js; not starting a server"
    return 1
  fi
  if [ ! -s "$plugin_root/tui/dist/tui.js" ]; then
    e2e_fail "TUI build produced no $plugin_root/tui/dist/tui.js"
    return 1
  fi
  E2E_TUI_BUILT=1
  export E2E_TUI_BUILT
  e2e_say "TUI build: ok ($plugin_root/tui/dist/tui.js)"
  return 0
}

# ---------- start ----------------------------------------------------------

# Usage: e2e_server_start <port> <project_dir> <log_file> <pid_file>
#
# `setsid bash -c 'cd …; echo $$ > pidfile; exec opencode …'` writes the PID of
# the shell that then EXECs opencode: the recorded pid is the server process
# itself, not a wrapper that exits while its child keeps running. setsid also
# makes that process its own session and group leader, which is what lets
# e2e_server_stop kill the whole group. The cd happens inside that shell, so the
# caller's own working directory is left alone.
#
# Refuses outright when it is not running in the caller's shell: the state it
# hands back and the trap that would stop the server both stay in the shell that
# calls it, so a subshell would leak the server it starts.
e2e_server_start() {
  local port="$1" project_dir="$2" log_file="$3" pid_file="$4"

  e2e_require_caller_shell e2e_server_start || return 1

  if [ ! -d "$project_dir" ]; then
    e2e_fail "server start: no such project directory: $project_dir"
    return 1
  fi

  E2E_SERVER_PID=""
  E2E_SERVER_PGID=""
  E2E_SERVER_BASE=$(e2e_server_url "$port")
  E2E_SERVER_LOG="$log_file"

  : > "$log_file"
  rm -f "$pid_file"

  setsid bash -c "cd '$project_dir' || exit 1; echo \$\$ > '$pid_file'; exec opencode serve --port $port --hostname 127.0.0.1" \
    >> "$log_file" 2>&1 < /dev/null &

  for _ in $(seq 1 50); do
    [ -s "$pid_file" ] && break
    sleep 0.2
  done
  if [ ! -s "$pid_file" ]; then
    e2e_fail "server start: the wrapper never wrote its pid to $pid_file — see $log_file"
    return 1
  fi
  E2E_SERVER_PID=$(cat "$pid_file")
  E2E_SERVER_PGID=$(ps -o pgid= -p "$E2E_SERVER_PID" 2>/dev/null | tr -d ' ')
  if [ -z "$E2E_SERVER_PGID" ]; then
    e2e_fail "server start: could not read the process group of pid $E2E_SERVER_PID"
    return 1
  fi
  e2e_say "server starting: pid $E2E_SERVER_PID / pgid $E2E_SERVER_PGID on $E2E_SERVER_BASE (cwd $project_dir, log $log_file)"
  return 0
}

# True while the recorded server process is still there.
e2e_server_alive() {
  [ -n "$E2E_SERVER_PID" ] && kill -0 "$E2E_SERVER_PID" 2>/dev/null
}

# ---------- readiness ------------------------------------------------------

# Usage: e2e_server_wait_ready <timeout_s> [health_file]
#
# Polls `/global/health` until it answers 200, watching the recorded pid while
# it waits: a server that exits during startup fails at once with the tail of
# its log instead of being waited out. Afterwards it confirms the pid really is
# an opencode, so the probe is not watching a wrapper. The health response is
# kept in <health_file> when one is given.
e2e_server_wait_ready() {
  local timeout="$1" health_file="${2:-/dev/null}"
  local deadline ready cmdline

  if [ -z "$E2E_SERVER_PID" ]; then
    e2e_fail "server readiness: no server was started"
    return 1
  fi

  ready=0
  deadline=$(( $(date +%s) + timeout ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if ! kill -0 "$E2E_SERVER_PID" 2>/dev/null; then
      e2e_fail "--- last 30 lines of $E2E_SERVER_LOG ---"
      tail -n 30 "$E2E_SERVER_LOG" >&2
      e2e_fail "opencode (pid $E2E_SERVER_PID) exited during startup"
      return 1
    fi
    if curl -fsS -m 3 "$E2E_SERVER_BASE/global/health" > "$health_file" 2>/dev/null; then
      ready=1
      break
    fi
    sleep 1
  done
  if [ "$ready" != 1 ]; then
    e2e_fail "no HTTP 200 from $E2E_SERVER_BASE/global/health within ${timeout}s (pid $E2E_SERVER_PID is still alive — see $E2E_SERVER_LOG)"
    return 1
  fi

  # The pid we hold must really be the server: a wrapper that handed off to a
  # child would leave us watching the wrong process.
  cmdline=$(tr '\0' ' ' < "/proc/$E2E_SERVER_PID/cmdline" 2>/dev/null)
  case "$cmdline" in
    *opencode*) : ;;
    *)
      e2e_fail "pid $E2E_SERVER_PID is not an opencode process (cmdline: $cmdline) — the readiness probe would be watching a wrapper"
      return 1
      ;;
  esac
  e2e_say "server ready on $E2E_SERVER_BASE"
  return 0
}

# ---------- stop -----------------------------------------------------------

# Usage: e2e_server_stop
#
# Kills the server as a process group, because setsid made the opencode process
# its own session and group leader: SIGTERM, 10 s of grace, then SIGKILL, then a
# health probe that says so if something still answers on the port. The group
# kill is skipped if that group is the caller's own — killing it would take the
# driver with it. A no-op when no server is recorded, and idempotent.
e2e_server_stop() {
  local own_pgid target waited
  [ -n "$E2E_SERVER_PID" ] || return 0

  own_pgid=$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ')
  target="$E2E_SERVER_PID"
  if [ -n "$E2E_SERVER_PGID" ] && [ "$E2E_SERVER_PGID" != "$own_pgid" ]; then
    target="-$E2E_SERVER_PGID"
  fi

  kill -TERM -- "$target" 2>/dev/null || :
  waited=0
  while kill -0 "$E2E_SERVER_PID" 2>/dev/null && [ "$waited" -lt 10 ]; do
    sleep 1
    waited=$((waited + 1))
  done
  if kill -0 "$E2E_SERVER_PID" 2>/dev/null; then
    kill -KILL -- "$target" 2>/dev/null || :
    sleep 1
  fi
  if kill -0 "$E2E_SERVER_PID" 2>/dev/null; then
    e2e_say "WARNING: pid $E2E_SERVER_PID survived SIGKILL — kill it by hand"
  else
    e2e_say "server stopped (signalled $target)"
  fi
  if curl -fsS -m 3 "$E2E_SERVER_BASE/global/health" >/dev/null 2>&1; then
    e2e_say "WARNING: something still answers on $E2E_SERVER_BASE"
  fi

  E2E_SERVER_PID=""
  E2E_SERVER_PGID=""
  return 0
}
