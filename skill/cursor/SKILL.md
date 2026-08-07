---
name: devhub
description: >-
  Verwaltet lokale Dev-Server über das CLI `devhub`. Verwenden, wenn eine
  App gestartet, gestoppt, im Browser geöffnet oder der Dev-Server-Status
  geprüft werden soll — oder bevor npm/pnpm/vite/next/uvicorn o. Ä. ausgeführt
  würde. Kurzform `dev` ist Alias.
---

# Devhub — Dev-Server

## Pflicht

Auf diesem Rechner starten Coding-Agenten **keine** eigenen Dev-Server.

Verboten: `npm run dev`, `pnpm dev`, `yarn dev`, `bun dev`, `vite`, `next dev`,
`uvicorn`, `python -m http.server`, `docker compose up`, `npx serve`.

## Ablauf

1. Projektordner unter der Hub-Wurzel kennen (meist `~/Dev`, z. B. `journey`,
   `schnappster`) — das ist der CLI-Name, nicht der Anzeigename (Maptale,
   Schnappster).
2. `devhub status` bzw. `devhub status <ordner>` — läuft schon etwas? Welche URL?
   Bei einem Projekt erscheinen unter **Prozesse** die echten URLs (Frontend =
   Anzeige-Host, Backend = meist `http://127.0.0.1:<port>`). Nie
   `http://<anzeigename>.localhost:<backend-port>` erfinden.
3. Wenn nötig: `devhub up <ordner>` — startet alle Rollen (Frontend und API).
4. Nutzer-URL = Frontend-Zeile aus dem Status (z. B. `http://maptale.localhost:5120`).
5. Bei Startfehlern: `devhub logs <ordner>` lesen, nicht parallel selbst starten.
6. Stoppen: `devhub down <ordner>` (ganze Prozessgruppe).

Übersicht: http://devhub.localhost:4000

## Hinweise

- `devhub up` ist idempotent, wenn der Server schon läuft.
- Profil/Smoke: `devhub up <ordner> --profil smoke` (eigener Slot/Host).
- Fehlt `devhub` im PATH oder der Hub antwortet nicht: Nutzer kurz darauf hinweisen
  (`devhub service status` / launchd), nicht still auf `npm run dev` ausweichen.
