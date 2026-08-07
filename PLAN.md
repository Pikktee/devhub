# devhub — Umsetzungsplan

Ein kleiner lokaler Dienst, dem die Dev-Server aller Projekte gehören.

## Warum

Zwei Beschwerden waren der Anlass, und die Messung hat gezeigt, dass sie
verschiedene Ursachen haben:

1. **Server verschwinden.** Sie hängen am Prozess der Claude-App (gemessen: alle
   vier laufenden Dev-Server hatten `Claude.app` als Vorfahren, nicht die
   Session). Sessions töten sie also nicht — ein Neustart oder Beenden der App
   tötet sie alle auf einmal.
2. **Server laufen doppelt.** Wo kein `strictPort` greift, weicht der Server auf
   die nächste freie Nummer aus. **Next.js kann das gar nicht abschalten** — es
   weicht immer aus und schreibt eine Zeile ins Log, die niemand liest. Das
   betrifft sechs Projekte.

Dazu eine Kollision, die heute schon besteht und niemandem auffällt:
`tile-weave` startet seinen Server mit `PORT=8787`, Journeys API läuft auf
derselben Nummer. Wer beide gleichzeitig offen hat, bekommt stillschweigend
Unsinn. Insgesamt teilen sich sieben von elf Projekten ihre Ports paarweise
(viermal 3000, dreimal 5173).

## Endzustand

Jedes Projekt hat einen festen Port und eine feste Adresse. Die Dev-Server
gehören einem kleinen Dienst unter launchd — nicht einer IDE, nicht einer
Agent-Session, nicht einer Shell. Coding-Agenten (Claude Code, Cursor, Codex,
u. a.) starten nie wieder selbst etwas, sondern hängen sich an bzw. rufen nur
`devhub up`/`devhub status` auf. Ein Übersichtsfenster auf `http://devhub.localhost:4000`
zeigt Server **und** projektbezogene Agent-Kontexte und schaltet die Server.

Der Hub ist agent-neutral. Agent-spezifische Dateien (z. B.
`.claude/launch.json`) sind **Adapter**, keine Kernabhängigkeit.

## Stand (2026-08-07)

Umgesetzt: Etappen 1, 2, 3, 5, 6 und 7. Bedienung in [README.md](README.md).

Was noch aussteht, ist bewusst nichts Gebautes:

- **Etappe 4 (Feldtest)** — läuft erst, wenn Projekte aufgenommen sind.
- **Aufnahme der Projekte.** Die Registry ist leer; `devhub adopt` und `devhub sync`
  ändern erst etwas, wenn sie aufgerufen werden. Kein Projekt wurde angefasst.
- **Leerlauf-Abschaltung** (optional, Etappe 6) — erst nach dem Feldtest.

---

## 1. Datenmodell

### Zentrale Registry

`~/.config/devhub/registry.json` — die einzige Stelle, die alle Projekte
gleichzeitig sieht und darum als Einzige Kollisionen ausschließen kann.

```json
{ "journey": { "slot": 90 }, "hugur": { "slot": 12 } }
```

### Portschema aus dem Slot

Der Slot ist zweistellig, wird einmal vergeben und nie wiederverwendet.

| Rolle           | Formel | Journey (Slot 90)                             |
| --------------- | ------ | --------------------------------------------- |
| Frontend        | `51NN` | 5190                                          |
| Backend         | `87NN` | 8790 — identisch zum Produktions-Hostport      |
| zweites Profil  | eigener Slot | smoke = 91 → 5191 / **8791** (unverändert) |

Journey behält damit `8791` und bekommt für die API die Nummer, die auch auf dem
Server steht. Das ist kein Zufallsgewinn, sondern der Grund, den Slot so zu
wählen.

### Projektdatei `dev.json`

Sprachneutral, mit `{port}`-Platzhalter — der Hub weiß nicht, wie man einen Port
übergibt, er setzt nur ein.

```json
{
  "profile": {
    "default": [
      { "name": "web", "runner": "process", "rolle": "frontend",
        "cmd": ["npm", "run", "dev", "--", "--port", "{port}", "--strictPort"] },
      { "name": "api", "runner": "process", "rolle": "backend",
        "cwd": "server", "env": { "PORT": "{port}" }, "cmd": ["npm", "run", "dev"] }
    ],
    "smoke": []
  }
}
```

