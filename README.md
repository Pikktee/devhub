# devhub

Ein kleiner lokaler Dienst, dem die Dev-Server aller Projekte gehören.

Die Server hängen nicht mehr an einer Agent-Sitzung, einer IDE oder einer Shell,
sondern an einem launchd-Dienst. Jedes Projekt hat einen festen Port und eine
feste Adresse. Coding-Agenten — Claude Code, Cursor, Codex — starten nichts mehr
selbst, sie hängen sich an oder rufen `devhub up` auf.

Warum es das gibt, steht in [PLAN.md](PLAN.md).

## Einrichten

```bash
cd ~/Dev/devhub
npm link                 # macht "devhub" und "dev" global verfügbar (optional)
devhub service install   # launchd-Dienst, Übersicht auf http://devhub.localhost:4000
```

Ohne `npm link` funktioniert alles genauso über `node ~/Dev/devhub/bin/dev.js`.
`dev` ist Kurzform für `devhub`.

## Kommandos

| Kommando | Wirkung |
| --- | --- |
| `devhub status [projekt]` | Was läuft, auf welcher Nummer, seit wann |
| `devhub up <projekt> [--profil p]` | Startet abgekoppelt; wirkungslos, wenn es schon läuft |
| `devhub down <projekt>` / `--alle` | Stoppt die ganze Prozessgruppe |
| `devhub restart <projekt>` | Stoppen und starten |
| `devhub logs <projekt> [-f] [-n 40]` | Ausgabe des Servers |
| `devhub ports` | Slot- und Portvergabe, grün = belegt |
| `devhub list` | Alle erkannten Projekte, auch die ohne Slot |
| `devhub adopt <projekt> [--slot N]` | Slot vergeben (`--profil smoke` für ein zweites Profil, `--titel Name` für den Anzeigenamen) |
| `devhub forget <projekt>` | Aus der Registry nehmen; der Slot bleibt gesperrt. Optional `--deps-loeschen` für node_modules/.next |
| `devhub favorite <projekt>` | Favorit umschalten (`--aus` entfernt); auch ohne Slot möglich |
| `devhub unfavorite <projekt>` | Favorit entfernen |
| `devhub sync [--projekt x] [--global]` | Agent-Dateien schreiben, `--probelauf` zeigt nur |
| `devhub agents [projekt]` | Regeln, Skills und Memory dieses Projekts |
| `devhub link [projekt]` | `AGENTS.md` und `CLAUDE.md` verknüpfen; ohne Argument nur Bericht |
| `devhub doctor` | Kollisionen und Ungereimtheiten |
| `devhub serve [--port 4000]` | Hub im Vordergrund |
| `devhub service install\|uninstall\|status` | launchd-Dienst |
| `devhub open [projekt]` | Im Browser öffnen; `--finder` / `--ordner` zeigt den Projektordner im Finder |
| `devhub reveal <projekt>` | Projektordner im Finder zeigen |

Ohne Projektnamen nehmen die Kommandos das Verzeichnis, in dem man steht.

## Ports und Adressen

Der Slot ist zweistellig, wird einmal vergeben und nie wiederverwendet.

| Rolle | Formel | Slot 90 |
| --- | --- | --- |
| Frontend | `51NN` | 5190 |
| Backend | `87NN` | 8790 |

Die Adresse lautet `http://<projekt>.localhost:<port>`, ein zweites Profil
bekommt `<projekt>-<profil>.localhost`. macOS löst beliebige `*.localhost`-Namen
ohne Zutun auf 127.0.0.1 auf — kein Eintrag in `/etc/hosts`, kein Proxy, kein
root. Der Port bleibt in der Adresse, damit Vites HMR unverändert funktioniert.

Der Gewinn ist nicht Kosmetik: Cookies sind portunabhängig. Zwei Instanzen
desselben Projekts unter `localhost` überschreiben sich gegenseitig die
Anmeldung; unter getrennten Hostnamen nicht mehr.

## `dev.json`

