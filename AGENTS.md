# devhub — Hinweise für Coding-Agenten

Dieses Repo ist das Werkzeug, das Dev-Server verwaltet. Es hat selbst keinen
Dev-Server.

## Was hier gilt

- **Keine Laufzeitabhängigkeiten.** Node-Standardbibliothek, sonst nichts. Wer
  hier ein Paket hinzufügt, macht das Werkzeug abhängig von genau der Sorte
  Zustand, die es aufräumen soll.
- **Bezeichner im Code englisch, Ausgabe an den Menschen deutsch.** CLI-Texte,
  Fehlermeldungen, Kommentare und die Oberfläche sind deutsch.
- **Zustand kommt aus der Messung, nicht aus einer Datei.** Ob etwas läuft,
  entscheidet die Port-Probe. Eine PID-Datei zu einem toten Prozess ist die
  häufigste Lüge in solchen Werkzeugen — dieser Fehler darf nicht zurückkommen.
- **Gestoppt wird die Prozessgruppe**, nie ein einzelner Prozess.
- **Kommentare erklären, warum**, nicht was. Wenn eine Zeile nur wiederholt, was
  danebensteht, gehört sie weg.

## Prüfen

```bash
npm test
```

Die Tests dürfen weder `~/.config/devhub/registry.json` noch ein Projekt in
`~/Dev` anfassen. Sie setzen `DEVHUB_CONFIG_DIR` und `DEVHUB_STATE_DIR` auf ein
temporäres Verzeichnis, bevor sie Module importieren — deshalb die dynamischen
`await import()` am Dateikopf. Das bitte so lassen.

Beim Ausprobieren an der Oberfläche:

```bash
npm run serve:dev    # Port 4001, eigenes Zustandsverzeichnis
```

Nie die produktive Instanz auf 4000 zum Testen benutzen: sonst bringt man die
PID-Dateien der echten Server durcheinander.

## Was hier nicht hingehört

- Kein Reverse-Proxy, keine `/etc/hosts`-Einträge, kein Root-Prozess.
- Keine Vereinheitlichung fremder Agent-Formate. Der Hub zeigt an, was gilt, und
  schreibt nur zwischen die eigenen Anker.
- Keine Änderung an fremden Projekten außer über `devhub sync`.