`runner` ist `process` | `compose` | `static`.

Node-Projekte **ohne** `dev.json` funktionieren trotzdem: Der Hub leitet
`npm run dev` aus der `package.json` ab und schiebt den Port über `PORT` und
`--port` nach. Nicht-Node-Projekte brauchen die Datei — die Python-Projekte
haben den Inhalt bereits in ihrer `launch.json` stehen, das ist eine
Umformatierung, keine Neuarbeit.

### Generiert: Agent-Adapter (nicht Kern)

Nur wo ein Agent ein eigenes Attach-/Preview-Format braucht. Erster Adapter:
Claude Code → `.claude/launch.json`, ausschließlich Attach-Einträge, kein
Kommando, **nie** `autoPort`:

```json
{ "name": "journey-web", "url": "http://journey.localhost:5190", "port": 5190 }
```

Cursor und die meisten anderen Agenten brauchen **kein** Äquivalent: sie haben
kein `preview_start`. Für sie reicht der Vertrag „Server nur über `dev`“ in
`AGENTS.md` / Cursor-Rules. Weitere Adapter nur bei nachgewiesenem Bedarf.

---

## 2. Etappen

### Etappe 1 — Zwei Entscheidungen vorab ✅ beantwortet (2026-08-07)

- **Vite und Fremdhostnamen: keine Änderung nötig.** Gemessen an Vite 6.4.3 in
  `journey`, Funktion `isHostAllowedWithoutCache`:

  ```js
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true
  ```

  `*.localhost` ist vor jeder `allowedHosts`-Prüfung erlaubt. Die vier
  Vite-Projekte brauchen keinen Eintrag.

- **Interpreterstrategie für Python: absoluter Pfad.** In `dev.json` steht
  `.venv/bin/uvicorn` als `cmd[0]`. Enthält das Kommando einen Schrägstrich,
  löst es der Kernel gegen das gesetzte Arbeitsverzeichnis auf — kein `PATH`,
  keine Login-Shell, kein geerbtes `VIRTUAL_ENV`. Reproduzierbar und sichtbar.

### Etappe 2 — Der Kern als CLI (der eigentliche Aufwand)

Node ohne Abhängigkeiten. Projektdoku agent-neutral (`AGENTS.md`); optional
zusätzlich `CLAUDE.md`, falls Claude Code das Repo selbst bearbeitet.

`devhub up [projekt] [--profil smoke]` · `devhub down` · `devhub status` · `devhub logs` · `devhub ports`

Was drinstecken muss:

- **Abgekoppelt starten**: `spawn(detached: true)`, eigene Prozessgruppe,
  `unref`, Ausgabe nach `~/.local/state/devhub/<projekt>-<prozess>.log`.
- **Stoppen über die Gruppe** (`kill(-pid)`), nicht über den Prozess. Bei
  `npm run dev` → `node vite` überlebt sonst das Kind und hält den Port besetzt —
  und damit ist die Idempotenz hin.
- **Status aus der Port-Probe**, nicht aus der PID-Datei. Eine PID-Datei zu einem
  toten Prozess ist die häufigste Lüge in solchen Werkzeugen.
- **Strenge selbst durchsetzen**: vor dem Start prüfen, ob der Port frei ist;
  nach dem Start verifizieren, dass der Prozess wirklich auf der zugewiesenen
  Nummer lauscht. Next.js weicht sonst still aus.
- **Idempotenz**: `up` auf etwas Laufendem ist ein No-op mit Hinweis.
- **Runner `process`** reicht hier. `compose` und `static` kommen in Etappe 6.

*Fertig, wenn Journey mit beiden Profilen (vier Prozesse) startet und stoppt,
`devhub up` zweimal hintereinander nichts kaputt macht und die Server einen
Neustart der Claude-App **oder** von Cursor überleben.*

### Etappe 3 — Dauerbetrieb und Agent-Adapter (klein)

- **launchd-Agent** für `devhub` selbst (`RunAtLoad`, `KeepAlive`), Port 4000.
  Der Hub ist das Einzige, dessen Dauerbetrieb sich rechtfertigt: winzig, kein
  Projektcode.