Sprachneutral, mit `{port}`-Platzhalter. Der Hub weiß nicht, wie ein Projekt
einen Port entgegennimmt — er setzt nur ein.

```json
{
  "profiles": {
    "default": [
      { "name": "web", "runner": "process", "role": "frontend",
        "cmd": ["npm", "run", "dev", "--", "--port", "{port}", "--strictPort"] },
      { "name": "api", "runner": "process", "role": "backend",
        "cwd": "server", "env": { "PORT": "{port}" }, "cmd": ["npm", "run", "dev"] }
    ]
  }
}
```

Die deutschen Schlüssel aus `PLAN.md` (`profile`, `rolle`) werden ebenso
gelesen — eine vorhandene Datei soll nicht an einer Vokabel scheitern.

- `runner`: `process` (Standard), `compose` oder `static`
- `role`: `frontend` → `51NN`, `backend` → `87NN`. Jede Rolle kommt pro Profil
  genau einmal vor; ein dritter Prozess braucht ein eigenes Profil mit eigenem Slot.
- Platzhalter in `cmd` und `env`: `{port}`, `{host}`, `{url}`, `{project}`,
  `{profile}`, `{path}` (deutsche Namen gehen auch)

**Node-Projekte brauchen keine `dev.json`** — der Hub leitet den Start aus der
`package.json` ab und schiebt den Port über `--port` und `PORT` nach. Er sucht
das Startskript auch in `web/`, `app/`, `landing/` und ähnlichen Unterordnern.

Steht bei einem Ordner „braucht `dev.json`“ oder „kein Server“, meint das: der
Hub findet dort kein ableitbares Startkommando. Oft ist das kein Fehler —
Notizordner, Unity, Swift, Sammelordner. Bei Sammelordnern (`konzepte`,
`python-kurs`) den Unterordner einzeln aufnehmen:
`devhub adopt konzepte/augenarzt`.

**Python** braucht die Datei, mit absolutem Interpreterpfad statt Login-Shell:

```json
{
  "profiles": {
    "default": [
      { "name": "api", "role": "backend",
        "cmd": [".venv/bin/uvicorn", "app:app", "--port", "{port}"] }
    ]
  }
}
```

## Was der Hub selbst durchsetzt

- **Abgekoppelt starten**: eigene Prozessgruppe, `unref`, Ausgabe in eine Datei.
  Der Server überlebt Shell, IDE und Agent.
- **Stoppen über die Gruppe**, nicht über den Prozess. Sonst überlebt bei
  `npm run dev` → `node vite` das Kind und hält den Port besetzt.
- **Status aus der Port-Probe**, nicht aus der PID-Datei.
- **Vor dem Start** muss der Port frei sein, **nach dem Start** wird geprüft, ob
  der Prozess wirklich auf der zugewiesenen Nummer lauscht. Next.js kann das
  Ausweichen nicht abschalten; weicht es aus, stoppt der Hub es und sagt es.
- **Idempotenz**: `devhub up` auf etwas Laufendem ist ein No-op.

## Agenten

`devhub sync` schreibt zwei Schichten:

| Datei | Committen? | Inhalt |
| --- | --- | --- |
| `AGENTS.md` (zwischen Ankern) | ja | Portabler Hinweis: „wenn `devhub` da ist, nutzen — sonst normal starten“ |
| `.cursor/rules/devhub.local.mdc` | **nein** | Ports/URLs dieser Maschine (`alwaysApply`) |
| `.claude/launch.json` | **nein** | Attach-Einträge für Claude Code |
| `.gitignore` (Marker `# >>> devhub`) | ja | Nimmt die lokalen Dateien aus dem Repo |

So landet nichts Maschinengebundenes im Git; auf einem Rechner ohne Hub
bleibt der AGENTS.md-Text sinnvoll („ohne `devhub`: wie üblich starten“).

Der Anker `<!-- devhub:anfang -->` grenzt den geschriebenen Teil in `AGENTS.md`
ab; alles davor und danach bleibt unangetastet. Eine vorhandene `launch.json`
mit Kommandos wird vor dem Überschreiben nach `.claude/launch.json.vor-devhub`
gesichert.

