# Design System — devhub

Single Source of Truth für die Oberfläche. Code-Tokens liegen in
[`ui/styles/tokens.css`](ui/styles/tokens.css). SCSS-Tooling re-exportiert
dieselbe Datei über [`ui/styles/tokens.scss`](ui/styles/tokens.scss).
Komponentenstile bleiben in [`ui/style.css`](ui/style.css) und importieren
die Tokens — keine Hex-Werte dort neu erfinden.

## Atmosphäre

Ruhig, dicht, werkzeughaft. Dunkle Standardansicht mit kühlem Blaugrau,
heller Modus als gleichwertige Variante. Akzent ist gedämpftes Stahlblau,
kein Neon. Typografie: IBM Plex Sans / Mono. Wenig Schatten, feine Ränder,
klare Hierarchie statt Kartenstapel.

## Themen

| Attribut | Bedeutung |
|---|---|
| `data-theme="dark"` | Standard / gespeichert dunkel |
| `data-theme="light"` | Gespeichert hell |
| kein `data-theme` | Kurz System-`prefers-color-scheme`, bis das Inline-Script greift |

Umschalten speichert in `localStorage` (`devhub-theme`), nicht in der Registry.

## Design Tokens

### Flächen

| Token | Rolle | Dark | Light |
|---|---|---|---|
| `--bg` | Seitengrund | `#0a0e14` | `#eef1f5` |
| `--bg-kuppel` | oberer Verlauf | `#101722` | `#e4eaf2` |
| `--bg-tief` | tiefer Grund | `#06090e` | `#e2e7ee` |
| `--flaeche` | Panels, aktive Segmente | `#121820` | `#ffffff` |
| `--flaeche-hoch` | angehobene Fläche | `#1a2330` | `#f4f6f9` |
| `--flaeche-hover` | Hover-Fill | `#212b3a` | `#ebf0f6` |

### Text

| Token | Rolle | Dark | Light |
|---|---|---|---|
| `--text` | Primärtext, aktive Controls | `#eef2f7` | `#121820` |
| `--text-leise` | sekundäre Labels | `#a8b4c7` | `#445266` |
| `--text-still` | Meta, Platzhalter, inaktive Segmente | `#7a879c` | `#6b788c` |

Regel: Interaktive Elemente im Hover/Focus bekommen `--text` **und** einen
sichtbaren Flächenwechsel (`--flaeche-hover` / `--flaeche-hoch`). Nur die
Textfarbe zu ändern reicht nicht — sonst kippt der Kontrast.

### Linien & Fokus

| Token | Rolle |
|---|---|
| `--rand` | Standardrahmen |
| `--rand-stark` | betonte Kante / Hover-Rand |
| `--fokus` | Tastaturfokus-Ring (akzenthell auf `--bg`) |

### Akzent & Status

| Token | Rolle | Dark | Light |
|---|---|---|---|
| `--akzent` | primäre Aktion, Markierung | `#3d7ab5` | `#21649a` |
| `--akzent-hell` | Hover/Focus auf Akzent | `#5b9fd4` | `#2a78b8` |
| `--akzent-text` | Text auf Akzentfläche | `#d6e8f7` | `#ffffff` |
| `--akzent-wash` | Anteil Akzent im Seitenverlauf | `22%` | `14%` |
| `--gruen` / `--gelb` / `--rot` / `--blau` | Status | siehe `tokens.css` | siehe `tokens.css` |
| `--*-leise` | Status-Waschungen | `color-mix` aus der Statusfarbe | |

### Form, Typo, Bewegung

| Token | Wert | Rolle |
|---|---|---|
| `--radius` | `10px` | Karten, große Controls |
| `--radius-sm` | `6px` | Chips, Segment-Knöpfe |
| `--font` | IBM Plex Sans … | UI-Text |
| `--mono` | IBM Plex Mono … | Pfade, Ports, Registry |
| `--ease` | `cubic-bezier(0.22, 1, 0.36, 1)` | Standard-Transition |
| `--schatten` | themenabhängig | seltene Elevation |
| `--korn` | `0.045` / `0.02` | dezentes Filmgrain |

## Hierarchie in Einstellungen

1. **Abschnitt** (`.einst-sektion-titel`) — 15px, Gewicht 650, `--text`
2. **Abschnitts-Meta** (`.einst-sektion-meta`) — 12px, `--text-still`, zeigt Ist-Wert
3. **Einstellungsname** (`.einst-zeile-name`) — 13px, `--text-leise`
4. **Hilfe** (`.einst-zeile-hilfe`) — 12.5px, `--text-still`

Abschnittstitel und Einstellungstitel dürfen optisch nicht gleich schwer sein.

## Dateien

```
DESIGN.md                 ← diese Spezifikation
ui/styles/tokens.css      ← Tokens (CSS Custom Properties)
ui/styles/tokens.scss     ← Re-Export für SCSS (@use)
ui/style.css              ← Komponenten, importiert tokens.css
ui/app.js                 ← Verhalten, keine Farben hardcoden
```

Neue Farbe oder Radius: zuerst hier und in `tokens.css`, dann verwenden.
Keine magischen Hex-Werte in Komponentenregeln, außer unvermeidbare
Einmalfälle (z. B. reines Weiß auf Akzent-Thumb) — die gehören kommentiert.