- **Gemeinsamer Vertrag** (agent-neutral): „Dev-Server nie selbst starten —
  `devhub up` / `devhub status` / Hub-UI.“ Liegt in einer kurzen Vorlage, die
  `devhub sync` in projektlokale `AGENTS.md`-Abschnitte und/oder Cursor-Rules
  einspielen kann (idempotent, markiert mit HTML-Kommentar-Anker).
- **Adapter Claude Code** (optional, aber zuerst, weil gemessen):
  - `devhub sync` schreibt `.claude/launch.json` (reine Attach-Einträge).
  - Globale Regel in `~/.claude/CLAUDE.md`.
  - Falls Regeln nicht reichen: PreToolUse-Hook auf Bash gegen `npm run dev` & Co.
- **Adapter Cursor / Codex / andere**: kein Generated-File nötig. Nur der
  Vertrag oben. Hooks nur, wenn Cursor/Codex ein zuverlässiges Äquivalent
  anbieten und Regeln allein nicht greifen — nicht spekulativ bauen.

*Fertig, wenn nach Abmelden/Anmelden alles von selbst wieder da ist,
Claude-`preview_start` anhängt statt zu starten, und ein Cursor-/Codex-Chat
denselben laufenden Server nutzt statt einen zweiten zu spawnen.*

### Etappe 4 — Feldtest (ein paar Tage benutzen)

Journey und tile-weave als die beiden schwierigen Fälle (Doppelprozess, Profile,
viele Umgebungsvariablen). Nichts weiter bauen. Was hier auffällt, ist billiger
zu korrigieren als nach der Oberfläche.

### Etappe 5 — Die Übersichtsseite

`http://devhub.localhost:4000`, serviert vom selben Dienst. Mockups liegen unter
[mockups/](mockups/). Sie ist nur noch eine Ansicht auf Kommandos, die es schon
gibt — deshalb steht sie hier und nicht vorn.

Beim Entwickeln daran: Die produktive Instanz läuft unter launchd auf 4000, die
Entwicklungsinstanz auf 4001 mit **eigenem Zustandsverzeichnis**. Sonst bringt
man beim Testen die PID-Dateien der echten Server durcheinander. Dasselbe Muster
wie Journeys Smoke-Profil.

### Etappe 6 — Der Rest

Restliche Projekte einsammeln, dazu die zwei fehlenden Runner:

- **`compose`** (custom-gpt, schnappster, journey): `up -d`/`down`, Status aus
  `docker compose ps`, Port über `${PORT}` in der Compose-Datei. Grundlegend
  anders als ein Vordergrundprozess — es gibt keine PID, die man behalten könnte.
- **`static`** (konzepte, vonnis-testcoding 1+2 u. a.): ausgeliefert von
  `bin/static-serve.js` statt von je einem `python3 -m http.server`.
  *Abweichung vom Plan:* der Hub liefert nicht in-process aus. Das hätte
  bedeutet, dass `devhub up` für statische Projekte einen laufenden Hub voraussetzt
  und Listener zur Laufzeit auf- und abgebaut werden — viel Sonderfall für einen
  gesparten Prozess. So bleibt die Zustandsführung für alle Runner dieselbe.

