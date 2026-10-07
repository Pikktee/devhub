# Plan: Worktrees in devhub starten

Stand: 8. Oktober 2026. Noch nicht umgesetzt.

## Anlass

Agenten arbeiten in Git-Worktrees (`<projekt>/.claude/worktrees/<name>`, aber auch
außerhalb, z. B. `/Volumes/Daten/wt-sec2`). Die globale Regel verbietet ihnen, Dev-Server
selbst zu starten; devhub kennt aber nur Projektordner. Den Stand eines Worktrees kann
deshalb niemand im laufenden Server prüfen.

## Entscheidungen

| Frage | Entscheidung |
|---|---|
| Aufruf | `devhub up .` bzw. `devhub up <pfad>`; kein `projekt@worktree` |
| Adresse | `<branch>.<anzeigename>.localhost`, z. B. `optionen-runde-2.maptale.localhost` |
| Ports | eigener Pool, 20 Plätze: 5210–5229 / 8810–8829, wiederverwendbar |
| Daten | Worktree startet leer; Kopie nur auf Befehl (`--daten`) |
| Netz | Worktrees immer nur `127.0.0.1`, auch bei `networkAccess` |
| Vorbereitung | Weg 3: devhub setzt nur Umgebung; `.env` und Abhängigkeiten macht der Agent |
| Compose | später; v1 lehnt Compose-Worktrees mit klarer Meldung ab |
| Konfiguration | `devhub.json` wird pro Profil mit den abgeleiteten Profilen zusammengeführt |

## Umfang v1

### Erkennung

- Hauptprojekt über `git rev-parse --git-common-dir`, nicht über den Pfad. So werden
  auch Worktrees außerhalb des Projektordners erkannt.
- `devhub up` **ohne** Argument im Worktree darf nicht über `basename(cwd)` auflösen
  (`src/cli.js:101`): heißt ein Worktree wie ein Projekt, startete sonst das Hauptprojekt.
- Präfix der Adresse: **Branch-Name** (wie bei portless), lesbarer als Zufallsordner
  wie `kind-shannon-8918c8`. Regeln:
  - nur das letzte Segment nach `/` (`feat/einladungen-weitergeben` →
    `einladungen-weitergeben`, `claude/sicherheit-etappe-2` → `sicherheit-etappe-2`);
  - das Präfix `worktree-`, das Claude Code an Branches hängt, entfällt
    (`worktree-optionen-runde-2` → `optionen-runde-2`);
  - detached HEAD: Ordnername;
  - danach `slugifyLabel`, max. 63 Zeichen; kollidieren zwei Worktrees, bekommt der
    spätere ein Suffix (`-2`).
- Die Adresse wird beim ersten `up` festgehalten und bleibt, auch wenn im Worktree
  später der Branch gewechselt wird; sonst wandert die URL unter laufenden Sitzungen.

### Instanz und Schlüssel

- Eine Instanz pro Worktree, immer mit dem Profil `default` des Hauptprojekts.
- Eigener Schlüssel für `state.json` (`src/state.js:6`) und Logdateien
  (`src/supervisor.js:13`), z. B. `journey@optionen-runde-2:default`.
- `status`, `down`, `logs` und `describeProject` lösen Worktree-Pfade auf.
- Hub-UI zeigt Worktree-Instanzen unter ihrem Projekt.

### Ports

- Neue Bänke in `src/ports.js`; `describePort()` muss sie kennen (die Mod schlägt
  Port-Besitzer darüber nach, `claude-mod/hooks/hub.ts:187`).
- Ein Platz ist an einen existierenden Worktree vermietet und wird frei, sobald der
  Worktree verschwindet. Ob er belegt ist, entscheidet die Port-Probe, nicht die Datei.
- Registry-Schreiben mit Sperre bzw. atomar, damit parallele Agenten nicht denselben
  Platz bekommen.
- Restrisiko bei Wiederverwendung: eine alte Adresse öffnet später einen anderen
  Worktree mit dem localStorage desselben Origins. Bewusst in Kauf genommen.

### Umgebung (devhub, ohne ins Projekt zu schreiben)

- Ports wie heute über Profil-Env (`PORT`, `{backendUrl}` usw.). Umgebungsvariablen
  haben Vorrang vor `.env` (Node `--env-file-if-exists`, Vite), die Ports der `.env`
  stören also nicht.
- Zusätzliche Variablen aus `worktree.env` der `devhub.json`, mit Platzhaltern wie
  `{url}`. Bei Maptale nötig: `MAPTALE_WEB_URL`, `MAPTALE_BASE_URL` (stehen in der
  `.env` mit der Adresse der Hauptinstanz).

### Vorbereitung prüfen, nicht ausführen

Vor dem Start prüft devhub und bricht mit fertigen Befehlen ab, statt erst nach dem
Bereitschafts-Timeout im Log zu scheitern:

