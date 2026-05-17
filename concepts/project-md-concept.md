# Concept: AGENTS.md slim down + `PROJECT.md` als Projekt-Index

Status: **Vorgeschlagen 2026-05-17 — Plugin-Prompts umgestellt 2026-05-17**
(`src/prompts.js` ORCHESTRATION_GUIDE + `src/agents.js` orchestrator/planner/
reviewer/documenter Prompts). Bestehende Projekte (echomodus etc.) brauchen
noch die einmalige planner-Migration (Schritt 1 unten). Begründung: in
einer realen Session (echomodus, 2026-05-17) hat der Orchestrator auf eine
einfache User-Frage "welche TODOs sind offen" mit einem unnötigen Planner-Spawn
reagiert, weil unsere Prompts ihn anweisen, "Status / current phase / current
milestone" aus `AGENTS.md` zu extrahieren — und AGENTS.md ist die falsche
Datei für so etwas (siehe Analyse unten).

## Was wir lernen wollten

AGENTS.md ist eine **cross-tool spec** (siehe https://agents.md): es ist gedacht
als "README für Agents" — ein Ort für *stabile Konventionen, die jeder Agent
beim Coden braucht*. Suggested sections laut Spec:

- Project overview (kurz, was ist das hier)
- Build and test commands
- Code style guidelines
- Testing instructions
- Security considerations
- Development environment tips
- PR instructions

opencode liest die Datei automatisch ein und **injiziert sie in jeden System-
Prompt**. Das macht sie zum auto-load-Layer: alles was in AGENTS.md steht,
landet in jedem LLM-Request, jedes Agents.

## Was wir aktuell daraus machen (Problem)

Unser `ORCHESTRATION_GUIDE` (in `src/prompts.js`) und der `orchestrator`-Prompt
in `src/agents.js` benutzen AGENTS.md als **zentrale State-Datei** des Projekts:

- Workflow mode
- Status / current phase
- Current milestone, current task pointer
- Recent Notes / user tweaks (## Notes)
- Limits (## Limits, ## Notes)
- Plus Pointer zu ARCHITECTURE.md / MILESTONES.md / TODO.md / designs/

Drei Klassen Inhalt sind dabei vermischt:

1. **Stabile Konventionen** (Definition, Git/UI-Flags, Stack) — passt zur Spec, ok.
2. **Live state** (Status, current phase/milestone, recent Notes) — passt NICHT.
   Jede Phase-Änderung muss die auto-injizierte Datei ändern → blowup pro Call.
3. **Pointer-Index** (ARCHITECTURE.md, MILESTONES.md, TODO.md, designs/) — neutral.

Konsequenzen heute:

- AGENTS.md im echomodus-Setup ist ~17 KB; landet jeden Call im System-Prompt.
- Orchestrator bekommt die Anweisung "extrahiere aus AGENTS.md die aktuelle
  Phase" → spawnt Coder/Planner für eine Frage, die eine einfache `read`-Frage
  ist; das ist die direkte Wurzel des "polling list_open"-Antipatterns.
- Wenn `TODO.md` fehlt, denkt der Orchestrator "Tasks könnten ja auch in
  AGENTS.md stehen, weil dort `## Tasks` als Sektion erwähnt wird" (siehe
  `prompts.js` Original-Template). 2026-05-17 in echomodus genau passiert.
- `README.md` (GitHub-Projektseite, human-orientiert) wird im aktuellen Setup
  gar nicht für Agent-Kontext genutzt — sie soll auch human-only bleiben.

## Vorschlag (Split in drei Dateien)

**README.md** — rein human-orientiert (GitHub-Projektseite). Pitch, Install,
Usage, License. Keine agent-spezifischen Inhalte. Optional ein winziger Hinweis
ganz unten: "AI agents: see `AGENTS.md` for conventions and `PROJECT.md` for
project context."

**AGENTS.md** — schlank, auto-injiziert, spec-konform. Enthält **nur**:

- Build / test commands
- Code style / language conventions (z.B. "no comments unless WHY non-obvious")
- Testing rules (z.B. "Integration tests run against a real DB")
- Security considerations relevant für Code-Editing
- PR / commit conventions (z.B. "no Co-Authored-By trailer")
- *Eine* Zeile als Pointer: "Project description, status and document index:
  see `PROJECT.md`."

Keine Live-State-Felder. Keine "current phase". Keine "## Tasks"-Sektion. Keine
Pointer auf ARCHITECTURE/MILESTONES/TODO direkt — die laufen über PROJECT.md.

**PROJECT.md** — agent-orientierter Projekt-Index. Wird NICHT auto-injiziert;
der Orchestrator macht beim Workflow-Einstieg eine fokussierte `read`-Frage
(ähnlich wie heute der "AGENTS.md status-check"-Subagent). Enthält:

- 1–3 Sätze Projektbeschreibung (Goal)
- Workflow mode (structured / freeform)
- Current phase + current milestone (live state)
- Last reviewer run / last gitter commit (live state)
- Pointer-Tabelle:
  - Architecture → `ARCHITECTURE.md`
  - Milestones → `MILESTONES.md`
  - Tasks → `TODO.md`
  - Designs → `designs/`
  - Reviews → `reviews/`
- Recent Notes / user tweaks (live)
- Limits (`maxSubagents`, `maxContext` Overrides falls projektspezifisch)

PROJECT.md darf "fett" werden — sie wird on-demand gelesen, nicht jeden Turn.

## Warum **kein** "PROJECT.md ist Standard"-Risiko

Es gibt keinen Industriestandard "PROJECT.md" — Agenten suchen nur AGENTS.md
(cross-tool), CLAUDE.md (Claude Code) und `.cursorrules` (Cursor) automatisch.
Eine eigene `PROJECT.md` ist also eine Plugin-Konvention; sie funktioniert nur,
weil AGENTS.md (die GELESEN wird) den Pointer auf PROJECT.md trägt. Das ist
auch die einzige load-bearing Verkettung; der README-Hinweis ist Höflichkeit
gegenüber menschlichen Lesern, nicht funktional.

## Migrations-Strategie (für bestehende Projekte mit AGENTS.md-as-state)

1. Spawn-Refactor `planner`: bestehende AGENTS.md analysieren, in drei Buckets
   splitten (Konventionen / Live state / Pointer), Buckets schreiben:
   - Konventionen → bleiben in AGENTS.md
   - Live state + Pointer → wandern nach neuer PROJECT.md
   - README.md unangetastet (oder optional Hinweis-Zeile am Ende anhängen)
2. AGENTS.md bekommt nur noch die Pointer-Zeile auf PROJECT.md plus die
   Konventionen.
3. Orchestrator-Prompt + ORCHESTRATION_GUIDE umstellen:
   - "Status-Check"-Pattern liest jetzt PROJECT.md statt AGENTS.md.
   - AGENTS.md gilt nur noch als Konventions-Quelle (genau wie die Spec sagt).
   - `## Tasks` als Sektionsname aus dem AGENTS.md-Template streichen — bereits
     2026-05-17 ergänzt durch "Tasks (pointer to TODO.md)".
4. PROJECT.md-Updates: jede Phase-Subagent (planner / coder / gitter / reviewer)
   schreibt ihr "current phase / current milestone / recent note"-Update in
   PROJECT.md (genau wie sie es heute mit AGENTS.md tun).

## Warum jetzt zuerst (Reihenfolge in Offene TODOs)

- Reduziert AGENTS.md-Injection im System-Prompt deutlich (heute ~17 KB → Ziel
  <3 KB für AGENTS.md, PROJECT.md wird nur on-demand gelesen).
- Löst die Wurzel des "Orchestrator denkt Tasks könnten in AGENTS.md stehen"-
  Bugs strukturell, nicht nur durch Prompt-Patches.
- Macht Spec-konform und ist eine Voraussetzung dafür, dass künftige `/init`-
  artige Bootstraps das Plugin-Konzept produzieren können statt das aktuelle
  AGENTS.md-überladene Schema.
- Die 2026-05-17 case-insensitive-TODO-Findung + lowercase-todo.md-Fix
  adressiert den unmittelbaren echomodus-Schmerz; AGENTS.md/PROJECT.md adressiert
  die strukturelle Ursache.

## Offene Detailfragen (vor Implementation klären)

- PROJECT.md-Sections final festklopfen (oder bewusst weich lassen wie agents.md
  spec)?
- Soll der Plugin-Init (`bin/install.js`) ein PROJECT.md-Skeleton anlegen wenn
  keine da ist? Vermutlich nein — das ist Aufgabe des phase-0-Planners.
- Wake-Notice-Format: muss der "AGENTS.md updated"-Marker auf "PROJECT.md
  updated" umbenannt werden? (vermutlich ja, der phase-tracking ändert sich mit.)
- Migration eines bestehenden Projekts (echomodus selbst): erst nach Plugin-
  Update, oder per Hand vorher?

## Test-Strategie

- Unit/Integration: PROJECT.md-Parser oder -Helper nötig? Wahrscheinlich nicht
  — die Datei ist purely prose, kein parseable structure (anders als TODO.md).
- E2E: Driver-Szenario "fresh project, orchestrator soll initial setup machen"
  → erwartet AGENTS.md mit nur conventions + Pointer + neue PROJECT.md mit
  description.
- Regression: existierende Tests (84/84) müssen grün bleiben; AGENTS.md-bezogene
  Asserts (`bytes()` im multi-agent-test) brauchen neue erwartete Größen.