Optional: Leerlauf-Abschaltung („sechs Stunden kein Zugriff → runter"). Bei
dreißig möglichen Projekten der Unterschied zwischen 300 MB und 3 GB.

### Etappe 7 — Agent-Kontext pro Projekt (Lesemodus)

Dieselbe Übersicht, zweiter Job: projektbezogene Coding-Agent-Dateien schnell
sichtbar machen — nicht editieren wie eine IDE, sondern begutachten.

**Warum sinnvoll:** Der Hub kennt schon jedes Projekt und seinen Pfad. Agenten
streuen Konfiguration über viele Dateinamen; ein Blick „was gilt hier?“ spart
Kontextwechsel. Das ist komplementär zu Ports/Prozessen, kein Ersatz.

**Was der Hub zeigt (read-only, lokal):**

| Familie | Typische Pfade |
| --- | --- |
| Neutral | `AGENTS.md`, `AGENT.md`, `.agents/` |
| Claude | `CLAUDE.md`, `.claude/CLAUDE.md`, `.claude/agents/`, `.claude/skills/`, Memory unter `~/.claude/projects/…` nur wenn dem Projekt zuordenbar |
| Cursor | `.cursor/rules/`, `.cursor/skills/`, `AGENTS.md` |
| Codex | `.codex/`, ggf. `AGENTS.md` |

UI: im Projekt-Detail ein Reiter **Agenten** — erkannte Dateien als Liste mit
Kurzinfo (Pfad, Größe, mtime), Vorschau des Inhalts, Badge welcher Agent die
Datei vermutlich liest. Optional CLI: `devhub agents [projekt]`.

**Eine Ausnahme vom Lesemodus: `devhub link`.** Wenn `AGENTS.md` und `CLAUDE.md`
nebeneinander als Kopien liegen, laufen sie auseinander — dann gilt für Claude
etwas anderes als für Cursor. Der Hub darf sie verknüpfen, aber nur, wo das
nachweislich verlustfrei ist (nur eine Datei vorhanden, oder beide inhaltlich
identisch). Bei zwei verschiedenen Dateien bricht er ab und sagt warum.

Gemessen am 2026-08-07 über 35 Projekte: 7 bereits verknüpft — davon 2 in die
eine, 5 in die andere Richtung —, 4 mit nur einer Datei, 2 mit zwei
verschiedenen. Bei einem davon (`ki-duell`) sind beide Dateien exakt gleich
groß und trotzdem verschieden; ein Größenvergleich hätte Inhalt vernichtet.

**Grenzen (absichtlich):**

- Kein vollwertiger Editor; „Im Editor öffnen“ reicht.
- Kein Schreiben in Memory oder Sitzungsspeicher (Konflikt mit laufenden Agenten).
- Memory/Skills können Secrets enthalten → nur localhost, keine Telemetrie,
  Memory-Pfade nur mit explizitem Opt-in anzeigen.
- Kein Versuch, alle Agent-Formate zu „vereinheitlichen“ — nur entdecken und
  anzeigen.

*Fertig, wenn Journey und ein zweites Projekt ihre `AGENTS.md`/`CLAUDE.md`/
Rules im Hub lesbar zeigen und fehlende Dateien als Lücken markiert sind.*

---

## 3. Adressen

`http://journey.localhost:5190` — der Hostname kostet nichts.

**Gemessen**: macOS löst beliebige `*.localhost`-Namen systemweit auf 127.0.0.1
auf, ohne `/etc/hosts` und ohne `sudo` — in `curl`, in Node-`fetch` und in der
Browser-Pane. Kein Caddy, kein root-Daemon, kein Port 80 nötig.

Der Port bleibt in der Adresse. Damit stimmt Vites Selbstbild und HMR
funktioniert unverändert — ein Reverse-Proxy auf Port 80 würde genau das
zerstören und `server.hmr.clientPort` erzwingen.

Der Gewinn ist nicht Kosmetik: **Cookies sind portunabhängig.** Heute
überschreiben sich Journeys Dev-Instanz (5199) und die Smoke-Instanz (5218)
gegenseitig die Anmeldung, weil beide unter `localhost` denselben Jar teilen.
Mit `journey.localhost` und `journey-smoke.localhost` ist das getrennt.
(`localStorage` war nie betroffen — das hängt am vollen Origin inklusive Port.)

---

## 4. Multi-Agent — Verifikation

Der Anlass war Claude (Prozessbaum an `Claude.app`). Das **Kernproblem** gilt
aber für jeden Agenten, der Dev-Server in seiner Session/IDE startet:

| Anforderung | Agent-neutral? | Bemerkung |
| --- | --- | --- |
| Feste Ports / Registry | ja | reine Hub-Sache |
| Detached unter launchd | ja | überlebt Claude-, Cursor- und Terminal-Neustart |
| CLI `devhub up/down/status` | ja | jeder Agent mit Shell kann das |
| `*.localhost`-Adressen | ja | OS-Ebene |
| Übersicht UI | ja | Browser |
| Attach-Datei ohne Startkommando | nein — Claude | Adapter `launch.json` |
| „Nicht selbst starten“-Regel | teilweise | gleicher Text, andere Datei (`AGENTS.md`, Cursor-Rules, `CLAUDE.md`) |
| Hard-Stop gegen `npm run dev` | nein | nur wo Hooks existieren (Claude PreToolUse zuerst) |

**Ergebnis:** Mit Adapter-Schnitt statt Claude-Kern funktioniert das Konzept mit
anderen Coding-Agenten. Was fehlt, ist nicht Architektur, sondern der neutrale
Vertrag + optionale Adapter. Zwei Agenten gleichzeitig am selben Projekt sind
unproblematisch, solange **nur der Hub** Prozesse besitzt.

Was der Plan **nicht** enthält: keine Änderung an den Projekten außer der
`dev.json` bei den Abweichlern und dem optionalen Sync-Anker in `AGENTS.md`,
keinen Reverse-Proxy, keine hosts-Einträge, keinen Root-Prozess, keine
agent-übergreifende Memory-Vereinheitlichung.

## 5. Offene Punkte

| Punkt | Wann |
| --- | --- |
| Vite `allowedHosts` und `.localhost` | Etappe 1 |
| Interpreterpfad vs. Login-Shell | Etappe 1 |
| `.claude/launch.json` ist bei Journey eingecheckt — generiert heißt entweder Git-Rauschen oder `.gitignore` (dann `dev.json` einchecken) | Etappe 3 |
| Ob Cursor/Codex-Hooks nötig sind oder Regeln reichen | Etappe 3 / Feldtest |
| Memory-Pfade: Opt-in und Zuordnung Projekt ↔ Claude-Projektordner | Etappe 7 |
| Soll der Hub auch von selbst aufräumen dürfen? | Etappe 6 |

---

## Anhang: Messprotokoll (2026-08-06)

Alles am lebenden System gemessen, nicht aus der Dokumentation abgeleitet.

**Prozessbaum.** Alle vier laufenden Dev-Server hingen über
`npm` → `Claude.app/Contents/Helpers/disclaimer` an `Claude.app` (PID 34101, seit
5. August). Sie überleben also Sessions, aber keinen App-Neustart.

**`preview_start` hängt sich nicht an fremde Server.** Ein Python-Server auf dem
Port eines `launch.json`-Eintrags führte zu:

> Port 5217 is in use by "Python" (PID 59334) **(not a preview server)** … set
> `"autoPort": true` … remove hardcoded port flags.

Kein Attach, sondern Abbruch. **Deshalb braucht es zwei Dateien**: eine Quelle
mit Kommandos (`dev.json`) und eine generierte `.claude/launch.json` mit reinen
Attach-Einträgen. Und die vorgeschlagene Auflösung `autoPort: true` ist genau
die falsche — sie erzeugt den zweiten Server auf einer anderen Nummer.

**Es gibt bereits eine chat-übergreifende Registry.** Der Versuch, einen von
einem anderen Chat gestarteten Server neu zu starten, ergab: *„Port 5218 is in
use by another chat's dev server 'smoke2'. preview_stop won't stop another
chat's server."* Claude Code verhindert Doppelstarts also schon — aber nur für
Server, die es selbst gestartet hat.

**Attach-Einträge funktionieren und sind sicher.**
`{"name":…, "url":"http://localhost:5217", "port":5217}` ohne Kommando ergab
*„Attached the preview to the configured url; no process was started."*
`preview_list` führt so einen Server **gar nicht als Prozess** — es gibt für
Claude Code buchstäblich nichts, was es stoppen könnte.

**`*.localhost` löst systemweit auf.** `dscacheutil` beantwortet
`zufall-xyz123.localhost`, `hugur.localhost` und `tief.verschachtelt.localhost`
alle mit 127.0.0.1; `curl` und Node-`fetch` verbanden sich erfolgreich. Die
`/etc/hosts` enthält nichts dergleichen.

**Landschaft.** 6× Next, 4× Vite, 3× Docker Compose, 5 Python-Projekte, kein
einziges PHP-Projekt. Die elf vorhandenen `launch.json` enthalten bereits fünf
verschiedene Arten, einen Port zu übergeben (Positionsargument, Flag hinter `--`,
Umgebungsvariable, implizit, gar nicht) — daher der `{port}`-Platzhalter.