`devhub sync --global` schreibt die allgemeine Regel zusätzlich nach
`~/.claude/CLAUDE.md`, `~/.cursor/rules/devhub.mdc` und `~/.codex/AGENTS.md`.
`--hook` installiert obendrein einen Claude-PreToolUse-Hook, der `npm run dev`
und Verwandte abfängt — der wirkt unabhängig davon, was das Modell gerade denkt.

### Agent-Kontext ansehen

`devhub agents <projekt>` und der Reiter im Hub zeigen, welche Regeln, Skills,
Subagenten und Sitzungsspeicher für ein Projekt gelten — im Projekt und global.
Nur lesen, nicht schreiben: der Hub soll nicht mit einem laufenden Agenten um
dieselbe Datei streiten.

Die Anzeige läuft ausschließlich über 127.0.0.1, und die Datei-Schnittstelle
liefert nur, was vorher als Agent-Kontext gefunden wurde — kein freier
Dateizugriff über HTTP.

### `AGENTS.md` und `CLAUDE.md` verknüpfen

Zwei Dateien mit demselben Inhalt laufen früher oder später auseinander, und
dann gilt für Claude etwas anderes als für Cursor. `devhub link` prüft, welcher von
fünf Zuständen vorliegt, und handelt nur dort, wo nichts verloren gehen kann:

| Zustand | Was passiert |
| --- | --- |
| bereits verknüpft | nichts — die Richtung wird nur angezeigt |
| nur eine Datei da | die fehlende wird ein relativer Verweis auf die vorhandene |
| zwei **identische** Dateien | eine wird durch einen Verweis ersetzt (Inhalte per SHA-256 verglichen) |
| zwei **verschiedene** Dateien | Abbruch mit Begründung — das muss ein Mensch entscheiden |
| Verweis zeigt ins Leere | Meldung, keine Aktion |

Gleiche Dateigröße genügt nicht: zwei Dateien können byteweise gleich groß und
trotzdem verschieden sein. Verglichen wird der Inhalt.

Der Verweis ist **relativ** (`CLAUDE.md -> AGENTS.md`), damit er einen Klon oder
Umzug des Repos übersteht. `devhub sync` schreibt durch einen solchen Verweis
hindurch, ohne ihn zu zerstören — dafür gibt es einen Test.

## Zwei Instanzen

Beim Entwickeln an der Oberfläche:

```bash
npm run serve:dev     # Port 4001, eigenes Zustandsverzeichnis
```

Die Registry ist geteilt (die Portvergabe braucht eine einzige Wahrheit), die
PID-Dateien nicht — sonst hält man beim Testen fremde Prozesse für die eigenen.

## Ablagen

| Was | Wo |
| --- | --- |
| Registry (Slots, Favoriten, Anzeigenamen, Einstellungen) | `~/.config/devhub/registry.json` |
| Laufende Instanzen | `~/.local/state/devhub/state.json` |
| Logs | `~/.local/state/devhub/logs/<projekt>-<profil>-<prozess>.log` |
| launchd | `~/Library/LaunchAgents/net.henrikheil.devhub.plist` |

In der Übersicht stehen Favoriten oben in einer eigenen Gruppe. Der Anzeigename
(z. B. „Maptale“ statt Ordner `journey`) kommt aus der Registry, sonst aus
`dev.json` (`title`/`displayName`), einem lesbaren `package.json`-Namen oder
der ersten Überschrift in README/CLAUDE/AGENTS — der Ordnername bleibt die
stabile ID.

## Tests

```bash
npm test
```

Die Integrationstests starten echte Prozesse aus `test/fixtures/` in einem
temporären Zustandsverzeichnis — sie fassen weder die Registry noch ein echtes
Projekt an. `test/fixtures/ausweicher` tut, was Next.js tut: er nimmt eine
andere Nummer. Der Test prüft, dass der Hub das bemerkt.