- `.env` fehlt, obwohl das Hauptprojekt eine hat → Hinweis auf Symlink
  (z. B. `ln -s ../../../.env .env`).
- `node_modules` fehlt in einem Ordner mit Lockfile (bei journey: Root und `server/`)
  → Hinweis auf `npm ci` bzw. den passenden Paketmanager. Nicht verlinken.

### Daten (`--daten`)

- Einzige Stelle, an der devhub ins Projekt schreibt. Ausnahme in `AGENTS.md` mit
  Begründung festhalten: eine konsistente Kopie einer laufenden SQLite-Datenbank ist
  fehleranfällig und gehört nicht in jeden Agenten.
- Liste aus `worktree.daten` der `devhub.json` des **Hauptprojekts**.
- SQLite-Dateien per `VACUUM INTO` (konsistent auch mit offener WAL), Ordner per
  APFS-Klon (`cp -c`), sonst normale Kopie.
- Ziel liegt im Worktree (gitignored); `git worktree remove` räumt es mit ab.
- Nur auf ausdrücklichen Aufruf, auch erneut als „zurücksetzen“.
- Polar-OAuth bleibt im Worktree kaputt (feste Rückleit-Adresse) – dokumentieren.

### Aufräumen

- Bei `status`, beim Laden der Übersicht und bei `up` (keine Hintergrundschleife).
- Quelle: `git worktree list --porcelain` des Hauptprojekts, mit `prunable`.
- Ein nicht eingehängtes Volume zählt nicht als gelöscht.
- Verschwundener Worktree: Prozessgruppe stoppen, Platz freigeben.

## `devhub.json`: Zusammenführen pro Profil

Heute ersetzt eine vorhandene `devhub.json` die Ableitung vollständig, und ohne
`profiles` bricht das Einlesen ab (`src/discovery.js:129`). Neu:

- Abgeleitete Profile sind immer die Grundlage.
- Ein Profil in `devhub.json` ersetzt nur das gleichnamige abgeleitete.
- `displayName`, `worktree` usw. ergänzen nur; eine Datei ohne `profiles` ist gültig.
- Unbekannte Schlüssel erzeugen eine Warnung.
- Die Herkunft wird pro Profil angezeigt („default: abgeleitet, smoke: devhub.json“).

Bestehende Dateien (job-factory, pfdb, pfdb-neu) definieren alle `default` und
verhalten sich unverändert.

Für journey (eigener Commit dort):

```json
{
  "worktree": {
    "daten": ["server/daten/maptale.db", "server/daten/luhambo.db", "server/daten/tours", "server/daten/karte", "server/daten/benutzer"],
    "env": { "MAPTALE_WEB_URL": "{url}", "MAPTALE_BASE_URL": "{url}" }
  }
}
```

Nebenbei klären:

- Top-Level-`env` wird eingelesen, aber nie benutzt (`src/discovery.js:137`):
  verdrahten oder entfernen.
- journey hat einen Slot 30 für Profil `smoke`, das nirgends definiert ist.
- Die Ableitung kennt `MAPTALE_API` fest (`src/discovery.js:235`); ließe sich mit der
  neuen Datei ins Projekt verschieben.
- `devhub link` führt devhub selbst nicht auf.

## Claude-Code-Mod, Skill, Regeln

- `projectForCwd` (`claude-mod/hooks/hub.ts:39`) ordnet über Pfad-Präfix zu: ein Agent im
  Worktree sieht Status und Adresse des Hauptprojekts, einer außerhalb sieht nichts.
  Muss die Worktree-Instanz finden.
- `~/.claude/CLAUDE.md` (Abschnitt „Dev-Server gehören devhub“), Skill (`skill/`) und
  README um `devhub up .` und `--daten` ergänzen.

## Nicht in v1

- Compose-Worktrees (bräuchten pro Projekt eine Liste zusätzlicher Port-Variablen;
  pfdb bindet 3306, 8028, 8728 fest).
- Mehrere Profile pro Worktree.
- Automatisches Installieren oder Verlinken.

## Tests

Wie gehabt mit `DEVHUB_CONFIG_DIR`/`DEVHUB_STATE_DIR` im Temp-Verzeichnis. Abdecken:
Erkennung (inkl. Worktree außerhalb, Namenskollision), Pool-Vergabe und -Freigabe,
paralleles Vergeben, Zusammenführen der `devhub.json`, Vorbereitungsprüfung,
Aufräumen mit nicht eingehängtem Pfad, `VACUUM INTO`-Kopie.

## Vergleich

portless (Vercel Labs) löst Adressen samt Worktree-Präfix bereits, über einen
Reverse Proxy; es übernimmt aber nicht die Prozesse. Übernommen wird nur die Idee
(Erkennung ohne Konfiguration, Branch-Name als Präfix), nicht das Werkzeug –
Proxy und Port 443 widersprechen `AGENTS.md`.
