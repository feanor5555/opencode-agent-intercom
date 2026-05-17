# Concept: TODO/Tasks Tracking System

Status: **Implemented 2026-05-17**, E2E verified against real `opencode serve`. Files:
`src/todofile.js`, the three tools in `src/tools.js`, wake-hook auto-tick in
`src/hooks.js`, per-session directory cache in `src/client.js`. Tests:
`test/todo.test.js` (26 integration tests via mock client + real FS),
`test/e2e/todo-driver.mjs` (E2E against running opencode serve + local LLM,
3/3 scenarios pass: DONE-marker auto-tick, BLOCKED-marker auto-mark, spawn-
without-prefix refusal). Authored 2026-05-17. Replaces the unwritten convention
that Phase-6-Subagents update `AGENTS.md` for task-done; that turned out unreliable
(orchestrator never gets a clear „task X is done" signal, TODO.md stays unchecked).

## Ziel

Deterministischer, agent-übergreifender Mechanismus, um Tasks aus `TODO.md` als erledigt
zu markieren — ohne dass das davon abhängt, dass ein kleines lokales LLM-Modell sich an
ein Update-Ritual erinnert.

## Quintessenz aus der Recherche

- Das Pattern (LLM-Agent + Todo-Tool + Markdown-Checkbox) ist Standard (Claude Code
  TodoWrite/Tasks-API, Spring AI, Codex, Cline) — gut belegte Wins:
  - Verhindert „lost in the middle" / Step-Skipping
  - `in_progress`-Constraint = sequenzieller Fokus
  - Plan ist sichtbar/korrigierbar
- Belegte Failure-Modes (MAST-Taxonomie, ~42 % aller Multi-Agent-Fehler sind
  „specification & design"): brittle Task-Matching, premature termination,
  unspezifisches „done", TOCTOU bei shared state, Tool-Misuse.
- File-on-disk schlägt Chat-Memory für Cross-Session-Tracking (Claude Codes Wechsel
  TodoWrite → Tasks-API ging genau in diese Richtung).

## Design

### Datei-Konvention (fix, projektweit)

- Pfad: `TODO.md` im Projekt-Root
- Format pro Task (planner schreibt es so, sonst kann nichts ticken):

  ```
  - [ ] T5. <kurzer Task-Titel>
      accept: <eine Zeile, was als „done" zählt>
  ```

- IDs sind **projektglobal eindeutig und immutable**:
  - Reguläre Tasks: `T1`, `T2`, `T3`, …
  - Review-Findings: `R1`, `R2`, … (eigener Prefix, eigene Sequenz)
  - Neue Tasks bekommen die nächste freie Nummer. **Niemals renumerieren.**
- Headings (`## Milestone 2`), Prosa, Notizen zwischen den Tasks sind erlaubt — das
  Tool ignoriert alles außer `- [ ]`/`- [x]`/`- [!]`-Zeilen mit Prefix-ID.
- Status-Marker:
  - `- [ ]` open
  - `- [x]` done
  - `- [!]` blocked (Suffix `(blocked: <reason>)` wird vom Plugin hingeschrieben)

### Tools (alle nur auf `TODO.md` im Projekt-Root, kein Pfad-Parameter)

| Tool | Verfügbar bei | Operation |
|---|---|---|
| `list_open()` | orchestrator + alle Subagents | gibt offene/blocked Tasks zurück inkl. `accept:`-Zeile, ~1 KB |
| `mark_done(id)` | orchestrator only | `- [ ] T5` → `- [x] T5`; idempotent; errort wenn ID nicht existiert |
| `mark_blocked(id, reason)` | orchestrator only | `- [ ] T5` → `- [!] T5 (blocked: …)`; idempotent |

Planner editiert `TODO.md` weiterhin per normalem `edit`-Tool (für Struktur, Headings,
neue Tasks, Review-Findings-Sektion). Das Tool oben ist nur fürs Statusflippen — Trennung
„Curator vs Status-Marker".

### Wake-Hook: deterministisches Auto-Ticken

Die fragilste Stelle wäre, dass der Orchestrator sich erinnert `mark_done` aufzurufen.
Stattdessen tickt das Plugin selbst, deterministisch:

1. Orchestrator spawnt mit Prompt-Konvention: **erste Zeile** des Spawn-Prompts ist
   `T5: <task aus TODO.md>` (siehe ORCHESTRATION_GUIDE-Pflicht unten). Plugin
   extrahiert die T-ID beim Spawn und merkt sie sich in der Registry.
2. Subagent endet seinen finalReply mit **erster Zeile** `DONE: T5` oder
   `BLOCKED: T5 — <one-line reason>`.
3. Wake-Hook (`event` auf `session.idle`) parst den finalResult:
   - Marker passt zur Spawn-T-ID → `mark_done` / `mark_blocked` auto-call
   - Marker fehlt → Notice an Orchestrator „T5 finished but no DONE-marker — verify
     and tick manually"
   - Marker passt nicht zur Spawn-T-ID (Halluzination) → Notice „T5 expected but got
     DONE: T3 — ignored, please verify"
   - Session aborted (User-✕) → Marker wird ignoriert (kein Tick auch wenn DONE
     stand)
4. Erst danach wird der Orchestrator geweckt — er sieht im Live-Snapshot bereits den
   frischen Zustand.

Damit ist nur noch **ein** LLM-Schritt fragil (Subagent setzt 8-Zeichen-Marker), nicht
zwei. Mark_done bleibt als Backup-Tool für Korrekturen verfügbar.

### Rollen-Pflichten (Prompts)

- **`ORCHESTRATION_GUIDE`** (`src/prompts.js`):
  - „Every spawn-prompt MUST start with `T<n>: <task>` taken from TODO.md."
  - „After a subagent finishes, the wake-notice tells you whether its task was
    auto-marked. If not, call `mark_done(T<n>)` yourself or re-spawn to fix."
  - „Never call `mark_done` for a task you didn't verify is actually done."

- **`SUBAGENT_GUIDE_CORE`**:
  - „If your spawn-prompt names a task ID (`T<n>:`), end your final reply with
    `DONE: T<n>` on its own line — first line of the reply. Use
    `BLOCKED: T<n> — <one-line reason>` if you can't complete it. Without this
    marker, your work won't be tracked."

- **`PLANNER_PROMPT`** (`src/agents.js`):
  - „Task IDs (`T<n>`, `R<n>`) are immutable across the project lifecycle. New tasks
    get the next free number. Never renumber, never reuse."
  - „Every task line is `- [ ] T<n>. <text>` with an indented `accept: <criterion>`
    line below."
  - „Review-findings go under `## Review-Findings` with `R<n>`-prefix, same format."

- **`CODER_PROMPT` / `GITTER_PROMPT` / `REVIEWER_PROMPT` / `DEBUGGER_PROMPT` /
  `DOCUMENTER_PROMPT`**: Anti-Echo bleibt; zusätzlich der `DONE:`-Bullet aus dem
  SUBAGENT_GUIDE_CORE.

### Failure-Modes & Mitigations (aus der Lückenanalyse)

| Lücke | Mitigation |
|---|---|
| Subagent halluziniert falsche T-ID | Wake-Hook matcht gegen die im Spawn registrierte T-ID, sonst ignoriert + Notice |
| Orchestrator vergisst T-ID im Spawn-Prompt | Plugin validiert beim Spawn: erste Zeile muss `T<n>:` matchen, sonst Reject mit klarer Fehlermeldung |
| Planner renumeriert IDs | Prompt-Pflicht „immutable"; im Zweifel via Review aufgefangen |
| Subagent vom User abgebrochen, hatte schon `DONE:` geschrieben | Wake-Hook prüft Session-Status, ignoriert Marker bei aborted |
| Acceptance-Kriterien dem Orchestrator unsichtbar (kein `read`-Tool) | `list_open` liefert pro Task die `accept:`-Zeile mit zurück |
| `BLOCKED:` undefiniert | Plugin schreibt `- [!] T5 (blocked: …)`, Notice an Orchestrator, kein Auto-Action |
| Reply-Cap (8000 chars) schneidet Marker ab | Marker als **erste** Zeile des finalReply verlangen, nicht letzte |
| `mark_done` auf nicht-existente T-ID | Tool errort hart, Orchestrator merkt's |
| `TODO.md` existiert nicht | `list_open`→leer, `mark_done`→klarer Fehler |
| Doppel-Spawn auf dieselbe offene T | Plugin tracked aktive T-IDs, lehnt Duplikate ab |
| Brittle Substring-Match | `mark_done` matched NUR auf stabile ID-Prefix, nicht auf Text |
| TOCTOU planner↔orchestrator | Orchestrator ist sequenziell single-threaded — kein paralleler Schreiber in seinem Turn |
| Parallel-Coder-Race | Bei parallel: Orchestrator tickt erst NACH allen Finishes; Optimistic-Lock via mtime falls je nötig |
| „Done" bei Halb-fertig (Modell verschätzt sich) | Kein technischer Fix — Reviewer-Zyklus fängt's |
| Stale `list_open` im Orchestrator-Kontext | Begrenzt durch existierende Regel „nur aktuelles Milestone in TODO.md" |

### Was bewusst NICHT im Design ist

- **Kein Auto-Abort** bei BLOCKED — User entscheidet (Pattern: alle Auto-Kill-Pfade
  sind User-only, siehe `feedback-no-auto-kill`).
- **Kein `in_progress`-State** in `TODO.md` — wer gerade arbeitet steht im Subagent-
  Registry-Snapshot (`list()`), nicht in der Datei.
- **Kein paralleler Multi-Writer.** Schreibrechte: planner (Edit für Struktur),
  Plugin/Orchestrator (Status-Flippen). Subagents außer planner haben keinen Schreib-
  Zugriff auf TODO.md.
- **Kein Pfad-Parameter** in den Tools — Datei ist fix `TODO.md` im Projekt-Root.
  Verhindert Injection & accidental edits anderswo.
- **Kein History/Audit-Log** — git ist sekundäre Wahrheit für die, die's brauchen.

## Implementierungs-Plan (wenn approved)

1. `src/todofile.js` — Parser/Writer für `TODO.md` (read, find-by-id, flip-checkbox,
   append-blocked-suffix). ~80 Zeilen.
2. `src/tools.js` — drei neue Tool-Einträge (`list_open`, `mark_done`,
   `mark_blocked`). `list_open` allen Agents erlauben, `mark_done`/`mark_blocked`
   nur Orchestrator (= in `PRIMARY_TOOLS` ergänzen, `guardToolExecute` lässt sie für
   Primary durch).
3. `src/hooks.js` — `event`-Handler erweitern: bei `session.idle` von tracked
   Subagent finalReply parsen (`/^(DONE|BLOCKED): T\d+/m`), gegen registrierte
   T-ID matchen, `todofile.mark*` aufrufen, Notice-Text an Wake-Prompt
   anhängen.
4. `src/registry.js` — Entry um `taskId` ergänzen, beim Spawn setzen.
5. `src/tools.js → spawn` — Prompt-Validierung („erste Zeile matcht
   `^T\d+:\s`"), Reject sonst.
6. `src/prompts.js` — `ORCHESTRATION_GUIDE` + `SUBAGENT_GUIDE_CORE` um die
   neuen Bullets erweitern.
7. `src/agents.js` — `PLANNER_PROMPT` um Immutable-IDs + accept-Zeile,
   alle Coder-artigen Prompts um den `DONE:`-Marker-Bullet.
8. Tests: `test/plugin.test.js` — Format-Parser, Match-Logik, Wake-Hook-Auto-
   Tick mit/ohne Marker, Halluzination-Reject, Aborted-Ignore, Doppel-Spawn-
   Reject, Idempotenz.

Schätzung: 2-3 h Code + Tests. Bump = `minor` (neue Tools, Prompt-Änderungen).

## Entschiedene Punkte (2026-05-17)

- **`list_open` für alle Agents verfügbar** — Coder/Reviewer sehen frischen Stand
  ohne Re-Spawn. Kostet ~150 B Tool-Schema im System-Prompt jedes Subagents.
- **Greenfield-Verhalten: hart errorn** — `list_open` und `mark_done` werfen sofort
  wenn `TODO.md` fehlt. Klares Signal in Phasen 0-4: „run planner first". Verhindert
  silent-empty-list-Bugs.
- **R-Findings symmetrisch zu T-Tasks** — Wake-Hook auto-tickt `DONE: R3` genauso
  wie `DONE: T5`. Eine Regel, weniger Sonderfälle.
