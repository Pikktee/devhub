const $ = (selector) => document.querySelector(selector)

const h = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

const zustand = {
  daten: null,
  ansicht: 'uebersicht',
  projekt: null,
  log: { profil: 'default', prozess: null, folgen: true },
  verlauf: { datei: null, eintraege: [], signatur: '' },
  agenten: null,
  agentenProjekt: null,
  vorschau: null,
  detailPanels: {},
  gruppenOffen: {},
  listenSignatur: '',
  fussSignatur: '',
  logSignatur: '',
  pollTimer: null,
  ladenLaufend: false,
  befehl: { query: '', index: 0, treffer: [], ebene: 'root', projekt: null },
  einstellungen: { geladen: null, draft: null, dirty: false, speichern: false, hinweis: '' }
}

const THEME_KEY = 'devhub-theme'
const EINST_SEKTIONEN_KEY = 'devhub-einst-sektionen'
const EINST_SEKTIONEN_DEFAULT = {
  oberflaeche: true,
  projekte: true,
  hub: false,
  werkzeuge: false,
  agenten: false
}
const EINST_CHEVRON = `<svg class="einst-sektion-chevron" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4.5 6.25 8 9.75l3.5-3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`

function themeAktuell() {
  const attr = document.documentElement.dataset.theme
  if (attr === 'light' || attr === 'dark') return attr
  try {
    const gespeichert = localStorage.getItem(THEME_KEY)
    if (gespeichert === 'light' || gespeichert === 'dark') return gespeichert
  } catch {
    /* ignore */
  }
  return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

function einstSektionenOffen() {
  try {
    const roh = localStorage.getItem(EINST_SEKTIONEN_KEY)
    if (!roh) return { ...EINST_SEKTIONEN_DEFAULT }
    const gelesen = JSON.parse(roh)
    if (!gelesen || typeof gelesen !== 'object') return { ...EINST_SEKTIONEN_DEFAULT }
    return { ...EINST_SEKTIONEN_DEFAULT, ...gelesen }
  } catch {
    return { ...EINST_SEKTIONEN_DEFAULT }
  }
}

function setzeEinstSektion(id, offen) {
  if (!id || !(id in EINST_SEKTIONEN_DEFAULT)) return
  const stand = einstSektionenOffen()
  stand[id] = Boolean(offen)
  try {
    localStorage.setItem(EINST_SEKTIONEN_KEY, JSON.stringify(stand))
  } catch {
    /* ignore */
  }
}

function einstSektionHtml({ id, titel, meta, koerper, offen }) {
  return `<details class="einst-sektion" data-einst-sektion="${h(id)}"${offen ? ' open' : ''}>
    <summary class="einst-sektion-kopf">
      <span class="einst-sektion-text">
        <span class="einst-sektion-titel">${titel}</span>
        <span class="einst-sektion-meta">${meta}</span>
      </span>
      ${EINST_CHEVRON}
    </summary>
    <div class="einst-sektion-koerper">${koerper}</div>
  </details>`
}

function setzeTheme(theme) {
  const wert = theme === 'light' ? 'light' : 'dark'
  document.documentElement.dataset.theme = wert
  try {
    localStorage.setItem(THEME_KEY, wert)
  } catch {
    /* ignore */
  }
  const meta = document.querySelector('meta[name="color-scheme"]')
  if (meta) meta.content = wert
  if (zustand.ansicht === 'einstellungen' && zustand.einstellungen.draft) {
    for (const knopf of document.querySelectorAll('#einst-form [data-einst="theme-set"]')) {
      const aktiv = knopf.dataset.theme === wert
      knopf.classList.toggle('aktiv', aktiv)
      knopf.setAttribute('aria-pressed', String(aktiv))
    }
    const sektionMeta = document.querySelector('[data-einst-sektion="oberflaeche"] .einst-sektion-meta')
    if (sektionMeta) sektionMeta.textContent = wert === 'light' ? 'Hell' : 'Dunkel'
  }
}

// ------------------------------------------------------------------ Netz

async function api(pfad, optionen = {}) {
  const antwort = await fetch(pfad, {
    ...optionen,
    headers: { 'content-type': 'application/json', ...(optionen.headers ?? {}) }
  })
  const daten = await antwort.json().catch(() => ({}))
  if (!antwort.ok) throw new Error(daten.error ?? `${antwort.status} ${antwort.statusText}`)
  return daten
}

let meldungTimer
function zeigeMeldung(inhalt, typ = 'fehler', { dauerMs } = {}) {
  const kasten = $('#meldung')
  if (typeof inhalt === 'string') kasten.textContent = inhalt
  else {
    kasten.replaceChildren(inhalt)
  }
  kasten.dataset.typ = typ
  kasten.setAttribute('data-offen', '')
  kasten.setAttribute('role', typ === 'fehler' ? 'alert' : 'status')
  clearTimeout(meldungTimer)
  const ms = dauerMs ?? (typ === 'fehler' ? 9000 : 4500)
  meldungTimer = setTimeout(() => kasten.removeAttribute('data-offen'), ms)
}
function zeigeFehler(text) {
  zeigeMeldung(text, 'fehler')
}
function zeigeOk(text) {
  zeigeMeldung(text, 'ok')
}

function relativZumProjekt(datei, projektPfad) {
  if (projektPfad && datei.startsWith(projektPfad)) {
    const rest = datei.slice(projektPfad.length)
    return rest.startsWith('/') ? `.${rest}` : `./${rest}`
  }
  return datei.replace(/^\/Users\/[^/]+/, '~')
}

function syncAenderungen(ergebnis) {
  const zeilen = []
  for (const r of ergebnis.results ?? []) {
    for (const c of r.changes ?? []) {
      zeilen.push({
        projekt: r.project,
        absolut: c.file,
        pfad: relativZumProjekt(c.file, r.path),
        status: !c.changed ? 'unverändert' : c.deleted ? 'gelöscht' : c.created ? 'neu' : 'aktualisiert',
        action: c.action ?? '',
        detail: c.detail ?? '',
        changed: Boolean(c.changed),
        backup: c.backup ?? null
      })
    }
  }
  for (const c of ergebnis.global ?? []) {
    zeilen.push({
      projekt: 'global',
      absolut: c.file,
      pfad: relativZumProjekt(c.file),
      status: !c.changed ? 'unverändert' : c.deleted ? 'gelöscht' : c.created ? 'neu' : 'aktualisiert',
      action: c.action ?? '',
      detail: c.detail ?? '',
      changed: Boolean(c.changed),
      backup: c.backup ?? null
    })
  }
  return zeilen
}

function zeigeProtokollDialog({ titel, vorspann = [], geaendert = [], rohtext = '', hinweis = '', hinweisHtml = false }) {
  $('#protokoll-titel').textContent = titel
  const teile = []

  if (vorspann.length) {
    teile.push(`<ul class="protokoll-punkte">${vorspann.map((t) => `<li>${h(t)}</li>`).join('')}</ul>`)
  }

  if (geaendert.length) {
    teile.push(`
      <div class="protokoll-abschnitt">
        <h3>Geänderte Dateien <span class="hint">${geaendert.length}</span></h3>
        <ul class="protokoll-dateien">
          ${geaendert
            .map(
              (z) => `<li>
                <span class="protokoll-status" data-status="${h(z.status)}">${h(z.status)}</span>
                <code title="${h(z.absolut)}">${h(z.pfad)}</code>
                ${z.detail ? `<span class="hint">${h(z.detail)}</span>` : ''}
                ${pfadAktionenHtml(z.absolut, { kompakt: true })}
              </li>`
            )
            .join('')}
        </ul>
      </div>`)
  } else if (!vorspann.length) {
    teile.push('<p class="protokoll-leer">Keine Dateiänderungen.</p>')
  }

  if (rohtext) {
    teile.push(`
      <details class="protokoll-details">
        <summary>Vollständiges Protokoll</summary>
        <pre class="protokoll-text">${h(rohtext)}</pre>
      </details>`)
  }

  if (hinweis) {
    teile.push(`<div class="protokoll-hinweis">${hinweisHtml ? hinweis : h(hinweis)}</div>`)
  }

  $('#protokoll-koerper').innerHTML = teile.join('')
  const dlg = $('#protokoll')
  if (typeof dlg.showModal === 'function') dlg.showModal()
  else dlg.setAttribute('open', '')
}

/** @deprecated Alias — früher nur Klartext. */
function zeigeProtokoll(text, titel = 'Protokoll') {
  zeigeProtokollDialog({ titel, rohtext: text })
}

function formatSyncProtokoll(ergebnis, { titel, vorspann = [] } = {}) {
  const zeilen = syncAenderungen(ergebnis)
  const geaendert = zeilen.filter((z) => z.changed)
  const lines = [...vorspann]
  for (const r of ergebnis.results ?? []) {
    if (r.slot != null) lines.push(`Slot ${r.slot}`)
    for (const inst of r.instances ?? []) {
      for (const e of inst.entries ?? []) {
        lines.push(`  ${inst.profile}/${e.name}: ${e.url ?? '—'}`)
      }
    }
  }
  if (lines.length) lines.push('')
  for (const z of zeilen) {
    lines.push(`${z.status.padEnd(12)} ${z.pfad}`)
    lines.push(`             ${z.absolut}`)
    if (z.action) lines.push(`             ${z.action}${z.detail ? ` — ${z.detail}` : ''}`)
    if (z.backup) lines.push(`             Sicherung: ${z.backup}`)
  }
  if (ergebnis.results?.[0]?.log?.length) {
    lines.push('', '— Hub-Log —', ...ergebnis.results[0].log)
  }
  const kopf =
    titel ??
    (geaendert.length
      ? `${geaendert.length} Datei${geaendert.length === 1 ? '' : 'en'} geändert`
      : 'Bereits aktuell — nichts geändert')

  const zusammenfassung = [...vorspann]
  for (const r of ergebnis.results ?? []) {
    if (r.slot != null) zusammenfassung.push(`Slot ${r.slot}`)
    for (const inst of r.instances ?? []) {
      for (const e of inst.entries ?? []) {
        if (e.url) zusammenfassung.push(`${inst.profile}/${e.name}: ${e.url}`)
      }
    }
  }

  return {
    kopf,
    text: lines.join('\n') || 'Keine Einträge.',
    vorspann: zusammenfassung,
    geaendert
  }
}

function zeigeSyncBericht(ergebnis, optionen = {}) {
  const { kopf, text, vorspann, geaendert } = formatSyncProtokoll(ergebnis, optionen)
  zeigeOk(
    geaendert.length
      ? `${geaendert.length} Datei${geaendert.length === 1 ? '' : 'en'} geändert`
      : vorspann.length
        ? kopf
        : 'Bereits aktuell'
  )
  // Ohne Substanz reicht die Toast-Meldung — kein Modal-Lärm.
  if (!geaendert.length && !vorspann.length) return
  zeigeProtokollDialog({
    titel: kopf,
    vorspann,
    geaendert,
    rohtext: text,
    hinweis: 'Dauerhaft im Hub-Log (Kopfzeile → Verlauf).'
  })
}

function oeffneVerlauf({ ersetzen = false } = {}) {
  schliesseDateiVorschau()
  return geheZu('/verlauf', { ersetzen })
}

function oeffneEinstellungen({ ersetzen = false } = {}) {
  schliesseDateiVorschau()
  return geheZu('/einstellungen', { ersetzen })
}

function einstellungenKlon(daten) {
  return {
    roots: [...(daten.roots ?? [])],
    hubPort: daten.hubPort,
    domainSuffix: daten.domainSuffix,
    editor: daten.editor,
    showGlobalAgentContext: Boolean(daten.showGlobalAgentContext),
    readyTimeoutMs: daten.readyTimeoutMs,
    registryFile: daten.registryFile
  }
}

function einstellungenDirty() {
  const { geladen, draft } = zustand.einstellungen
  if (!geladen || !draft) return false
  return (
    geladen.hubPort !== draft.hubPort ||
    geladen.domainSuffix !== draft.domainSuffix ||
    geladen.editor !== draft.editor ||
    geladen.showGlobalAgentContext !== draft.showGlobalAgentContext ||
    geladen.readyTimeoutMs !== draft.readyTimeoutMs ||
    JSON.stringify(geladen.roots) !== JSON.stringify(draft.roots)
  )
}

async function ladeEinstellungen({ erzwingen = false } = {}) {
  if (!erzwingen && zustand.einstellungen.geladen && !zustand.einstellungen.dirty) {
    return zustand.einstellungen.geladen
  }
  const daten = await api('/api/settings')
  zustand.einstellungen.geladen = einstellungenKlon(daten)
  zustand.einstellungen.draft = einstellungenKlon(daten)
  zustand.einstellungen.dirty = false
  zustand.einstellungen.hinweis = ''
  return daten
}

function seitenTitelHtml(teile) {
  const knoten = teile
    .map((teil, i) => {
      const last = i === teile.length - 1
      const label = teil.sub
        ? `${h(teil.label)} <span class="sub">${h(teil.sub)}</span>`
        : h(teil.label)
      if (last || !teil.href) {
        return `<span class="seiten-aktuell"${last ? ' aria-current="page"' : ''}>${label}</span>`
      }
      return `<a class="seiten-eltern" href="${h(teil.href)}" data-route="${h(teil.href)}">${h(teil.label)}</a>`
    })
    .join('<span class="seiten-trenner" aria-hidden="true">/</span>')
  return `<h2 class="seiten-titel">${knoten}</h2>`
}

function seitenKopfHtml({ titelHtml, untertitel = '', meta = '', aktionen = '', extra = '' }) {
  const neben = meta || aktionen
  return `<header class="seiten-kopf">
    <div class="seiten-kopf-text">
      ${titelHtml}
      ${untertitel ? `<p class="seiten-untertitel">${untertitel}</p>` : ''}
      ${extra}
    </div>
    ${neben ? `<div class="seiten-kopf-neben">${aktionen}${meta}</div>` : ''}
  </header>`
}

const THEME_ICON = {
  dark: `<svg class="einst-theme-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M13.2 9.1A5.6 5.6 0 0 1 6.9 2.8 5.7 5.7 0 1 0 13.2 9.1Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>`,
  light: `<svg class="einst-theme-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="2.6" stroke="currentColor" stroke-width="1.4"/><path d="M8 1.75v1.4M8 12.85v1.4M1.75 8h1.4M12.85 8h1.4M3.4 3.4l1 1M11.6 11.6l1 1M12.6 3.4l-1 1M4.4 11.6l-1 1" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`
}

function rendereEinstellungen() {
  const ziel = $('#einstellungen')
  if (!ziel) return
  const draft = zustand.einstellungen.draft
  if (!draft) {
    ziel.innerHTML = `<div class="laden" aria-busy="true">lädt …</div>`
    return
  }

  const dirty = einstellungenDirty()
  zustand.einstellungen.dirty = dirty
  const timeoutSek = Math.round((draft.readyTimeoutMs ?? 60000) / 1000)
  const portHinweis =
    zustand.einstellungen.geladen && draft.hubPort !== zustand.einstellungen.geladen.hubPort
      ? `<p class="einst-warnung" role="status">Port-Änderung wird erst wirksam nach <span class="mono">devhub service install</span>.</p>`
      : ''
  const theme = themeAktuell()
  const rootAnzahl = draft.roots.length
  const offen = einstSektionenOffen()
  const registryMeta = draft.registryFile
    ? `<span class="einst-datei" title="${h(draft.registryFile)}">
        <span class="meta mono">${h(draft.registryFile)}</span>
        <span class="pfad-aktionen">
          <button type="button" class="knopf symbol leise" data-aktion="pfad-oeffnen" data-pfad="${h(draft.registryFile)}" data-ziel="finder" title="Im Finder zeigen" aria-label="Im Finder zeigen">↗</button>
        </span>
      </span>`
    : ''

  const rootsHtml = rootAnzahl
    ? draft.roots
        .map(
          (pfad, i) => `<div class="einst-root">
                  <span class="einst-root-pfad mono" title="${h(pfad)}">${h(pfad)}</span>
                  <button type="button" class="knopf symbol leise" data-einst="root-weg" data-index="${i}" title="Entfernen" aria-label="${h(pfad)} entfernen" ${rootAnzahl <= 1 ? 'disabled' : ''}>×</button>
                </div>`
        )
        .join('')
    : `<p class="einst-leer">Noch keine Wurzel — unten einen Pfad hinzufügen.</p>`

  ziel.innerHTML = `
    ${seitenKopfHtml({
      titelHtml: seitenTitelHtml([{ label: 'Einstellungen' }]),
      untertitel: 'Gilt für diese Maschine — gespeichert in der Registry.',
      meta: registryMeta
    })}

    <form class="einst-form" id="einst-form" novalidate>
      ${einstSektionHtml({
        id: 'oberflaeche',
        titel: 'Oberfläche',
        meta: theme === 'light' ? 'Hell' : 'Dunkel',
        offen: offen.oberflaeche,
        koerper: `<div class="einst-zeile">
          <div class="einst-zeile-text">
            <span class="einst-zeile-name">Farbschema</span>
            <span class="einst-zeile-hilfe">Nur in diesem Browser, ohne Speichern.</span>
          </div>
          <div class="einst-segment" role="group" aria-label="Farbschema">
            <button type="button" class="einst-segment-knopf${theme === 'dark' ? ' aktiv' : ''}" data-einst="theme-set" data-theme="dark" aria-pressed="${theme === 'dark'}">${THEME_ICON.dark}<span>Dunkel</span></button>
            <button type="button" class="einst-segment-knopf${theme === 'light' ? ' aktiv' : ''}" data-einst="theme-set" data-theme="light" aria-pressed="${theme === 'light'}">${THEME_ICON.light}<span>Hell</span></button>
          </div>
        </div>`
      })}

      ${einstSektionHtml({
        id: 'projekte',
        titel: 'Projekt-Wurzeln',
        meta: rootAnzahl === 1 ? '1 Ordner' : `${rootAnzahl} Ordner`,
        offen: offen.projekte,
        koerper: `<div class="einst-feld">
          <div class="einst-roots" id="einst-roots">${rootsHtml}</div>
          <div class="einst-root-neu">
            <input type="text" id="einst-root-input" class="einst-input mono" placeholder="~/Dev oder absoluter Pfad" autocomplete="off" spellcheck="false" aria-label="Neues Wurzelverzeichnis">
            <button type="button" class="knopf" data-einst="root-dazu">Hinzufügen</button>
          </div>
          <span class="einst-hilfe"><kbd>↵</kbd> im Feld fügt den Pfad hinzu. Mindestens eine Wurzel bleibt nötig.</span>
        </div>`
      })}

      ${einstSektionHtml({
        id: 'hub',
        titel: 'Hub &amp; Netzwerk',
        meta: `Port ${h(draft.hubPort)}`,
        offen: offen.hub,
        koerper: `<div class="einst-raster">
          <label class="einst-feld">
            <span class="einst-label">Hub-Port</span>
            <input type="number" name="hubPort" class="einst-input mono" min="1024" max="65535" step="1" value="${h(draft.hubPort)}" required>
            <span class="einst-hilfe">Übersicht: <span class="mono">http://devhub.localhost:${h(draft.hubPort)}</span></span>
          </label>
          <label class="einst-feld">
            <span class="einst-label">Domain-Suffix</span>
            <input type="text" name="domainSuffix" class="einst-input mono" value="${h(draft.domainSuffix)}" required autocomplete="off" spellcheck="false">
            <span class="einst-hilfe">Projekte: <span class="mono">name.${h(draft.domainSuffix)}:…</span></span>
          </label>
        </div>
        ${portHinweis}`
      })}

      ${einstSektionHtml({
        id: 'werkzeuge',
        titel: 'Werkzeuge',
        meta: h(draft.editor || 'Editor'),
        offen: offen.werkzeuge,
        koerper: `<div class="einst-raster">
          <label class="einst-feld">
            <span class="einst-label">Editor-Kommando</span>
            <input type="text" name="editor" class="einst-input mono" list="einst-editor-vorschlaege" value="${h(draft.editor)}" required autocomplete="off" spellcheck="false">
            <datalist id="einst-editor-vorschlaege">
              <option value="cursor"></option>
              <option value="code"></option>
              <option value="zed"></option>
              <option value="subl"></option>
            </datalist>
            <span class="einst-hilfe">Für „Im Editor öffnen“ — muss im PATH liegen.</span>
          </label>
          <label class="einst-feld">
            <span class="einst-label">Bereitschafts-Timeout</span>
            <div class="einst-timeout">
              <input type="number" name="readyTimeoutSek" class="einst-input mono" min="5" max="600" step="1" value="${h(timeoutSek)}" required aria-describedby="einst-timeout-hilfe">
              <span class="einst-timeout-einheit">Sekunden</span>
            </div>
            <span class="einst-hilfe" id="einst-timeout-hilfe">Maximale Wartezeit, bis der Server-Port antwortet.</span>
          </label>
        </div>`
      })}

      ${einstSektionHtml({
        id: 'agenten',
        titel: 'Agenten',
        meta: draft.showGlobalAgentContext ? 'Global an' : 'Nur Projekt',
        offen: offen.agenten,
        koerper: `<label class="einst-schalter">
          <span class="einst-schalter-text">
            <span class="einst-zeile-name">Globale Agent-Dateien zeigen</span>
            <span class="einst-zeile-hilfe">Zusätzlich CLAUDE.md, Cursor-Regeln und Codex-AGENTS aus dem Home-Verzeichnis.</span>
          </span>
          <input type="checkbox" name="showGlobalAgentContext" ${draft.showGlobalAgentContext ? 'checked' : ''}>
          <span class="einst-schalter-ui" aria-hidden="true"></span>
        </label>`
      })}

      <div class="einst-dock">
        <div class="einst-leiste${dirty ? ' dirty' : ''}">
          <div class="einst-leiste-status" aria-live="polite">
            ${
              zustand.einstellungen.hinweis
                ? `<span class="einst-hinweis">${h(zustand.einstellungen.hinweis)}</span>`
                : dirty
                  ? `<span class="einst-dirty">Ungespeicherte Änderungen <kbd class="taste-hint">⌘S</kbd></span>`
                  : `<span class="einst-sauber">Alles gespeichert</span>`
            }
          </div>
          <div class="einst-leiste-aktionen">
            <button type="button" class="knopf leise" data-einst="zuruecksetzen" ${dirty ? '' : 'disabled'}>Zurücksetzen</button>
            <button type="submit" class="knopf primaer" data-einst="speichern" ${dirty && !zustand.einstellungen.speichern ? '' : 'disabled'} title="Speichern (⌘S)">
              ${zustand.einstellungen.speichern ? 'Speichert …' : 'Speichern'}
            </button>
          </div>
        </div>
      </div>
    </form>
  `
  bindeEinstDockScrim()
}

/** Fade nur solange Inhalt unter dem sticky Dock durchscrollt. */
function syncEinstDockScrim() {
  const dock = document.querySelector('.einst-dock')
  const letzteKarte = document.querySelector('.einst-form > .einst-sektion:last-of-type')
  if (!dock || !letzteKarte || zustand.ansicht !== 'einstellungen') return
  const ueberlappt = letzteKarte.getBoundingClientRect().bottom > dock.getBoundingClientRect().top + 1
  dock.classList.toggle('am-ende', !ueberlappt)
}

let einstDockScrimRaf = 0
/** Nach <details>-Toggle ist die Höhe oft erst im übernächsten Frame final. */
function planeEinstDockScrim() {
  if (einstDockScrimRaf) return
  einstDockScrimRaf = requestAnimationFrame(() => {
    syncEinstDockScrim()
    requestAnimationFrame(() => {
      einstDockScrimRaf = 0
      syncEinstDockScrim()
    })
  })
}

let einstFormResizeBeobachter = null
function bindeEinstDockScrim() {
  const form = document.querySelector('#einst-form')
  if (!form) return
  if (typeof ResizeObserver === 'function') {
    if (!einstFormResizeBeobachter) {
      einstFormResizeBeobachter = new ResizeObserver(() => planeEinstDockScrim())
    }
    einstFormResizeBeobachter.disconnect()
    einstFormResizeBeobachter.observe(form)
    for (const sektion of form.querySelectorAll('.einst-sektion')) {
      einstFormResizeBeobachter.observe(sektion)
    }
  }
  planeEinstDockScrim()
}

function einstellungenAusForm(form) {
  const draft = zustand.einstellungen.draft
  if (!draft || !form) return draft
  const hubPort = Number(form.hubPort?.value)
  const domainSuffix = String(form.domainSuffix?.value ?? '').trim()
  const editor = String(form.editor?.value ?? '').trim()
  const readyTimeoutSek = Number(form.readyTimeoutSek?.value)
  return {
    ...draft,
    hubPort,
    domainSuffix,
    editor,
    showGlobalAgentContext: Boolean(form.showGlobalAgentContext?.checked),
    readyTimeoutMs: Math.round(readyTimeoutSek * 1000)
  }
}

function syncEinstellungenDraftAusForm() {
  const form = $('#einst-form')
  if (!form || !zustand.einstellungen.draft) return
  zustand.einstellungen.draft = einstellungenAusForm(form)
  zustand.einstellungen.dirty = einstellungenDirty()
  zustand.einstellungen.hinweis = ''
  const dirty = zustand.einstellungen.dirty
  form.querySelector('.einst-leiste')?.classList.toggle('dirty', dirty)
  const status = form.querySelector('.einst-leiste-status')
  if (status) {
    status.innerHTML = dirty
      ? `<span class="einst-dirty">Ungespeicherte Änderungen <kbd class="taste-hint">⌘S</kbd></span>`
      : `<span class="einst-sauber">Alles gespeichert</span>`
  }
  const speichern = form.querySelector('[data-einst="speichern"]')
  const reset = form.querySelector('[data-einst="zuruecksetzen"]')
  if (speichern) speichern.disabled = !dirty || zustand.einstellungen.speichern
  if (reset) reset.disabled = !dirty
  const portHilfe = form.querySelector('[name="hubPort"]')?.closest('.einst-feld')?.querySelector('.einst-hilfe')
  if (portHilfe) {
    portHilfe.innerHTML = `Übersicht: <span class="mono">http://devhub.localhost:${h(form.hubPort.value)}</span>`
  }
  const suffixHilfe = form.querySelector('[name="domainSuffix"]')?.closest('.einst-feld')?.querySelector('.einst-hilfe')
  if (suffixHilfe) {
    const suffix = h(String(form.domainSuffix.value || 'localhost').trim() || 'localhost')
    suffixHilfe.innerHTML = `Projekte: <span class="mono">name.${suffix}:…</span>`
  }
  const hubMeta = form.querySelector('[data-einst-sektion="hub"] .einst-sektion-meta')
  if (hubMeta) hubMeta.textContent = `Port ${form.hubPort?.value || '—'}`
  const werkMeta = form.querySelector('[data-einst-sektion="werkzeuge"] .einst-sektion-meta')
  if (werkMeta) werkMeta.textContent = String(form.editor?.value || 'Editor').trim() || 'Editor'
  const agentMeta = form.querySelector('[data-einst-sektion="agenten"] .einst-sektion-meta')
  if (agentMeta) {
    agentMeta.textContent = form.showGlobalAgentContext?.checked ? 'Global an' : 'Nur Projekt'
  }
}

async function speichereEinstellungen() {
  const form = $('#einst-form')
  if (!form || !zustand.einstellungen.draft) return
  zustand.einstellungen.draft = einstellungenAusForm(form)
  zustand.einstellungen.speichern = true
  zustand.einstellungen.hinweis = ''
  rendereEinstellungen()
  try {
    const draft = zustand.einstellungen.draft
    const ergebnis = await api('/api/settings', {
      method: 'POST',
      body: JSON.stringify({
        roots: draft.roots,
        hubPort: draft.hubPort,
        domainSuffix: draft.domainSuffix,
        editor: draft.editor,
        showGlobalAgentContext: draft.showGlobalAgentContext,
        readyTimeoutMs: draft.readyTimeoutMs
      })
    })
    zustand.einstellungen.geladen = einstellungenKlon(ergebnis.settings)
    zustand.einstellungen.draft = einstellungenKlon(ergebnis.settings)
    zustand.einstellungen.dirty = false
    zustand.einstellungen.hinweis = ergebnis.warnings?.length
      ? ergebnis.warnings.join(' ')
      : 'Gespeichert'
    zeigeOk(ergebnis.warnings?.length ? ergebnis.warnings[0] : 'Einstellungen gespeichert')
    // Overview neu laden — Footer/Editor-Name können sich ändern.
    await laden({ erzwingen: true })
  } catch (err) {
    zustand.einstellungen.hinweis = err.message
    zeigeFehler(err.message)
  } finally {
    zustand.einstellungen.speichern = false
    if (zustand.ansicht === 'einstellungen') rendereEinstellungen()
  }
}

function editorAnzeigename() {
  const ed = (zustand.daten?.hub?.editor ?? 'cursor').toLowerCase()
  if (ed === 'cursor' || ed.endsWith('/cursor')) return 'Cursor'
  if (ed === 'code' || ed === 'code-insiders' || ed.endsWith('/code')) return 'VS Code'
  if (ed === 'zed' || ed.endsWith('/zed')) return 'Zed'
  if (ed === 'subl' || ed.includes('sublime')) return 'Sublime'
  return 'Editor'
}

/**
 * Kompakte Extern-Aktionen für angezeigte Pfade.
 * `kompakt`: nur Icons (Listen); sonst beschriftete Knöpfe (Dialog/Kopf).
 */
function pfadAktionenHtml(pfad, { kompakt = false, schliessen = false } = {}) {
  if (!pfad) return ''
  const editor = editorAnzeigename()
  if (kompakt) {
    return `<span class="pfad-aktionen">
      <button type="button" class="knopf symbol leise" data-aktion="pfad-oeffnen" data-pfad="${h(pfad)}" data-ziel="editor" title="In ${h(editor)} öffnen" aria-label="In ${h(editor)} öffnen">${iconExtern}</button>
      <button type="button" class="knopf symbol leise" data-aktion="pfad-oeffnen" data-pfad="${h(pfad)}" data-ziel="finder" title="Im Finder zeigen" aria-label="Im Finder zeigen">${iconFinder}</button>
    </span>`
  }
  return `<div class="pfad-aktionen fest">
    <button type="button" class="knopf leise" data-aktion="pfad-oeffnen" data-pfad="${h(pfad)}" data-ziel="editor" title="In ${h(editor)} öffnen">In ${h(editor)}</button>
    <button type="button" class="knopf leise" data-aktion="pfad-oeffnen" data-pfad="${h(pfad)}" data-ziel="finder" title="Im Finder zeigen">Finder</button>
    ${
      schliessen
        ? `<button type="button" class="knopf leise" data-aktion="datei-schliessen" aria-label="Schließen">Schließen</button>`
        : ''
    }
  </div>`
}

async function oeffnePfad(pfad, { finder = false } = {}) {
  if (!pfad) return
  await api('/api/open', {
    method: 'POST',
    body: JSON.stringify({ path: pfad, finder: Boolean(finder) })
  })
}

/** Schicker Ersatz für window.confirm — inkl. Opt-in für Abhängigkeiten. */
async function frageSlotEntfernen(projektName) {
  const dlg = $('#bestaetigung')
  const clean = $('#bestaetigung-clean')
  const hint = $('#bestaetigung-clean-hint')
  const option = $('#bestaetigung-option')

  $('#bestaetigung-titel').textContent = `Slot von „${projektName}“ entfernen?`
  $('#bestaetigung-text').textContent = 'Der Slot bleibt gesperrt und wird nicht neu vergeben.'
  $('#bestaetigung-liste').innerHTML = [
    'Lokale Dateien (Cursor-Regel, launch.json) werden entfernt; ein alter AGENTS.md-Block ebenfalls',
    'Der Dev-Server wird weder gestartet noch gestoppt'
  ]
    .map((t) => `<li>${h(t)}</li>`)
    .join('')

  clean.checked = false
  option.hidden = false
  // Größe vor dem Öffnen laden — sonst springt der Dialog, wenn der Hint nachzieht.
  hint.textContent = 'node_modules, .next und ähnliche Caches'
  try {
    const daten = await api(`/api/projects/${encodeURIComponent(projektName)}/artifacts`)
    if (!daten.items?.length) {
      hint.textContent = 'Keine node_modules/.next o. Ä. gefunden — Option ändert nichts'
    } else {
      const namen = [...new Set(daten.items.map((i) => i.name))].join(', ')
      hint.textContent = `${speicherBytes(daten.bytes)} in ${daten.items.length} Ordner${daten.items.length === 1 ? '' : 'n'} (${namen})`
    }
  } catch {
    hint.textContent = 'node_modules, .next und ähnliche Caches'
  }

  return new Promise((resolve) => {
    const fertig = () => {
      dlg.removeEventListener('close', fertig)
      if (dlg.returnValue === 'ok') resolve({ ok: true, cleanDeps: clean.checked })
      else resolve({ ok: false, cleanDeps: false })
    }
    dlg.addEventListener('close', fertig)
    if (typeof dlg.showModal === 'function') dlg.showModal()
    else dlg.setAttribute('open', '')
    $('#bestaetigung-ok')?.focus({ preventScroll: true })
  })
}

/** Ersatz für window.prompt — null bei Abbrechen, sonst der (ggf. leere) Text. */
function frageEingabe({
  titel,
  text = '',
  label = 'Wert',
  hinweis = '',
  wert = '',
  placeholder = '',
  okLabel = 'Speichern'
} = {}) {
  const dlg = $('#eingabe')
  const feld = $('#eingabe-wert')
  const textEl = $('#eingabe-text')
  const hintEl = $('#eingabe-hint')

  $('#eingabe-titel').textContent = titel
  $('#eingabe-label').textContent = label
  $('#eingabe-ok').textContent = okLabel

  if (text) {
    textEl.hidden = false
    textEl.textContent = text
  } else {
    textEl.hidden = true
    textEl.textContent = ''
  }

  if (hinweis) {
    hintEl.hidden = false
    hintEl.textContent = hinweis
  } else {
    hintEl.hidden = true
    hintEl.textContent = ''
  }

  feld.value = wert ?? ''
  feld.placeholder = placeholder

  return new Promise((resolve) => {
    const fertig = () => {
      dlg.removeEventListener('close', fertig)
      if (dlg.returnValue === 'ok') resolve(feld.value)
      else resolve(null)
    }
    dlg.addEventListener('close', fertig)
    if (typeof dlg.showModal === 'function') dlg.showModal()
    else dlg.setAttribute('open', '')
    requestAnimationFrame(() => {
      feld.focus()
      feld.select()
    })
  })
}

async function handle(knopf, arbeit) {
  if (knopf) {
    knopf.disabled = true
    knopf.setAttribute('aria-busy', 'true')
    knopf.classList.add('busy')
  }
  try {
    const ergebnis = await arbeit()
    if (ergebnis?.warnings?.length) zeigeFehler(ergebnis.warnings.join(' · '))
    // Nach Aktion immer frisch holen — auch wenn gerade ein Poll läuft.
    await laden({ erzwingen: true })
  } catch (err) {
    zeigeFehler(err.message)
  } finally {
    if (knopf) {
      knopf.disabled = false
      knopf.removeAttribute('aria-busy')
      knopf.classList.remove('busy')
    }
  }
}

// ------------------------------------------------------------------ Format

/** Laufzeit wie in der CLI — reine Maßzahl, damit sie neben MB sinnvoll wirkt. */
const dauer = (iso) => {
  if (!iso) return '—'
  const ms = Date.now() - new Date(iso)
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s} s`
  const min = Math.floor(s / 60)
  if (min < 60) return `${min} min`
  const std = Math.floor(min / 60)
  if (std < 24) return min % 60 ? `${std} h ${min % 60} min` : `${std} h`
  return `${Math.floor(std / 24)} d`
}

const speicher = (n) => {
  if (!n) return ''
  const mb = n / (1024 * 1024)
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`
}

function speicherSummeVon(profil) {
  return (profil.processes ?? []).reduce((s, p) => s + (p.memory ?? 0), 0)
}

/** Zustandstext für laufende Zeilen — Laufzeit und RAM als zwei Maßzahlen. */
function metaLaufend(profil) {
  return [dauer(profil.startedAt), speicher(speicherSummeVon(profil))].filter(Boolean).join(' · ')
}

const punktKlasse = (state) =>
  state === 'läuft' ? 'punkt laeuft' : state === 'teilweise' ? 'punkt warnung' : 'punkt'

// ------------------------------------------------------------------ Übersicht

function anzeigeName(projekt) {
  return projekt.displayName || projekt.title || projekt.name
}

function githubHtml(projekt, { kurz = false } = {}) {
  const gh = projekt.github
  if (!gh?.url) return ''
  const text = kurz ? 'GitHub' : h(gh.label)
  return `<a class="github" href="${h(gh.url)}" target="_blank" rel="noreferrer" title="${h(gh.url)}">${text}</a>`
}

function nameHtml(projekt, extraSub = '', { title } = {}) {
  const titel = anzeigeName(projekt)
  const ordnerGleich = slugGleich(titel, projekt.name)
  const ordner = ordnerGleich
    ? ''
    : `<span class="sub" title="${h(projekt.name)}">${h(projekt.name)}</span>`
  const titleAttr = title
    ? ` title="${h(title)}"`
    : ` title="${h(ordnerGleich ? projekt.path : `${titel} · ${projekt.name}`)}"`
  return `<span class="name">
    <span class="name-text">
      <a data-aktion="detail" data-projekt="${h(projekt.name)}"${titleAttr}>${h(titel)}</a>
      ${ordner}${extraSub}
    </span>
  </span>`
}

/** „KI-Duell“ und Ordner ki-duell sind dieselbe Identität — Ordner nicht nochmal zeigen. */
function slugGleich(a, b) {
  const norm = (s) =>
    String(s)
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '')
  return Boolean(a && b && norm(a) === norm(b))
}

function listeKopfHtml() {
  return `<div class="liste-kopf" aria-hidden="true">
    <span></span>
    <span></span>
    <span>Projekt</span>
    <span>Adresse</span>
    <span>Zustand</span>
    <span></span>
  </div>`
}

const iconPlay = `<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.2 2.6a.75.75 0 0 0-1.15.63v9.54a.75.75 0 0 0 1.15.63l7.7-4.77a.75.75 0 0 0 0-1.26L4.2 2.6Z"/></svg>`
const iconStop = `<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="3.5" width="9" height="9" rx="1.5"/></svg>`
const iconPlus = `<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.25a.75.75 0 0 1 .75.75v3.25H12a.75.75 0 0 1 0 1.5H8.75V12a.75.75 0 0 1-1.5 0V8.75H4a.75.75 0 0 1 0-1.5h3.25V4A.75.75 0 0 1 8 3.25Z"/></svg>`
const iconExtern = `<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M6.5 3.25H3.75A1.5 1.5 0 0 0 2.25 4.75v7.5a1.5 1.5 0 0 0 1.5 1.5h7.5a1.5 1.5 0 0 0 1.5-1.5V9.5a.75.75 0 0 0-1.5 0v2.75h-7.5V4.75H6.5a.75.75 0 0 0 0-1.5Z"/><path d="M9.25 2.25h4.5a.75.75 0 0 1 .75.75v4.5a.75.75 0 0 1-1.5 0V4.56L9.28 8.28a.75.75 0 1 1-1.06-1.06l3.72-3.72H9.25a.75.75 0 0 1 0-1.5Z"/></svg>`
const iconFinder = `<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.75 3.5A1.75 1.75 0 0 1 4.5 1.75h2.38c.36 0 .7.14.95.39l1.03 1.03c.1.1.23.15.37.15h2.27A1.75 1.75 0 0 1 13.25 5.07v7.18A1.75 1.75 0 0 1 11.5 14H4.5A1.75 1.75 0 0 1 2.75 12.25V3.5Zm1.5 0v8.75h7.25V5.07H8.78a1.75 1.75 0 0 1-1.24-.51L6.51 3.5H4.25Z"/></svg>`

/** Primäre Power-Aktion links am Status — Start/Stop als Symbol, Slot als Plus. */
function powerKnopfHtml(projekt, profil) {
  if (!projekt.adopted) {
    return `<button type="button" class="knopf symbol aufnehmen" data-aktion="aufnehmen" data-projekt="${h(projekt.name)}" title="Slot vergeben und Agent-Dateien schreiben" aria-label="Slot für ${h(projekt.name)} vergeben">${iconPlus}</button>`
  }
  const laeuft = profil.state === 'läuft' || profil.state === 'teilweise'
  if (laeuft) {
    return `<button type="button" class="knopf symbol stopp" data-aktion="stopp" data-projekt="${h(projekt.name)}" data-profil="${h(profil.profile)}" title="Stoppen" aria-label="${h(anzeigeName(projekt))} stoppen">${iconStop}</button>`
  }
  return `<button type="button" class="knopf symbol start" data-aktion="start" data-projekt="${h(projekt.name)}" data-profil="${h(profil.profile)}" title="Starten" aria-label="${h(anzeigeName(projekt))} starten">${iconPlay}</button>`
}


function aktionenMenu(gruppen) {
  const bloecke = (Array.isArray(gruppen[0]) ? gruppen : [gruppen])
    .map((gruppe) => gruppe.filter(Boolean))
    .filter((gruppe) => gruppe.length)
  if (!bloecke.length) return ''
  const inhalt = bloecke
    .map((gruppe) => `<div class="menu-gruppe" role="group">${gruppe.join('')}</div>`)
    .join('<div class="menu-trenner" role="separator"></div>')
  return `<details class="menu">
    <summary class="knopf leise menu-knopf" aria-label="Weitere Aktionen">⋯</summary>
    <div class="menu-liste" role="menu">${inhalt}</div>
  </details>`
}

function menuKnopf(label, attrs, { gefahr = false } = {}) {
  const data = Object.entries(attrs)
    .map(([k, v]) => `data-${k}="${h(v)}"`)
    .join(' ')
  return `<button type="button" class="menu-eintrag${gefahr ? ' gefahr' : ''}" role="menuitem" ${data}>${h(label)}</button>`
}

function menuLink(label, href, title = '') {
  return `<a class="menu-eintrag" role="menuitem" href="${h(href)}" target="_blank" rel="noreferrer" title="${h(title || href)}">${h(label)}</a>`
}

/** Einstiegs-URLs aus `paths` in der Spec — Basis-URL + Pfad, Label optional. */
function einstiegeVon(proc) {
  if (!proc?.url || !proc.paths?.length) return []
  const basis = proc.url.replace(/\/$/, '')
  return proc.paths
    .map((p) => {
      const pfad = typeof p === 'string' ? p : p?.path ?? p?.pfad
      if (!pfad) return null
      const label = (typeof p === 'object' && (p.label ?? p.name)) || pfad
      return {
        label,
        path: pfad,
        href: `${basis}/${String(pfad).replace(/^\//, '')}`
      }
    })
    .filter(Boolean)
}

function einstiegeHtml(proc, { listening = true, klasse = 'einstieg' } = {}) {
  const einstiege = einstiegeVon(proc)
  if (!einstiege.length) return ''
  return `<div class="einstiegspfade">${einstiege
    .map(
      (e) =>
        `<a class="${klasse}${listening ? '' : ' aus'}" href="${h(e.href)}" target="_blank" rel="noreferrer" title="${h(e.href)}">${h(e.label)}</a>`
    )
    .join('')}</div>`
}

function zeilenMenu(projekt, { profil, mitLog = false, mitNeu = false, mitAnsehen = false } = {}) {
  const ort = [menuKnopf('Im Finder zeigen', { aktion: 'finder', projekt: projekt.name })]
  if (projekt.github?.url) {
    ort.push(menuLink('Auf GitHub öffnen', projekt.github.url, projekt.github.label))
  }

  const server = []
  if (mitLog && profil) {
    server.push(
      menuKnopf('Log anzeigen', {
        aktion: 'log',
        projekt: projekt.name,
        profil: profil.profile
      })
    )
  }
  if (mitNeu && profil) {
    server.push(
      menuKnopf('Neu starten', {
        aktion: 'neu',
        projekt: projekt.name,
        profil: profil.profile
      })
    )
  }

  const einstiege = []
  if (profil) {
    for (const proc of profil.processes) {
      for (const e of einstiegeVon(proc)) {
        einstiege.push(menuLink(e.label, e.href))
      }
    }
  }

  const mehr = []
  if (mitAnsehen) {
    mehr.push(menuKnopf('Details ansehen', { aktion: 'detail', projekt: projekt.name }))
  }

  return aktionenMenu([ort, einstiege, server, mehr])
}

function zeileHtml(projekt, profil) {
  const laeuft = profil.state === 'läuft' || profil.state === 'teilweise'
  const haupt =
    profil.processes.find((p) => p.role === 'frontend') ?? profil.processes[0]
  const adresse = haupt?.url
  const einstiege = haupt ? einstiegeVon(haupt) : []
  const konflikt = profil.processes.some((p) => p.foreign)

  const zustandText = laeuft
    ? metaLaufend(profil)
    : projekt.adopted
      ? 'gestoppt'
      : 'kein Slot'

  const menu = zeilenMenu(projekt, {
    profil,
    mitLog: projekt.adopted,
    mitNeu: laeuft,
    mitAnsehen: true
  })

  const art = projekt.stack?.framework ?? projekt.stack?.kind
  const nameTitel = [art, profil.profile !== 'default' ? `Profil ${profil.profile}` : '']
    .filter(Boolean)
    .join(' · ')

  const hinweis = konflikt
    ? `<span class="hinweis">Ein fremder Prozess belegt ${h(profil.processes.filter((p) => p.foreign).map((p) => p.port).join(', '))} — der Hub hat ihn nicht gestartet.</span>`
    : ''

  // Mit Einstiegen: Labels als Adresse (klickbar), Basis nur als Tooltip.
  // Sonst weiter die Host:Port-URL wie bisher.
  const adrHtml = einstiege.length
    ? `<span class="adr-zelle${laeuft ? '' : ' aus'}">${einstiege
        .map(
          (e) =>
            `<a class="einstieg${laeuft ? '' : ' aus'}" href="${h(e.href)}" target="_blank" rel="noreferrer" title="${h(e.href)}">${h(e.label)}</a>`
        )
        .join('<span class="adr-trenner" aria-hidden="true">·</span>')}</span>`
    : adresse
      ? `<a class="adr${laeuft ? '' : ' aus'}" href="${h(adresse)}" target="_blank" rel="noreferrer">${h(adresse.replace(/^https?:\/\//, ''))}</a>`
      : '<span class="adr aus">—</span>'

  return `<div class="zeile${konflikt ? ' warnung' : ''}" data-projekt="${h(projekt.name)}" data-profil="${h(profil.profile)}">
    <span class="${konflikt ? 'punkt warnung' : punktKlasse(profil.state)}"></span>
    <span class="power">${powerKnopfHtml(projekt, profil)}</span>
    ${nameHtml(projekt, '', { title: nameTitel || undefined })}
    ${adrHtml}
    <span class="meta">${h(zustandText)}</span>
    <span class="aktionen">${menu}</span>
    ${hinweis}
  </div>`
}

function ohneStartHtml(projekt) {
  const hinweis = projekt.problems[0] ?? 'Kein Server erkennbar'
  const kurz =
    /Sammelordner/.test(hinweis) ? 'Sammelordner'
    : /liegt in /.test(hinweis) ? 'Unterordner'
    : /Kein venv/.test(hinweis) ? 'braucht venv'
    : /Python/.test(hinweis) ? 'braucht Einstieg'
    : /Kein Server/.test(hinweis) ? 'kein Server'
    : 'kein Start'
  const art = projekt.stack?.framework ?? projekt.stack?.kind
  // Kein Power-Knopf: hier lässt sich kein Slot vergeben — Name öffnet weiter Details.
  return `<div class="zeile" title="${h(hinweis)}">
    <span class="punkt"></span>
    <span class="power" aria-hidden="true"></span>
    ${nameHtml(projekt, '', { title: art ? `${art} · ${hinweis}` : hinweis })}
    <span class="adr aus">—</span>
    <span class="meta">${h(kurz)}</span>
    <span class="aktionen">${zeilenMenu(projekt, { mitAnsehen: true })}</span>
  </div>`
}

function rendereKopfMeta() {
  const stop = $('#alle-stoppen')
  if (!stop) return
  const laufen = zustand.daten?.summary?.running ?? 0
  // Nur zeigen, wenn die Aktion Sinn hat — sonst nur Lärm im Kopf.
  stop.hidden = laufen === 0
  stop.disabled = laufen === 0
  stop.title =
    laufen === 0
      ? 'Kein Server läuft'
      : `${laufen} laufende${laufen === 1 ? 'n' : ''} Server stoppen`
}

function rendereFuss() {
  const fuss = $('#fuss')
  const daten = zustand.daten
  if (!fuss || !daten) return

  rendereKopfMeta()
  const s = daten.summary
  const teil = (html, warn = false) =>
    `<span class="fuss-teil${warn ? ' warn' : ''}">${html}</span>`
  const sep = '<span class="fuss-sep" aria-hidden="true">·</span>'

  fuss.innerHTML = [
    teil(`<span class="fuss-host" title="Hub-Adresse">${h(location.host)}</span>`),
    teil(`<b>${s.total}</b> Projekte`),
    teil(`<b>${s.adopted}</b> mit Slot`),
    teil(`<b>${s.running}</b> laufen`),
    s.memory ? teil(`<b>${speicher(s.memory)}</b>`) : '',
    s.conflicts
      ? teil(`<b>${s.conflicts}</b> Konflikt${s.conflicts === 1 ? '' : 'e'}`, true)
      : '',
    teil(
      `launchd <b>${daten.hub.service.loaded ? 'aktiv' : 'aus'}</b>`,
      !daten.hub.service.loaded
    )
  ]
    .filter(Boolean)
    .join(sep)
}

function gruppenOffenMerken() {
  const open = { ...zustand.gruppenOffen }
  for (const el of document.querySelectorAll('#kandidaten details.kandidaten[data-gruppe]')) {
    open[el.dataset.gruppe] = el.open
  }
  zustand.gruppenOffen = open
}

function listeGruppe(titel, zeilen) {
  if (!zeilen.length) return ''
  return `<div class="gruppe">
    <span class="gruppe-titel">${h(titel)}</span>
    <span class="gruppe-meta"><span class="anzahl">${zeilen.length}</span></span>
  </div>${zeilen.join('')}`
}

/** Getrennt von der Hauptliste: zugeklappt. Ohne Server unten als eigene Gruppe. */
function kandidatenAufklappHtml(kandidaten, ohneStart = []) {
  if (!kandidaten.length && !ohneStart.length) return ''

  let offen = zustand.gruppenOffen['kein-port']
  if (offen === undefined) offen = false

  const n = kandidaten.length + ohneStart.length
  const zu =
    n === 1 ? '1 Projekt ohne Slot anzeigen' : `${n} Projekte ohne Slot anzeigen`

  return `<details class="kandidaten" data-gruppe="kein-port"${offen ? ' open' : ''}>
    <summary>
      <span class="kandidaten-label kandidaten-zu">${h(zu)}</span>
      <span class="kandidaten-label kandidaten-auf">Ausblenden</span>
      <span class="gruppe-chevron" aria-hidden="true"></span>
    </summary>
    <div class="liste kandidaten-liste">
      ${listeKopfHtml()}
      ${kandidaten.join('')}
      ${listeGruppe('Ohne Server', ohneStart)}
    </div>
  </details>`
}

function rendereUebersicht() {
  const daten = zustand.daten
  if (!daten) return

  gruppenOffenMerken()
  rendereFuss()

  const laufend = []
  const gestoppt = []
  const kandidaten = []
  const ohneStart = []

  for (const projekt of daten.projects) {
    // Kein Startkommando: in der aufklappbaren Liste unter „Ohne Server“.
    if (!projekt.profiles.length) {
      ohneStart.push(ohneStartHtml(projekt))
      continue
    }
    for (const profil of projekt.profiles) {
      const html = zeileHtml(projekt, profil)
      if (!projekt.adopted) kandidaten.push(html)
      else if (profil.state === 'läuft' || profil.state === 'teilweise') laufend.push(html)
      else gestoppt.push(html)
    }
  }

  const kandidatenEl = $('#kandidaten')
  const haupt = []
  if (laufend.length) haupt.push(listeGruppe('Läuft', laufend))
  if (gestoppt.length) haupt.push(listeGruppe('Gestoppt', gestoppt))

  if (haupt.length) {
    $('#liste').innerHTML = listeKopfHtml() + haupt.join('')
  } else if (kandidaten.length || ohneStart.length) {
    $('#liste').innerHTML =
      listeKopfHtml() +
      `<div class="liste-intro">
        <strong>Noch keine Projekte mit Slot</strong>
        <p>Nimm ein Projekt auf, damit es hier mit festem Port erscheint. Kandidaten findest du darunter — oder öffne die Befehlspalette mit ⌘K.</p>
      </div>`
  } else {
    $('#liste').innerHTML = listeKopfHtml() + leerHtml()
  }

  if (kandidatenEl) {
    kandidatenEl.innerHTML = kandidatenAufklappHtml(kandidaten, ohneStart)
  }
}

function leerHtml() {
  return `<div class="leer-box"><strong>Keine Projekte gefunden</strong><p>Unter den konfigurierten Wurzeln wurden keine Kandidaten gefunden. Prüfe die Projekt-Wurzeln in den Einstellungen.</p></div>`
}

// ------------------------------------------------------------------ Detail

function detailPanelsMerken() {
  const open = { ...zustand.detailPanels }
  for (const el of document.querySelectorAll('#detail details.enthüllung[data-panel]')) {
    open[el.dataset.panel] = el.open
  }
  zustand.detailPanels = open
}

function detailPanelsWiederherstellen() {
  for (const [panel, offen] of Object.entries(zustand.detailPanels ?? {})) {
    const el = document.querySelector(`#detail details.enthüllung[data-panel="${CSS.escape(panel)}"]`)
    if (el) el.open = Boolean(offen)
  }
}

function detailMenu(projekt, profil) {
  const ort = [
    menuKnopf('Im Finder zeigen', { aktion: 'finder', projekt: projekt.name }),
    menuKnopf('Im Editor öffnen', { aktion: 'editor', projekt: projekt.name })
  ]
  if (projekt.github?.url) {
    ort.push(menuLink('Auf GitHub öffnen', projekt.github.url, projekt.github.label))
  }

  const verwaltung = [menuKnopf('Anzeigename ändern', { aktion: 'anzeigename', projekt: projekt.name })]
  if (projekt.adopted) {
    verwaltung.push(
      menuKnopf('Agent-Dateien syncen', { aktion: 'sync-projekt', projekt: projekt.name })
    )
    if (profil) {
      verwaltung.push(
        menuKnopf('Neu starten', {
          aktion: 'neu',
          projekt: projekt.name,
          profil: profil.profile
        })
      )
    }
  }

  const gefahr = projekt.adopted
    ? [menuKnopf('Slot entfernen…', { aktion: 'vergessen', projekt: projekt.name }, { gefahr: true })]
    : []

  return aktionenMenu([ort, verwaltung, gefahr])
}

function primaerAktionHtml(projekt, profil) {
  // Detailansicht: Text bleibt lesbarer als reine Symbole.
  if (!projekt.adopted) {
    return `<button class="knopf primaer" data-aktion="aufnehmen" data-projekt="${h(projekt.name)}" title="Vergibt einen festen Port und schreibt die Agent-Dateien">Slot vergeben</button>`
  }
  if (profil.state === 'läuft' || profil.state === 'teilweise') {
    return `<button class="knopf gefahr fest" data-aktion="stopp" data-projekt="${h(projekt.name)}" data-profil="${h(profil.profile)}">Stoppen</button>`
  }
  return `<button class="knopf primaer" data-aktion="start" data-projekt="${h(projekt.name)}" data-profil="${h(profil.profile)}">Starten</button>`
}

function zustandLabel(profil) {
  if (profil.state === 'läuft') return dauer(profil.startedAt)
  if (profil.state === 'teilweise') return 'teilweise · ' + dauer(profil.startedAt)
  return profil.state === 'gestoppt' ? 'gestoppt' : profil.state
}

function prozessHtml(projekt, profil, proc) {
  const meta = [
    proc.port != null ? `Port ${proc.port}` : null,
    proc.pid ? `PID ${proc.pid}` : proc.runner === 'compose' ? 'compose' : null,
    proc.memory ? speicher(proc.memory) : null
  ].filter(Boolean)
  const einstiege = einstiegeVon(proc)

  return `<div class="prozess" data-prozess="${h(proc.name)}">
    <span class="${proc.listening ? 'punkt laeuft' : 'punkt'}" aria-hidden="true"></span>
    <div class="prozess-haupt">
      <div class="prozess-zeile">
        <span class="pname">${h(proc.name)}</span>
        <span class="prozess-rolle">${h(proc.role)}</span>
      </div>
      ${
        proc.url
          ? `<a class="adr${proc.listening ? '' : ' aus'}" href="${h(proc.url)}" target="_blank" rel="noreferrer">${h(proc.url.replace(/^https?:\/\//, ''))}</a>`
          : '<span class="adr aus">keine Adresse</span>'
      }
      ${meta.length ? `<span class="meta">${h(meta.join(' · '))}</span>` : ''}
      ${einstiegeHtml(proc, { listening: proc.listening })}
    </div>
    <span class="aktionen">
      ${
        einstiege.length && proc.listening
          ? einstiege
              .map((e) => `<a class="knopf leise" href="${h(e.href)}" target="_blank" rel="noreferrer">${h(e.label)}</a>`)
              .join('')
          : proc.url && proc.listening
            ? `<a class="knopf leise" href="${h(proc.url)}" target="_blank" rel="noreferrer">Öffnen</a>`
            : ''
      }
      <button class="knopf leise" data-aktion="log" data-projekt="${h(projekt.name)}" data-profil="${h(profil.profile)}" data-prozess="${h(proc.name)}">Log</button>
    </span>
  </div>`
}

function profilKarteHtml(projekt, profil, { haupt = false } = {}) {
  const titel =
    projekt.profiles.length === 1 && profil.profile === 'default'
      ? 'Server'
      : `Profil ${profil.profile}`

  return `<section class="karte server-karte${haupt ? ' haupt' : ''}" data-profil="${h(profil.profile)}">
    <div class="karte-kopf">
      <div class="server-status">
        <span class="${punktKlasse(profil.state)}" aria-hidden="true"></span>
        <h3>${h(titel)}</h3>
        <span class="sub meta-laufzeit">${h(zustandLabel(profil))}</span>
      </div>
      ${
        haupt
          ? ''
          : `<span class="aktionen">${primaerAktionHtml(projekt, profil)}${
              projekt.adopted
                ? `<button class="knopf leise" data-aktion="neu" data-projekt="${h(projekt.name)}" data-profil="${h(profil.profile)}">Neu</button>`
                : ''
            }</span>`
      }
    </div>
    ${
      profil.processes.length
        ? profil.processes.map((proc) => prozessHtml(projekt, profil, proc)).join('')
        : '<div class="leer">Kein Prozess in diesem Profil.</div>'
    }
  </section>`
}

function problemeHtml(projekt) {
  if (!projekt.problems.length) return ''
  return `<aside class="hinweis-band" role="status">
    <strong>Hinweise</strong>
    <ul>${projekt.problems.map((p) => `<li>${h(p)}</li>`).join('')}</ul>
  </aside>`
}

function enthüllungHtml(panel, zusammenfassung, inhalt, { offen = false } = {}) {
  const isOpen = zustand.detailPanels[panel] ?? offen
  return `<details class="enthüllung" data-panel="${h(panel)}"${isOpen ? ' open' : ''}>
    <summary>
      <span class="enthüllung-titel">${h(zusammenfassung.titel)}</span>
      <span class="enthüllung-meta">${h(zusammenfassung.meta)}</span>
    </summary>
    <div class="enthüllung-koerper">${inhalt}</div>
  </details>`
}

function agentenZeileHtml(eintrag) {
  const groesse = eintrag.directory
    ? `${eintrag.entries} Einträge`
    : `${Math.max(1, Math.round(eintrag.size / 1024))} kB`
  return `<div class="agent-zeile">
    <span class="abzeichen" data-agent="${h(eintrag.agent)}">${h(eintrag.agent)}</span>
    <button class="pfad-zelle" data-aktion="agent-datei" data-pfad="${h(eintrag.path)}" title="Vorschau">${h(eintrag.label)}${eintrag.directory ? '/' : ''}</button>
    <span class="meta">${h(groesse)} · ${h(eintrag.kind)}</span>
    ${pfadAktionenHtml(eintrag.path, { kompakt: true })}
  </div>`
}

function verknuepfungHtml(link) {
  if (!link) return ''
  const anzeige = LINK_ZUSTAND[link.state] ?? LINK_ZUSTAND.keine
  const knopf = link.safe
    ? `<button class="knopf" data-aktion="verknuepfen" data-projekt="${h(zustand.projekt)}">Verknüpfen</button>`
    : ''
  return `<div class="verknuepfung">
    <span class="${anzeige.punkt}" aria-hidden="true"></span>
    <div class="verknuepfung-text">
      <strong>${h(anzeige.titel)}</strong>
      <span>${h(link.message)}</span>
    </div>
    ${knopf}
  </div>`
}

function agentenHtml() {
  const kontext = zustand.agenten
  if (!kontext) {
    return enthüllungHtml('agenten', { titel: 'Agent-Kontext', meta: 'lädt …' }, '<div class="laden">lädt …</div>')
  }

  const anzahl = kontext.repo.length + kontext.global.length
  const metaTeile = [`${anzahl} Datei${anzahl === 1 ? '' : 'en'}`]
  if (kontext.link) {
    metaTeile.push(LINK_ZUSTAND[kontext.link.state]?.titel ?? kontext.link.state)
  }
  if (kontext.gaps.length) {
    metaTeile.push(`${kontext.gaps.length} Lücke${kontext.gaps.length === 1 ? '' : 'n'}`)
  }

  const luecken = kontext.gaps
    .map((g) => `<div class="luecke">${h(g.path)} fehlt — ${h(g.hint)}</div>`)
    .join('')

  const inhalt = `
    ${verknuepfungHtml(kontext.link)}
    <div class="agent-block">
      <h4>Im Projekt</h4>
      ${kontext.repo.map(agentenZeileHtml).join('') || '<div class="leer kompakt">Keine Agent-Dateien im Projekt.</div>'}
      ${luecken}
    </div>
    <div class="agent-block">
      <h4>Global <span class="sub">zusätzlich, unabhängig vom Projekt</span></h4>
      ${kontext.global.map(agentenZeileHtml).join('') || '<div class="leer kompakt">Keine globalen Agent-Dateien.</div>'}
    </div>
  `

  return enthüllungHtml('agenten', { titel: 'Agent-Kontext', meta: metaTeile.join(' · ') }, inhalt)
}

const LINK_ZUSTAND = {
  verknüpft: { punkt: 'punkt laeuft', titel: 'AGENTS.md und CLAUDE.md sind verknüpft' },
  'nur-eine': { punkt: 'punkt warnung', titel: 'Nur eine der beiden Dateien vorhanden' },
  gleich: { punkt: 'punkt warnung', titel: 'Zwei identische Kopien' },
  verschieden: { punkt: 'punkt warnung', titel: 'Zwei verschiedene Dateien' },
  kaputt: { punkt: 'punkt warnung', titel: 'Verweis zeigt ins Leere' },
  keine: { punkt: 'punkt', titel: 'Keine Regeldatei vorhanden' }
}

function startKonfigHtml(projekt) {
  const prozesse = projekt.profiles.reduce((n, p) => n + p.processes.length, 0)
  const inhalt = `<pre class="quelle">${h(
    projekt.profiles
      .map(
        (profil) =>
          `${profil.profile}:\n${profil.processes
            .map((p) => `  ${p.name} (${p.role}) → ${p.port ?? '—'} · ${p.runner}`)
            .join('\n')}`
      )
      .join('\n')
  )}</pre>`
  return enthüllungHtml(
    'start',
    {
      titel: 'Startkonfiguration',
      meta: `Quelle: ${projekt.source} · ${prozesse} Prozess${prozesse === 1 ? '' : 'e'}`
    },
    inhalt
  )
}

function rendereDetail() {
  const projekt = zustand.daten?.projects.find((p) => p.name === zustand.projekt)
  if (!projekt) return

  detailPanelsMerken()

  const titel = anzeigeName(projekt)
  const hauptProfil = projekt.profiles[0]
  const metaChips = [
    projekt.adopted
      ? `<span class="marke-typ">Slot ${projekt.slot}${Object.entries(projekt.profileSlots ?? {})
          .map(([p, s]) => ` · ${p} ${s}`)
          .join('')}</span>`
      : '<span class="marke-typ">kein Slot</span>',
    githubHtml(projekt, { kurz: true })
  ]
    .filter(Boolean)
    .join('')

  const kopf = seitenKopfHtml({
    titelHtml: seitenTitelHtml([
      { label: 'Übersicht', href: '/' },
      {
        label: titel,
        sub: titel === projekt.name ? null : projekt.name
      }
    ]),
    extra: `<div class="detail-meta">
      <span class="pfad" title="${h(projekt.path)}">${h(projekt.path)}</span>
      ${metaChips}
    </div>`,
    aktionen: `${hauptProfil ? primaerAktionHtml(projekt, hauptProfil) : ''}${detailMenu(projekt, hauptProfil)}`
  })

  const weitereProfile = projekt.profiles
    .slice(1)
    .map((profil) => profilKarteHtml(projekt, profil))
    .join('')

  const server =
    (hauptProfil ? profilKarteHtml(projekt, hauptProfil, { haupt: true }) : '') + weitereProfile

  $('#detail').innerHTML =
    kopf + problemeHtml(projekt) + server + agentenHtml() + startKonfigHtml(projekt)

  detailPanelsWiederherstellen()
}

function dateiDialog() {
  return $('#datei')
}

function schliesseDateiVorschau() {
  zustand.vorschau = null
  const dlg = dateiDialog()
  if (dlg?.open) dlg.close()
}

function rendereDateiVorschau() {
  const v = zustand.vorschau
  const dlg = dateiDialog()
  if (!v || !dlg) return

  $('#datei-titel').textContent = v.directory ? v.path : v.name
  $('#datei-pfad').textContent = v.path
  $('#datei-pfad').title = v.path
  const aktionen = $('#datei-aktionen')
  if (aktionen) aktionen.innerHTML = pfadAktionenHtml(v.path, { schliessen: true })

  if (v.directory) {
    const kinder = v.children?.length
      ? v.children
          .map(
            (c) => `<div class="datei-eintrag-zeile">
              <button type="button" class="datei-eintrag" data-aktion="agent-datei" data-pfad="${h(c.path)}">
                <span class="datei-name">${h(c.name)}${c.directory ? '/' : ''}</span>
                <span class="hint">${c.directory ? 'Ordner' : 'Datei'}</span>
              </button>
              ${pfadAktionenHtml(c.path, { kompakt: true })}
            </div>`
          )
          .join('')
      : '<div class="datei-leer">Leerer Ordner</div>'
    $('#datei-koerper').innerHTML = `<div class="datei-liste">${kinder}</div>`
  } else {
    $('#datei-koerper').innerHTML =
      `<pre class="quelle">${h(v.content)}${v.truncated ? '\n\n… gekürzt' : ''}</pre>`
  }

  if (!dlg.open) {
    if (typeof dlg.showModal === 'function') dlg.showModal()
    else dlg.setAttribute('open', '')
  }
}

async function ladeDateiVorschau(pfad) {
  if (!zustand.projekt) return
  try {
    zustand.vorschau = await api(
      `/api/projects/${encodeURIComponent(zustand.projekt)}/agents/file?path=${encodeURIComponent(pfad)}`
    )
    rendereDateiVorschau()
  } catch (err) {
    zeigeFehler(err.message)
  }
}

// ------------------------------------------------------------------ Log

function faerbeLog(zeilen) {
  return zeilen
    .map((zeile) => {
      const escaped = h(zeile)
      if (/devhub\s+✓/.test(zeile)) return `<span class="ok">${escaped}</span>`
      if (/devhub\s+!/.test(zeile)) return `<span class="wr">${escaped}</span>`
      if (/error|fehler|failed/i.test(zeile)) return `<span class="er">${escaped}</span>`
      return escaped.replace(/^(\d{2}:\d{2}:\d{2})/, '<span class="z">$1</span>')
    })
    .join('\n')
}

async function rendereLog({ ruhig = false } = {}) {
  const name = zustand.projekt
  if (!name) return
  const projekt = zustand.daten?.projects.find((p) => p.name === name)
  const titel = projekt ? anzeigeName(projekt) : name
  const params = new URLSearchParams({ profile: zustand.log.profil, lines: '400' })
  if (zustand.log.prozess) params.set('process', zustand.log.prozess)

  try {
    const daten = await api(`/api/projects/${encodeURIComponent(name)}/logs?${params}`)
    zustand.log.prozess = daten.process
    const signatur = [
      daten.file,
      daten.process,
      daten.lines.length,
      daten.lines[0] ?? '',
      daten.lines.at(-1) ?? ''
    ].join('\0')
    if (ruhig && signatur === zustand.logSignatur && $('#log-inhalt')) {
      if (zustand.log.folgen) {
        const pre = $('#log-inhalt')
        pre.scrollTop = pre.scrollHeight
      }
      return
    }
    zustand.logSignatur = signatur

    const chips = daten.processes
      .map(
        (proc) =>
          `<button class="chip" data-aktion="log-prozess" data-prozess="${h(proc)}" aria-pressed="${proc === daten.process}">${h(proc)}</button>`
      )
      .join('')
    const detailUrl = `/projekt/${encodeURIComponent(zustand.projekt)}`
    $('#log').innerHTML = `
      ${seitenKopfHtml({
        titelHtml: seitenTitelHtml([
          { label: 'Übersicht', href: '/' },
          { label: titel, href: detailUrl },
          { label: 'Log' }
        ]),
        untertitel: `Ausgabe dieses Projekts${daten.process ? ` · Prozess <strong>${h(daten.process)}</strong>` : ''}`
      })}
      <div class="log-leiste">
        <span class="log-prozesse" role="toolbar" aria-label="Prozess wählen">${chips}</span>
        <span class="rechts">
          <label><input type="checkbox" id="folgen" ${zustand.log.folgen ? 'checked' : ''}> folgen</label>
          ${
            daten.file
              ? `<span class="log-datei">
                  <span class="meta" title="${h(daten.file)}">${h(daten.file)}</span>
                  ${pfadAktionenHtml(daten.file, { kompakt: true })}
                </span>`
              : ''
          }
        </span>
      </div>
      <pre class="log" id="log-inhalt">${
        daten.lines.length
          ? faerbeLog(daten.lines)
          : '<span class="z">Noch keine Ausgabe — dieser Prozess wurde vom Hub noch nicht gestartet.</span>'
      }</pre>`
    if (zustand.log.folgen) {
      const pre = $('#log-inhalt')
      pre.scrollTop = pre.scrollHeight
    }
  } catch (err) {
    $('#log').innerHTML = `<div class="leer">${h(err.message)}</div>`
  }
}

// ------------------------------------------------------------------ Verlauf

function hubLogTyp(text) {
  const t = text.trim()
  if (/^fehler\b/i.test(t) || /^error\b/i.test(t) || /^POST\s+\//i.test(t)) {
    return { typ: 'fehler', label: 'Fehler' }
  }
  if (/^settings\b/i.test(t)) return { typ: 'settings', label: 'Config' }
  if (/^forget\b/i.test(t)) return { typ: 'forget', label: 'Slot' }
  if (/^unsync\b/i.test(t)) return { typ: 'unsync', label: 'Unsync' }
  if (/^sync\b/i.test(t)) return { typ: 'sync', label: 'Sync' }
  if (/^adopt\b/i.test(t)) return { typ: 'adopt', label: 'Slot' }
  if (/beendet sich|Übersicht auf|startet|geladen/i.test(t)) return { typ: 'hub', label: 'Hub' }
  if (/✓/.test(t)) return { typ: 'ok', label: 'OK' }
  if (/!\s|warnung/i.test(t)) return { typ: 'warnung', label: 'Hinweis' }
  return { typ: 'info', label: 'Info' }
}

function hubLogProjekt(text) {
  const m = text.trim().match(/^(?:sync|unsync|forget|adopt)\s+(\S+)/i)
  return m?.[1] ?? null
}

function hubLogIstKopf(text) {
  return /^(sync|unsync|forget|adopt|settings)\b/i.test(text)
    || /^(fehler:|error:|POST\s+\/)/i.test(text)
    || /beendet sich|Übersicht auf/i.test(text)
}

function hubLogIstRauschen(text) {
  return /^(gleich\s|unverändert\b)/i.test(text)
}

function hubLogDetailAnhaengen(eintrag, text) {
  if (!text || hubLogIstRauschen(text)) return
  eintrag.details.push(text)
}

/** Rohzeilen → Ereignisse (neueste zuerst). Sync-Blöcke und Wiederholungen werden verdichtet. */
function parseHubLog(lines) {
  const roh = []
  let aktuell = null

  const neuerEintrag = (zeit, text) => {
    const { typ, label } = hubLogTyp(text)
    aktuell = {
      zeit,
      text,
      typ,
      label,
      projekt: hubLogProjekt(text),
      details: [],
      anzahl: 1
    }
    roh.push(aktuell)
  }

  for (const line of lines ?? []) {
    const m = line.match(/^(\d{2}:\d{2}:\d{2})\s+devhub\s+(.*)$/)
    const zeit = m?.[1] ?? ''
    const text = (m ? m[2] : line).trim()
    if (!text) continue

    if (!m && !/^fehler:/i.test(line)) {
      if (aktuell) hubLogDetailAnhaengen(aktuell, text)
      continue
    }

    // „sync foo — 4 Dateien geändert“ schließt den offenen Sync-Block ab.
    const summary = text.match(/^(sync|unsync|forget|adopt)\s+(\S+)\s+—\s+(.+)/i)
    if (summary && aktuell) {
      const prev = aktuell.text.match(/^(sync|unsync|forget|adopt)\s+(\S+)/i)
      if (
        prev &&
        prev[1].toLowerCase() === summary[1].toLowerCase() &&
        prev[2] === summary[2]
      ) {
        aktuell.text = text
        const { typ, label } = hubLogTyp(text)
        aktuell.typ = typ
        aktuell.label = label
        continue
      }
    }

    if (/^\s+/.test(m?.[2] ?? '') && aktuell) {
      hubLogDetailAnhaengen(aktuell, text)
      continue
    }

    if (hubLogIstKopf(text) || !aktuell) {
      neuerEintrag(zeit, text)
      continue
    }

    // Zwischenzeilen eines Sync/Forget gehören zum offenen Ereignis.
    hubLogDetailAnhaengen(aktuell, text)
  }

  // Identische aufeinanderfolgende Einträge (z. B. Port-Fehler) zusammenziehen.
  const kompakt = []
  for (const e of roh) {
    const prev = kompakt[kompakt.length - 1]
    if (
      prev &&
      prev.text === e.text &&
      prev.typ === e.typ &&
      prev.details.length === 0 &&
      e.details.length === 0
    ) {
      prev.anzahl += 1
      if (e.zeit) prev.zeit = e.zeit
      continue
    }
    kompakt.push({ ...e, details: [...e.details] })
  }
  return kompakt.reverse()
}

function verlaufTitel(eintrag) {
  const t = eintrag.text
  let m
  if ((m = t.match(/^(?:sync|forget|adopt|settings)\s+\S+\s+—\s+(.+)/i))) return m[1]
  if (/^unsync\s+\S+$/i.test(t)) return 'Lokale Hub-Dateien entfernt'
  if (/^sync\s+\S+$/i.test(t)) return 'Agent-Dateien synchronisiert'
  if (/beendet sich/.test(t)) return 'Hub beendet — Dev-Server laufen weiter'
  if ((m = t.match(/^Übersicht auf\s+(.+)/i))) return `Hub gestartet · ${m[1]}`
  return t
}

function verlaufEintragHtml(eintrag) {
  const projekt = eintrag.projekt
    ? zustand.daten?.projects?.find((p) => p.name === eintrag.projekt)
    : null
  const projektLabel = projekt ? anzeigeName(projekt) : eintrag.projekt
  const details = eintrag.details.length
    ? `<ul class="verlauf-details">${eintrag.details.map((d) => `<li>${h(d)}</li>`).join('')}</ul>`
    : ''
  const projektHtml = eintrag.projekt
    ? `<button type="button" class="verlauf-projekt" data-aktion="detail" data-projekt="${h(eintrag.projekt)}" title="Details öffnen">${h(projektLabel)}</button>`
    : ''

  return `<article class="verlauf-eintrag" data-typ="${h(eintrag.typ)}">
    <div class="verlauf-zeit">${eintrag.zeit ? h(eintrag.zeit) : '—'}</div>
    <div class="verlauf-spur" aria-hidden="true"><span class="verlauf-punkt"></span></div>
    <div class="verlauf-koerper">
      <div class="verlauf-kopf-zeile">
        <span class="verlauf-badge">${h(eintrag.label)}</span>
        ${projektHtml}
        ${eintrag.anzahl > 1 ? `<span class="verlauf-anzahl">×${eintrag.anzahl}</span>` : ''}
      </div>
      <p class="verlauf-text">${h(verlaufTitel(eintrag))}</p>
      ${details}
    </div>
  </article>`
}

async function rendereVerlauf({ ruhig = false } = {}) {
  const ziel = $('#verlauf')
  if (!ziel) return

  try {
    const daten = await api('/api/hub-log?lines=250')
    const eintraege = parseHubLog(daten.lines ?? [])
    const signatur = [
      daten.file ?? '',
      daten.lines?.length ?? 0,
      daten.lines?.[0] ?? '',
      daten.lines?.at?.(-1) ?? ''
    ].join('\0')

    if (ruhig && signatur === zustand.verlauf.signatur && ziel.querySelector('.verlauf-liste')) {
      return
    }

    zustand.verlauf = { datei: daten.file ?? null, eintraege, signatur }

    const meta = daten.file
      ? `<span class="verlauf-datei">
          <span class="meta" title="${h(daten.file)}">${h(daten.file)}</span>
          ${pfadAktionenHtml(daten.file, { kompakt: true })}
        </span>`
      : ''

    const liste = eintraege.length
      ? `<div class="verlauf-liste">${eintraege.map(verlaufEintragHtml).join('')}</div>`
      : `<div class="leer-box">
          <strong>Noch keine Einträge</strong>
          <p>Sync, Slot-Vergabe und ähnliche Aktionen erscheinen hier automatisch.</p>
        </div>`

    ziel.innerHTML = `
      ${seitenKopfHtml({
        titelHtml: seitenTitelHtml([{ label: 'Verlauf' }]),
        untertitel: 'Hub-Aktionen und Meldungen',
        meta: `${eintraege.length ? `<span class="verlauf-count">${eintraege.length} Einträge</span>` : ''}${meta}`
      })}
      ${liste}`
  } catch (err) {
    if (!ruhig) {
      ziel.innerHTML = `<div class="leer-box"><strong>Verlauf nicht lesbar</strong><p>${h(err.message)}</p></div>`
    }
  }
}

// ------------------------------------------------------------------ Routing

function routeAusUrl() {
  const teile = location.pathname.split('/').filter(Boolean).map(decodeURIComponent)
  if (teile[0] === 'verlauf' && !teile[1]) return { ansicht: 'verlauf', projekt: null }
  if (teile[0] === 'einstellungen' && !teile[1]) return { ansicht: 'einstellungen', projekt: null }
  if (teile[0] === 'projekt' && teile[1]) {
    const projekt = teile[1]
    const params = new URLSearchParams(location.search)
    if (teile[2] === 'log') {
      return {
        ansicht: 'log',
        projekt,
        log: {
          profil: params.get('profil') || 'default',
          prozess: params.get('prozess') || null
        }
      }
    }
    if (!teile[2]) return { ansicht: 'detail', projekt }
  }
  return { ansicht: 'uebersicht', projekt: null }
}

function urlFuer({ ansicht = zustand.ansicht, projekt = zustand.projekt, log = zustand.log } = {}) {
  if (ansicht === 'verlauf') return '/verlauf'
  if (ansicht === 'einstellungen') return '/einstellungen'
  if (ansicht === 'log' && projekt) {
    const q = new URLSearchParams()
    if (log.profil && log.profil !== 'default') q.set('profil', log.profil)
    if (log.prozess) q.set('prozess', log.prozess)
    const qs = q.toString()
    return `/projekt/${encodeURIComponent(projekt)}/log${qs ? `?${qs}` : ''}`
  }
  if (ansicht === 'detail' && projekt) return `/projekt/${encodeURIComponent(projekt)}`
  return '/'
}

function setzeTitel() {
  const projekt = zustand.daten?.projects.find((p) => p.name === zustand.projekt)
  const name = projekt ? anzeigeName(projekt) : zustand.projekt
  if (zustand.ansicht === 'verlauf') document.title = 'Verlauf · devhub'
  else if (zustand.ansicht === 'einstellungen') document.title = 'Einstellungen · devhub'
  else if (zustand.ansicht === 'log' && name) document.title = `Log · ${name} · devhub`
  else if (zustand.ansicht === 'detail' && name) document.title = `${name} · devhub`
  else document.title = 'devhub'
}

function setzeNavAktiv() {
  // Detail/Log gehören zur Übersicht — Verlauf/Einstellungen sind eigene Sektionen.
  let aktivNav = 'uebersicht'
  if (zustand.ansicht === 'verlauf') aktivNav = 'verlauf'
  else if (zustand.ansicht === 'einstellungen') aktivNav = 'einstellungen'
  for (const el of document.querySelectorAll('.kopf-nav [data-nav]')) {
    const aktiv = el.dataset.nav === aktivNav
    el.classList.toggle('aktiv', aktiv)
    if (aktiv) el.setAttribute('aria-current', 'page')
    else el.removeAttribute('aria-current')
  }
}

function setzeAnsicht(ansicht) {
  zustand.ansicht = ansicht
  for (const id of ['uebersicht', 'detail', 'log', 'verlauf', 'einstellungen']) {
    const el = $(`#${id}`)
    if (el) el.hidden = id !== ansicht
  }
  if (ansicht === 'detail') rendereDetail()
  if (ansicht === 'log') rendereLog()
  if (ansicht === 'uebersicht') rendereUebersicht()
  if (ansicht === 'verlauf') rendereVerlauf()
  if (ansicht === 'einstellungen') rendereEinstellungen()
  setzeNavAktiv()
  setzeTitel()
  scrollTo({ top: 0 })
}

async function ladeAgenten(name) {
  if (zustand.agentenProjekt === name && zustand.agenten) return
  try {
    zustand.agenten = await api(`/api/projects/${encodeURIComponent(name)}/agents`)
    zustand.agentenProjekt = name
  } catch (err) {
    zustand.agenten = null
    zustand.agentenProjekt = null
    zeigeFehler(err.message)
  }
}

async function wendeRouteAn() {
  const route = routeAusUrl()

  if (route.ansicht === 'uebersicht') {
    schliesseDateiVorschau()
    zustand.projekt = null
    setzeAnsicht('uebersicht')
    return
  }

  if (route.ansicht === 'verlauf') {
    schliesseDateiVorschau()
    zustand.projekt = null
    setzeAnsicht('verlauf')
    return
  }

  if (route.ansicht === 'einstellungen') {
    schliesseDateiVorschau()
    zustand.projekt = null
    setzeAnsicht('einstellungen')
    try {
      await ladeEinstellungen({ erzwingen: !zustand.einstellungen.dirty })
      rendereEinstellungen()
    } catch (err) {
      zeigeFehler(err.message)
      const ziel = $('#einstellungen')
      if (ziel) {
        ziel.innerHTML = `<div class="leer">
          <h2>Einstellungen</h2>
          <p>Konnte nicht geladen werden: ${h(err.message)}</p>
        </div>`
      }
    }
    return
  }

  if (!zustand.daten) await laden({ ohneRoute: true })

  const projekt = zustand.daten?.projects.find((p) => p.name === route.projekt)
  if (!projekt) {
    zeigeFehler(`Projekt „${route.projekt}“ nicht gefunden`)
    return geheZu('/', { ersetzen: true })
  }

  zustand.projekt = route.projekt

  if (route.ansicht === 'log') {
    zustand.log.profil = route.log.profil
    zustand.log.prozess = route.log.prozess
    schliesseDateiVorschau()
    setzeAnsicht('log')
    return
  }

  await ladeAgenten(route.projekt)
  setzeAnsicht('detail')
}

function hatUngespeicherteEinstellungen() {
  return zustand.ansicht === 'einstellungen' && einstellungenDirty()
}

function geheZu(ziel, { ersetzen = false } = {}) {
  const url = typeof ziel === 'string' ? ziel : urlFuer(ziel)
  if (hatUngespeicherteEinstellungen() && !url.startsWith('/einstellungen')) {
    const ok = confirm('Einstellungen haben ungespeicherte Änderungen. Trotzdem verlassen?')
    if (!ok) return
    zustand.einstellungen.draft = einstellungenKlon(zustand.einstellungen.geladen)
    zustand.einstellungen.dirty = false
    zustand.einstellungen.hinweis = ''
  }
  const jetzt = `${location.pathname}${location.search}`
  if (url !== jetzt) history[ersetzen ? 'replaceState' : 'pushState'](null, '', url)
  return wendeRouteAn()
}

function oeffneDetail(name, { ersetzen = false } = {}) {
  schliesseDateiVorschau()
  zustand.agenten = null
  zustand.agentenProjekt = null
  return geheZu(`/projekt/${encodeURIComponent(name)}`, { ersetzen })
}

function oeffneLog(name, { profil = 'default', prozess = null, ersetzen = false } = {}) {
  zustand.projekt = name
  zustand.log.profil = profil
  zustand.log.prozess = prozess
  return geheZu(urlFuer({ ansicht: 'log', projekt: name, log: { profil, prozess } }), { ersetzen })
}

// ------------------------------------------------------------------ Daten

/** Ohne Speicher — der schwankt dauernd und würde die Liste unnötig neu zeichnen. */
function listenSignaturVon(daten) {
  if (!daten?.projects) return ''
  return daten.projects
    .map((p) =>
      [
        p.name,
        p.displayName ?? '',
        p.adopted ? 1 : 0,
        p.slot ?? '',
        JSON.stringify(p.profileSlots ?? {}),
        p.github?.url ?? '',
        (p.problems ?? []).join('|'),
        (p.profiles ?? [])
          .map((profil) =>
            [
              profil.profile,
              profil.state,
              profil.startedAt ?? '',
              ...(profil.processes ?? []).map((proc) =>
                [
                  proc.name,
                  proc.role,
                  proc.port ?? '',
                  proc.listening ? 1 : 0,
                  proc.pid ?? '',
                  proc.foreign ? 1 : 0,
                  proc.url ?? '',
                  JSON.stringify(proc.paths ?? [])
                ].join(':')
              )
            ].join('/')
          )
          .join('~')
      ].join('\t')
    )
    .join('\n')
}

function fussSignaturVon(daten) {
  if (!daten?.summary) return ''
  const s = daten.summary
  return [
    s.total,
    s.adopted,
    s.running,
    s.conflicts ?? 0,
    Math.round((s.memory ?? 0) / (256 * 1024)),
    daten.hub?.service?.loaded ? 1 : 0
  ].join(':')
}

/**
 * Laufzeit/RAM in bestehenden Zeilen nachziehen — ohne die Liste neu zu bauen
 * (sonst flackert sie und offene Menüs schließen).
 */
function aktualisiereLaufendeMetas(daten) {
  if (!daten?.projects) return
  for (const projekt of daten.projects) {
    for (const profil of projekt.profiles ?? []) {
      const laeuft = profil.state === 'läuft' || profil.state === 'teilweise'
      if (!laeuft) continue
      const zeile = document.querySelector(
        `#liste .zeile[data-projekt="${CSS.escape(projekt.name)}"][data-profil="${CSS.escape(profil.profile)}"]`
      )
      const meta = zeile?.querySelector(':scope > .meta')
      if (meta) meta.textContent = metaLaufend(profil)
    }
  }
}

function aktualisiereDetailMetas(daten) {
  const name = zustand.projekt
  if (!name) return
  const projekt = daten?.projects?.find((p) => p.name === name)
  if (!projekt) return

  for (const profil of projekt.profiles ?? []) {
    const karte = document.querySelector(
      `#detail .server-karte[data-profil="${CSS.escape(profil.profile)}"]`
    )
    if (!karte) continue
    const laufzeit = karte.querySelector('.meta-laufzeit')
    if (laufzeit) laufzeit.textContent = zustandLabel(profil)

    for (const proc of profil.processes ?? []) {
      const zeile = karte.querySelector(`.prozess[data-prozess="${CSS.escape(proc.name)}"]`)
      const meta = zeile?.querySelector('.meta')
      if (!meta) continue
      const teile = [
        proc.port != null ? `Port ${proc.port}` : null,
        proc.pid ? `PID ${proc.pid}` : proc.runner === 'compose' ? 'compose' : null,
        proc.memory ? speicher(proc.memory) : null
      ].filter(Boolean)
      meta.textContent = teile.join(' · ')
    }
  }
}

async function laden({ ohneRoute = false, ruhig = false, erzwingen = false } = {}) {
  // Poll und Aktion überlappen oft: der laufende Fetch hat noch den alten Stand.
  // Statt zu verwerfen, nach dem aktuellen Lauf noch einmal holen.
  if (zustand.ladenLaufend) {
    if (erzwingen || !ruhig) zustand.ladenErneut = { ohneRoute: false, ruhig: false }
    return
  }
  zustand.ladenLaufend = true
  try {
    const daten = await api('/api/overview?memory=1')
    zustand.daten = daten

    const listeNeu = listenSignaturVon(daten)
    const fussNeu = fussSignaturVon(daten)
    // Erzwungene Aktualisierung nach Aktion: Signatur-Kurzschluss überspringen.
    const listeGleich = !erzwingen && ruhig && listeNeu === zustand.listenSignatur
    const fussGleich = ruhig && fussNeu === zustand.fussSignatur

    if (!fussGleich || erzwingen) {
      rendereFuss()
      zustand.fussSignatur = fussNeu
    }

    if (ohneRoute) {
      zustand.listenSignatur = listeNeu
      return
    }

    // Offenes Menü: DOM nicht anfassen — sonst schließt es. Nach dem Schließen erneut zeichnen.
    if (document.querySelector('details.menu[open]')) {
      zustand.listenSignatur = listeNeu
      zustand._listeWartet = !listeGleich
      return
    }

    if (listeGleich) {
      // Signatur bewusst ohne RAM — Laufzeit/MB trotzdem live nachziehen.
      if (zustand.ansicht === 'uebersicht') aktualisiereLaufendeMetas(daten)
      if (zustand.ansicht === 'detail') aktualisiereDetailMetas(daten)
      return
    }

    zustand.listenSignatur = listeNeu
    zustand._listeWartet = false
    if (zustand.ansicht === 'uebersicht') rendereUebersicht()
    if (zustand.ansicht === 'detail') rendereDetail()
  } catch (err) {
    if (!ruhig) zeigeFehler(`Hub antwortet nicht: ${err.message}`)
  } finally {
    zustand.ladenLaufend = false
    const erneut = zustand.ladenErneut
    if (erneut) {
      zustand.ladenErneut = null
      await laden({ ...erneut, erzwingen: true })
    }
  }
}

function stoppePolling() {
  if (zustand.pollTimer != null) {
    clearInterval(zustand.pollTimer)
    zustand.pollTimer = null
  }
}

function startePolling() {
  stoppePolling()
  if (document.hidden) return
  zustand.pollTimer = setInterval(() => {
    if (document.hidden) return
    if (zustand.ansicht === 'log') rendereLog({ ruhig: true })
    else if (zustand.ansicht === 'verlauf') rendereVerlauf({ ruhig: true })
    else laden({ ruhig: true })
  }, 5000)
}

async function pollSofort() {
  if (document.hidden) return
  if (zustand.ansicht === 'log') await rendereLog({ ruhig: true })
  else if (zustand.ansicht === 'verlauf') await rendereVerlauf({ ruhig: true })
  else await laden({ ruhig: true })
}

// ------------------------------------------------------------------ Befehlspalette
// Zwei Ebenen: Navigation + Projekte → Projektaktionen.
// Power-User: „suntino starten“ auf Ebene 1 trifft die Aktion direkt.

function befehlDialog() {
  return $('#befehl')
}

function befehlOffen() {
  return Boolean(befehlDialog()?.open)
}

function profilLaeuft(profil) {
  return profil?.state === 'läuft' || profil?.state === 'teilweise'
}

function tokenScore(teile, q) {
  let best = 0
  for (const roh of teile) {
    if (!roh) continue
    const t = String(roh).toLowerCase()
    if (t === q) best = Math.max(best, 100)
    else if (t.startsWith(q)) best = Math.max(best, 80)
    else if (t.includes(q)) best = Math.max(best, 55)
    else {
      // Anfangsbuchstaben: „mt“ trifft „MapTale“
      const initials = t
        .split(/[^a-z0-9äöüß]+/i)
        .filter(Boolean)
        .map((w) => w[0])
        .join('')
      if (initials.startsWith(q)) best = Math.max(best, 40)
    }
  }
  return best
}

/** Mehrere Wörter: jedes Token muss irgendwo treffen („starten suntino“). */
function befehlScore(teile, query) {
  if (!query) return 1
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!tokens.length) return 1
  let summe = 0
  for (const q of tokens) {
    const score = tokenScore(teile, q)
    if (score <= 0) return 0
    summe += score
  }
  return summe / tokens.length
}

function befehlSuchfelder(b) {
  return [b.label, b.hint, b.meta, b.gruppe, ...(b.keywords ?? [])]
}

/** Kleinere Zahl = weiter oben, wenn die Suchpunktzahl gleich ist. */
function befehlPrioritaet(b) {
  const id = b.id
  if (id === 'nav:zurueck') return 0
  if (id.startsWith('nav:')) return 1
  if (b.art === 'projekt') return 2
  if (id.includes(':stopp:')) return 3
  if (id.includes(':start:')) return 4
  if (id.endsWith(':aufnehmen')) return 5
  if (id.endsWith(':detail')) return 6
  if (id.includes(':log:') || id.includes(':browser:')) return 7
  if (id.includes(':neu:')) return 8
  if (id.endsWith(':finder') || id.endsWith(':editor') || id.endsWith(':github')) return 9
  if (id.endsWith(':sync') || id.endsWith(':anzeigename')) return 10
  if (id.endsWith(':vergessen')) return 11
  return 12
}

function befehlEintrag(teil) {
  return {
    id: teil.id,
    label: teil.label,
    hint: teil.hint ?? '',
    meta: teil.meta ?? '',
    gruppe: teil.gruppe ?? 'Befehle',
    punkt: teil.punkt ?? 'punkt',
    gefahr: Boolean(teil.gefahr),
    keywords: teil.keywords ?? [],
    art: teil.art ?? 'aktion',
    projekt: teil.projekt ?? null,
    ausfuehren: teil.ausfuehren
  }
}

function projektMeta(projekt) {
  const titel = anzeigeName(projekt)
  const ordner = projekt.name
  const art = projekt.stack?.framework ?? projekt.stack?.kind ?? ''
  const haupt = projekt.profiles[0]
  const laeuft = projekt.profiles.some(profilLaeuft)
  const punkt = haupt
    ? laeuft
      ? punktKlasse(projekt.profiles.find(profilLaeuft)?.state ?? haupt.state)
      : 'punkt'
    : 'punkt'
  const zustandHint = !projekt.profiles.length
    ? 'kein Server'
    : !projekt.adopted
      ? 'kein Slot'
      : laeuft
        ? 'läuft'
        : 'gestoppt'
  return {
    titel,
    ordner,
    art,
    punkt,
    zustandHint,
    basis: [titel, ordner, art, zustandHint],
    gruppe: titel === ordner ? titel : `${titel} · ${ordner}`
  }
}

function findeProjekt(name) {
  return (zustand.daten?.projects ?? []).find((p) => p.name === name) ?? null
}

/** Kontextuelles „Zurück“ — erste Nav-Zeile, wenn es eine sinnvolle Oberansicht gibt. */
function baueZurueckBefehl() {
  if (zustand.ansicht === 'log' && zustand.projekt) {
    const projekt = findeProjekt(zustand.projekt)
    const titel = projekt ? anzeigeName(projekt) : zustand.projekt
    return befehlEintrag({
      id: 'nav:zurueck',
      label: 'Zurück',
      hint: titel,
      meta: '←',
      gruppe: 'Navigation',
      keywords: ['zurück', 'back', 'prev'],
      ausfuehren: () => oeffneDetail(zustand.projekt)
    })
  }
  if (zustand.ansicht === 'detail' && zustand.projekt) {
    return befehlEintrag({
      id: 'nav:zurueck',
      label: 'Zurück',
      hint: 'Übersicht',
      meta: '←',
      gruppe: 'Navigation',
      keywords: ['zurück', 'back', 'prev', 'übersicht'],
      ausfuehren: () => geheZu('/')
    })
  }
  if (zustand.ansicht === 'verlauf' || zustand.ansicht === 'einstellungen') {
    return befehlEintrag({
      id: 'nav:zurueck',
      label: 'Zurück',
      hint: 'Übersicht',
      meta: '←',
      gruppe: 'Navigation',
      keywords: ['zurück', 'back', 'prev', 'übersicht'],
      ausfuehren: () => geheZu('/')
    })
  }
  return null
}

function baueNavBefehle() {
  const daten = zustand.daten
  const liste = []
  const zurueck = baueZurueckBefehl()
  if (zurueck) liste.push(zurueck)

  if (zustand.ansicht !== 'uebersicht') {
    liste.push(
      befehlEintrag({
        id: 'nav:uebersicht',
        label: 'Übersicht',
        hint: 'Alle Projekte',
        gruppe: 'Navigation',
        keywords: ['übersicht', 'home', 'projekte', 'liste'],
        ausfuehren: () => geheZu('/')
      })
    )
  }
  if (zustand.ansicht !== 'verlauf') {
    liste.push(
      befehlEintrag({
        id: 'nav:verlauf',
        label: 'Verlauf',
        hint: 'Hub-Protokoll',
        gruppe: 'Navigation',
        keywords: ['verlauf', 'log', 'history', 'hub', 'protokoll'],
        ausfuehren: () => oeffneVerlauf()
      })
    )
  }
  if (zustand.ansicht !== 'einstellungen') {
    liste.push(
      befehlEintrag({
        id: 'nav:einstellungen',
        label: 'Einstellungen',
        hint: 'Hub-Konfiguration',
        gruppe: 'Navigation',
        keywords: ['einstellungen', 'settings', 'config', 'konfiguration', 'optionen'],
        ausfuehren: () => oeffneEinstellungen()
      })
    )
  }
  const theme = themeAktuell()
  liste.push(
    befehlEintrag({
      id: 'nav:theme',
      label: theme === 'light' ? 'Dunkelmodus' : 'Hellmodus',
      hint: theme === 'light' ? 'Dunkle Oberfläche' : 'Helle Oberfläche',
      meta: theme === 'light' ? 'dark' : 'light',
      gruppe: 'Navigation',
      keywords: ['theme', 'dark', 'light', 'hell', 'dunkel', 'modus', 'darstellung', 'farbschema'],
      ausfuehren: () => setzeTheme(theme === 'light' ? 'dark' : 'light')
    })
  )
  liste.push(
    befehlEintrag({
      id: 'nav:alle-stoppen',
      label: 'Alle Server stoppen',
      hint: daten?.summary?.running ? `${daten.summary.running} laufen` : 'nichts läuft',
      gruppe: 'Navigation',
      keywords: ['alle', 'stoppen', 'down', 'kill'],
      gefahr: true,
      ausfuehren: () => aktionAusfuehren('alle-stoppen')
    })
  )
  return liste
}

function baueProjektEintraege() {
  return (zustand.daten?.projects ?? []).map((projekt) => {
    const m = projektMeta(projekt)
    return befehlEintrag({
      id: `nav:projekt:${m.ordner}`,
      label: m.titel,
      hint: m.titel === m.ordner ? m.zustandHint : m.ordner,
      meta: m.zustandHint,
      gruppe: 'Projekte',
      punkt: m.punkt,
      art: 'projekt',
      projekt: m.ordner,
      keywords: [...m.basis, 'projekt', 'öffnen'],
      // Drill-down — nicht schließen.
      ausfuehren: () => oeffneBefehlProjekt(m.ordner)
    })
  })
}

/** Aktionen eines Projekts (Ebene 2, bzw. Direkttreffer auf Ebene 1). */
function baueProjektAktionen(projekt) {
  const m = projektMeta(projekt)
  const liste = []
  const push = (teil) => liste.push(befehlEintrag(teil))
  const { titel, ordner, basis, gruppe, punkt } = m

  push({
    id: `projekt:${ordner}:detail`,
    label: 'Details öffnen',
    hint: gruppe,
    meta: m.zustandHint,
    gruppe: 'Aktionen',
    punkt,
    projekt: ordner,
    keywords: [...basis, 'details', 'öffnen', 'ansehen'],
    ausfuehren: () => aktionAusfuehren('detail', { projekt: ordner })
  })

  if (!projekt.adopted && projekt.profiles.length) {
    push({
      id: `projekt:${ordner}:aufnehmen`,
      label: 'Slot vergeben',
      hint: gruppe,
      meta: 'aufnehmen',
      gruppe: 'Aktionen',
      punkt,
      projekt: ordner,
      keywords: [...basis, 'slot', 'aufnehmen', 'adopt', 'vergeben'],
      ausfuehren: () => aktionAusfuehren('aufnehmen', { projekt: ordner })
    })
  }

  for (const profil of projekt.profiles) {
    const profilSuffix = profil.profile === 'default' ? '' : ` · ${profil.profile}`
    const profilKeys = [...basis, profil.profile]
    if (!projekt.adopted) continue

    if (profilLaeuft(profil)) {
      push({
        id: `projekt:${ordner}:stopp:${profil.profile}`,
        label: `Stoppen${profilSuffix}`,
        hint: gruppe,
        meta: metaLaufend(profil) || 'läuft',
        gruppe: 'Aktionen',
        punkt: punktKlasse(profil.state),
        projekt: ordner,
        keywords: [...profilKeys, 'stoppen', 'down', 'halt'],
        ausfuehren: () =>
          aktionAusfuehren('stopp', { projekt: ordner, profil: profil.profile })
      })
      push({
        id: `projekt:${ordner}:neu:${profil.profile}`,
        label: `Neu starten${profilSuffix}`,
        hint: gruppe,
        meta: 'restart',
        gruppe: 'Aktionen',
        punkt: punktKlasse(profil.state),
        projekt: ordner,
        keywords: [...profilKeys, 'neu', 'restart', 'reload'],
        ausfuehren: () => aktionAusfuehren('neu', { projekt: ordner, profil: profil.profile })
      })
      const adresse =
        profil.processes.find((p) => p.role === 'frontend' && p.listening)?.url ??
        profil.processes.find((p) => p.listening)?.url
      if (adresse) {
        push({
          id: `projekt:${ordner}:browser:${profil.profile}`,
          label: `Im Browser öffnen${profilSuffix}`,
          hint: adresse.replace(/^https?:\/\//, ''),
          meta: 'url',
          gruppe: 'Aktionen',
          punkt: punktKlasse(profil.state),
          projekt: ordner,
          keywords: [...profilKeys, 'browser', 'öffnen', 'url', adresse],
          ausfuehren: () => {
            window.open(adresse, '_blank', 'noopener')
          }
        })
      }
      for (const proc of profil.processes) {
        if (!proc.listening) continue
        for (const e of einstiegeVon(proc)) {
          push({
            id: `projekt:${ordner}:pfad:${profil.profile}:${e.path}`,
            label: `${e.label}${profilSuffix}`,
            hint: e.href.replace(/^https?:\/\//, ''),
            meta: 'url',
            gruppe: 'Einstieg',
            punkt: punktKlasse(profil.state),
            projekt: ordner,
            keywords: [...profilKeys, 'einstieg', 'pfad', 'öffnen', e.label, e.path],
            ausfuehren: () => { window.open(e.href, '_blank', 'noopener') }
          })
        }
      }
    } else {
      push({
        id: `projekt:${ordner}:start:${profil.profile}`,
        label: `Starten${profilSuffix}`,
        hint: gruppe,
        meta: 'gestoppt',
        gruppe: 'Aktionen',
        punkt: 'punkt',
        projekt: ordner,
        keywords: [...profilKeys, 'starten', 'start', 'up'],
        ausfuehren: () =>
          aktionAusfuehren('start', { projekt: ordner, profil: profil.profile })
      })
    }
    push({
      id: `projekt:${ordner}:log:${profil.profile}`,
      label: `Log anzeigen${profilSuffix}`,
      hint: gruppe,
      meta: 'log',
      gruppe: 'Aktionen',
      punkt: punktKlasse(profil.state),
      projekt: ordner,
      keywords: [...profilKeys, 'log', 'logs', 'ausgabe'],
      ausfuehren: () =>
        aktionAusfuehren('log', { projekt: ordner, profil: profil.profile })
    })
  }

  push({
    id: `projekt:${ordner}:finder`,
    label: 'Im Finder zeigen',
    hint: gruppe,
    meta: 'finder',
    gruppe: 'Aktionen',
    punkt,
    projekt: ordner,
    keywords: [...basis, 'finder', 'ordner', 'zeigen'],
    ausfuehren: () => aktionAusfuehren('finder', { projekt: ordner })
  })
  push({
    id: `projekt:${ordner}:editor`,
    label: `In ${editorAnzeigename()} öffnen`,
    hint: gruppe,
    meta: 'editor',
    gruppe: 'Aktionen',
    punkt,
    projekt: ordner,
    keywords: [...basis, 'editor', 'cursor', 'code', 'öffnen'],
    ausfuehren: () => aktionAusfuehren('editor', { projekt: ordner })
  })
  if (projekt.github?.url) {
    push({
      id: `projekt:${ordner}:github`,
      label: 'Auf GitHub öffnen',
      hint: projekt.github.label || gruppe,
      meta: 'github',
      gruppe: 'Aktionen',
      punkt,
      projekt: ordner,
      keywords: [...basis, 'github', 'repo'],
      ausfuehren: () => window.open(projekt.github.url, '_blank', 'noopener')
    })
  }
  push({
    id: `projekt:${ordner}:anzeigename`,
    label: 'Anzeigename ändern',
    hint: gruppe,
    meta: 'name',
    gruppe: 'Aktionen',
    punkt,
    projekt: ordner,
    keywords: [...basis, 'anzeigename', 'umbenennen', 'rename', 'titel'],
    ausfuehren: () => aktionAusfuehren('anzeigename', { projekt: ordner })
  })
  if (projekt.adopted) {
    push({
      id: `projekt:${ordner}:sync`,
      label: 'Agent-Dateien syncen',
      hint: gruppe,
      meta: 'sync',
      gruppe: 'Aktionen',
      punkt,
      projekt: ordner,
      keywords: [...basis, 'sync', 'agent', 'dateien'],
      ausfuehren: () => aktionAusfuehren('sync-projekt', { projekt: ordner })
    })
    push({
      id: `projekt:${ordner}:vergessen`,
      label: 'Slot entfernen…',
      hint: gruppe,
      meta: projekt.slot != null ? `Slot ${projekt.slot}` : 'slot',
      gruppe: 'Aktionen',
      punkt,
      projekt: ordner,
      gefahr: true,
      keywords: [...basis, 'vergessen', 'entfernen', 'forget', 'slot'],
      ausfuehren: () => aktionAusfuehren('vergessen', { projekt: ordner })
    })
  }

  return liste
}

function baueAlleProjektAktionen() {
  return (zustand.daten?.projects ?? []).flatMap((projekt) => {
    // Auf Ebene 1: Projektname steht im Hint, Gruppe bleibt flach „Aktionen“.
    return baueProjektAktionen(projekt).map((b) => ({
      ...b,
      gruppe: 'Aktionen',
      hint: b.hint || anzeigeName(projekt)
    }))
  })
}

function sortiereBefehle(liste) {
  return [...liste].sort(
    (a, b) =>
      befehlPrioritaet(a) - befehlPrioritaet(b) ||
      a.label.localeCompare(b.label, 'de') ||
      a.hint.localeCompare(b.hint, 'de')
  )
}

function filtereUndSortiere(kandidaten, query, limit) {
  const q = query.trim()
  if (!q) return sortiereBefehle(kandidaten).slice(0, limit)
  return kandidaten
    .map((b) => ({ b, score: befehlScore(befehlSuchfelder(b), q) }))
    .filter((x) => x.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        befehlPrioritaet(a.b) - befehlPrioritaet(b.b) ||
        a.b.label.localeCompare(b.b.label, 'de')
    )
    .slice(0, limit)
    .map((x) => x.b)
}

/**
 * Direkteingabe „projekt aktion“: Aktionstreffer nur, wenn mindestens ein Token
 * den Projektnamen trifft und eines die Aktion — sonst wären reine Aktionswörter
 * („starten“) zu laut und würden die Projektliste verdrängen.
 */
function filtereDirektAktionen(query, limit) {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.length < 2) return []

  return baueAlleProjektAktionen()
    .map((b) => {
      const felder = befehlSuchfelder(b)
      const score = befehlScore(felder, query)
      if (score <= 0) return null
      const projektFelder = [b.hint, b.projekt, ...(b.keywords ?? [])].filter(Boolean)
      const aktionFelder = [b.label, b.meta, ...(b.keywords ?? [])]
      const trifftProjekt = tokens.some((t) => tokenScore(projektFelder, t) >= 55)
      const trifftAktion = tokens.some((t) => tokenScore(aktionFelder, t) >= 55)
      if (!trifftProjekt || !trifftAktion) return null
      return { b, score }
    })
    .filter(Boolean)
    .sort(
      (a, b) =>
        b.score - a.score ||
        befehlPrioritaet(a.b) - befehlPrioritaet(b.b) ||
        a.b.label.localeCompare(b.b.label, 'de')
    )
    .slice(0, limit)
    .map((x) => x.b)
}

function filtereBefehle(query) {
  const q = query.trim()

  if (zustand.befehl.ebene === 'projekt' && zustand.befehl.projekt) {
    const projekt = findeProjekt(zustand.befehl.projekt)
    if (!projekt) return []
    const gruppenLabel = projektMeta(projekt).gruppe
    const aktionen = baueProjektAktionen(projekt).map((b) => ({
      ...b,
      // Name steckt schon im Kontext-Chip — nur abweichende Hints (z. B. URL) behalten.
      hint: b.hint === gruppenLabel ? '' : b.hint
    }))
    return filtereUndSortiere(aktionen, q, 30)
  }

  const nav = baueNavBefehle()
  const projekte = baueProjektEintraege()

  if (!q) {
    return [...nav, ...sortiereBefehle(projekte)]
  }

  const navTreffer = filtereUndSortiere(nav, q, 8)
  const projektTreffer = filtereUndSortiere(projekte, q, 16)
  const aktionTreffer = filtereDirektAktionen(q, 12)

  // Projekte vor Aktionen, solange der Name noch unscharf ist — sonst Direkttreffer oben.
  if (aktionTreffer.length && tokensKlarFuerAktion(q, projektTreffer)) {
    return [...navTreffer, ...aktionTreffer, ...projektTreffer].slice(0, 28)
  }
  return [...navTreffer, ...projektTreffer, ...aktionTreffer].slice(0, 28)
}

/** „suntino star“ ist klar genug für Aktionen vor der Projektliste. */
function tokensKlarFuerAktion(query, projektTreffer) {
  const tokens = query.trim().split(/\s+/).filter(Boolean)
  if (tokens.length < 2) return false
  // Exakter/präfixer Projektmatch + weiteres Token → Aktionen priorisieren.
  return projektTreffer.some((p) => {
    const namen = [p.label, p.projekt].filter(Boolean).map((s) => String(s).toLowerCase())
    return tokens.some((t) => namen.some((n) => n === t || n.startsWith(t)))
  })
}

function markiereBefehl(index, { scroll = false } = {}) {
  const liste = $('#befehl-liste')
  if (!liste) return
  zustand.befehl.index = index
  for (const el of liste.querySelectorAll('[data-befehl-index]')) {
    const i = Number(el.dataset.befehlIndex)
    const selected = i === index
    el.setAttribute('aria-selected', selected ? 'true' : 'false')
    if (selected && scroll) el.scrollIntoView({ block: 'nearest' })
  }
  const aktiv = liste.querySelector(`[data-befehl-index="${index}"]`)
  const eingabe = $('#befehl-eingabe')
  if (eingabe && aktiv) eingabe.setAttribute('aria-activedescendant', aktiv.id)
}

function befehlKopfAktualisieren() {
  const aufProjekt = zustand.befehl.ebene === 'projekt' && zustand.befehl.projekt
  const projekt = aufProjekt ? findeProjekt(zustand.befehl.projekt) : null
  const titel = projekt ? anzeigeName(projekt) : zustand.befehl.projekt

  const zurueck = $('#befehl-zurueck')
  const icon = $('#befehl-icon')
  const kontext = $('#befehl-kontext')
  const eingabe = $('#befehl-eingabe')
  const fuss = $('#befehl-fuss')

  if (zurueck) zurueck.hidden = !aufProjekt
  if (icon) icon.hidden = aufProjekt
  if (kontext) {
    kontext.hidden = !aufProjekt
    kontext.textContent = titel || ''
    kontext.title = projekt?.name || titel || ''
  }
  if (eingabe) {
    eingabe.placeholder = aufProjekt
      ? 'Aktion …'
      : 'Navigieren, Projekt — oder „projekt aktion“'
  }
  if (fuss) {
    fuss.innerHTML = aufProjekt
      ? `<span><kbd>↑</kbd><kbd>↓</kbd> wählen</span>
         <span><kbd>↵</kbd> ausführen</span>
         <span><kbd>⌫</kbd>/<kbd>esc</kbd> zurück</span>`
      : `<span><kbd>↑</kbd><kbd>↓</kbd> wählen</span>
         <span><kbd>↵</kbd> öffnen</span>
         <span><kbd>esc</kbd> schließen</span>`
  }
}

function rendereBefehlsliste() {
  const liste = $('#befehl-liste')
  if (!liste) return
  befehlKopfAktualisieren()
  const treffer = zustand.befehl.treffer
  if (!treffer.length) {
    liste.innerHTML = `<div class="befehl-leer">Keine Treffer${
      zustand.befehl.query ? ` für „${h(zustand.befehl.query)}“` : ''
    }.</div>`
    return
  }

  let letzteGruppe = null
  const teile = []
  treffer.forEach((b, i) => {
    if (b.gruppe !== letzteGruppe) {
      letzteGruppe = b.gruppe
      teile.push(`<div class="befehl-gruppe">${h(b.gruppe)}</div>`)
    }
    const selected = i === zustand.befehl.index
    const drill = b.art === 'projekt'
    teile.push(`<button type="button" class="befehl-eintrag${b.gefahr ? ' gefahr' : ''}${drill ? ' drill' : ''}" role="option" id="befehl-opt-${i}" data-befehl-index="${i}" aria-selected="${selected}">
      <span class="${h(b.punkt)}" aria-hidden="true"></span>
      <span class="befehl-eintrag-text">
        <span class="befehl-eintrag-label">${h(b.label)}</span>
        ${b.hint ? `<span class="befehl-eintrag-hint">${h(b.hint)}</span>` : ''}
      </span>
      ${
        drill
          ? `<span class="befehl-eintrag-meta befehl-drill" aria-hidden="true">›</span>`
          : b.meta
            ? `<span class="befehl-eintrag-meta">${h(b.meta)}</span>`
            : ''
      }
    </button>`)
  })
  liste.innerHTML = teile.join('')
  markiereBefehl(zustand.befehl.index, { scroll: true })
}

function aktualisiereBefehle() {
  zustand.befehl.treffer = filtereBefehle(zustand.befehl.query)
  if (zustand.befehl.index >= zustand.befehl.treffer.length) {
    zustand.befehl.index = Math.max(0, zustand.befehl.treffer.length - 1)
  }
  rendereBefehlsliste()
}

function setzeBefehlEbene(ebene, projekt = null) {
  zustand.befehl.ebene = ebene
  zustand.befehl.projekt = projekt
  zustand.befehl.query = ''
  zustand.befehl.index = 0
  const eingabe = $('#befehl-eingabe')
  if (eingabe) eingabe.value = ''
  aktualisiereBefehle()
  requestAnimationFrame(() => {
    eingabe?.focus()
  })
}

function oeffneBefehlProjekt(name) {
  if (!findeProjekt(name)) return
  setzeBefehlEbene('projekt', name)
}

function befehlEineEbeneZurueck() {
  if (zustand.befehl.ebene !== 'projekt') return false
  setzeBefehlEbene('root')
  return true
}

function oeffneBefehl() {
  const dlg = befehlDialog()
  if (!dlg) return
  // Andere Modals schließen — die Palette braucht den Fokus allein.
  for (const id of ['protokoll', 'datei', 'bestaetigung', 'eingabe']) {
    const ander = $(`#${id}`)
    if (ander?.open) {
      if (id === 'bestaetigung' || id === 'eingabe') ander.returnValue = 'cancel'
      ander.close()
    }
  }
  zustand.befehl.ebene = 'root'
  zustand.befehl.projekt = null
  zustand.befehl.query = ''
  zustand.befehl.index = 0
  const eingabe = $('#befehl-eingabe')
  if (eingabe) eingabe.value = ''
  aktualisiereBefehle()
  if (typeof dlg.showModal === 'function') dlg.showModal()
  else dlg.setAttribute('open', '')
  requestAnimationFrame(() => {
    eingabe?.focus()
    eingabe?.select()
  })
}

function schliesseBefehl() {
  const dlg = befehlDialog()
  if (dlg?.open) dlg.close()
  zustand.befehl.ebene = 'root'
  zustand.befehl.projekt = null
  zustand.befehl.query = ''
  zustand.befehl.index = 0
}

async function fuehreBefehlAus(index = zustand.befehl.index) {
  const befehl = zustand.befehl.treffer[index]
  if (!befehl) return
  // Drill-down bleibt in der Palette.
  if (befehl.art === 'projekt' && befehl.projekt) {
    oeffneBefehlProjekt(befehl.projekt)
    return
  }
  schliesseBefehl()
  try {
    await befehl.ausfuehren()
  } catch (err) {
    zeigeFehler(err.message)
  }
}

async function aktionAusfuehren(aktion, kontext = {}, knopf = null) {
  const { projekt, profil, prozess, pfad, oeffnenZiel } = kontext
  const koerper = (extra = {}) => ({
    method: 'POST',
    body: JSON.stringify({ profile: profil ?? 'default', ...extra })
  })

  switch (aktion) {
    case 'befehl':
      return oeffneBefehl()
    case 'detail':
      return oeffneDetail(projekt)
    case 'start':
      return handle(knopf, () => api(`/api/projects/${encodeURIComponent(projekt)}/up`, koerper()))
    case 'stopp':
      return handle(knopf, () => api(`/api/projects/${encodeURIComponent(projekt)}/down`, koerper()))
    case 'neu':
      return handle(knopf, () => api(`/api/projects/${encodeURIComponent(projekt)}/restart`, koerper()))
    case 'aufnehmen':
      return handle(knopf, async () => {
        await api(`/api/projects/${encodeURIComponent(projekt)}/adopt`, { method: 'POST', body: '{}' })
        const ergebnis = await api('/api/sync', { method: 'POST', body: JSON.stringify({ project: projekt }) })
        zeigeSyncBericht(ergebnis, { titel: `Slot vergeben · Agent-Dateien für ${projekt}` })
      })
    case 'anzeigename': {
      const aktuell = zustand.daten?.projects.find((p) => p.name === projekt)
      const vorschlag = aktuell?.displayName || aktuell?.suggestedDisplayName || projekt
      const neu = await frageEingabe({
        titel: 'Anzeigename',
        text: `Für „${projekt}“. Leer lassen setzt die Ableitung bzw. den Ordnernamen.`,
        label: 'Anzeigename',
        wert: vorschlag,
        hinweis: aktuell?.suggestedDisplayName
          ? `Vorschlag aus dem Projekt: ${aktuell.suggestedDisplayName}`
          : '',
        okLabel: 'Speichern'
      })
      if (neu === null) return
      return handle(knopf, () =>
        api(`/api/projects/${encodeURIComponent(projekt)}/display-name`, {
          method: 'POST',
          body: JSON.stringify({ displayName: neu.trim() })
        })
      )
    }
    case 'alle-stoppen':
      return handle(knopf, () => api('/api/down-all', { method: 'POST', body: '{}' }))
    case 'hub-log':
      return oeffneVerlauf()
    case 'sync-projekt':
      return handle(knopf, async () => {
        const ergebnis = await api('/api/sync', { method: 'POST', body: JSON.stringify({ project: projekt }) })
        zeigeSyncBericht(ergebnis, { titel: `Agent-Dateien · ${projekt}` })
      })
    case 'vergessen': {
      const wahl = await frageSlotEntfernen(projekt)
      if (!wahl.ok) return
      return handle(knopf, async () => {
        const ergebnis = await api(`/api/projects/${encodeURIComponent(projekt)}/forget`, {
          method: 'POST',
          body: JSON.stringify({ unsync: true, cleanDeps: wahl.cleanDeps })
        })
        zustand.projekt = null
        zustand.agenten = null
        zustand.agentenProjekt = null
        schliesseDateiVorschau()
        await geheZu('/', { ersetzen: true })
        const cleanHinweis = (ergebnis.clean?.removed ?? []).map((r) => `gelöscht     ${r.name}`)
        const unsync = {
          results: [
            {
              project: projekt,
              path: ergebnis.unsync?.path ?? '',
              changes: ergebnis.unsync?.changes ?? [],
              log: [...(ergebnis.unsync?.log ?? []), ...cleanHinweis],
              instances: []
            }
          ]
        }
        zeigeSyncBericht(unsync, {
          titel: `Slot ${ergebnis.slot} entfernt · ${projekt}`,
          vorspann: [
            ergebnis.slotHinweis,
            ...(wahl.cleanDeps
              ? ergebnis.clean?.removed?.length
                ? [`Dependencies: ${ergebnis.clean.removed.map((r) => r.name).join(', ')} gelöscht`]
                : ['Dependencies: nichts zu löschen']
              : [])
          ]
        })
      })
    }
    case 'editor':
      return handle(null, () => api('/api/open', { method: 'POST', body: JSON.stringify({ project: projekt }) }))
    case 'finder':
      return handle(null, () =>
        api('/api/open', { method: 'POST', body: JSON.stringify({ project: projekt, finder: true }) })
      )
    case 'pfad-oeffnen':
      return handle(knopf, () => oeffnePfad(pfad, { finder: oeffnenZiel === 'finder' }))
    case 'datei-schliessen':
      schliesseDateiVorschau()
      return
    case 'log':
      return oeffneLog(projekt, { profil: profil ?? 'default', prozess: prozess ?? null })
    case 'log-prozess':
      zustand.log.prozess = prozess
      await geheZu(urlFuer({ ansicht: 'log', projekt: zustand.projekt, log: zustand.log }), {
        ersetzen: true
      })
      return
    case 'agent-datei':
      return ladeDateiVorschau(pfad)
    case 'verknuepfen':
      return handle(knopf, async () => {
        await api(`/api/projects/${encodeURIComponent(projekt)}/link`, { method: 'POST', body: '{}' })
        zustand.agentenProjekt = null
        await ladeAgenten(projekt)
        rendereDetail()
      })
    case 'vorschau-zu':
      schliesseDateiVorschau()
      return
  }
}

// ------------------------------------------------------------------ Ereignisse

document.addEventListener('click', async (ereignis) => {
  for (const offen of document.querySelectorAll('details.menu[open]')) {
    if (!offen.contains(ereignis.target)) offen.open = false
  }

  const routeLink = ereignis.target.closest('[data-route]')
  if (routeLink && !ereignis.metaKey && !ereignis.ctrlKey && !ereignis.shiftKey && !ereignis.altKey) {
    ereignis.preventDefault()
    return geheZu(routeLink.getAttribute('data-route') || routeLink.getAttribute('href') || '/')
  }

  const befehlKnopf = ereignis.target.closest('[data-befehl-index]')
  if (befehlKnopf && befehlOffen()) {
    const index = Number(befehlKnopf.dataset.befehlIndex)
    if (Number.isFinite(index)) return fuehreBefehlAus(index)
  }

  const einst = ereignis.target.closest('[data-einst]')
  if (einst && $('#einstellungen')?.contains(einst)) {
    const art = einst.dataset.einst
    if (art === 'root-dazu') {
      const input = $('#einst-root-input')
      const roh = String(input?.value ?? '').trim()
      if (!roh) {
        input?.focus()
        return
      }
      syncEinstellungenDraftAusForm()
      const draft = zustand.einstellungen.draft
      if (!draft.roots.includes(roh)) {
        // Rohtext behalten — der Server expandiert ~/…
        draft.roots = [...draft.roots, roh]
      }
      if (input) input.value = ''
      zustand.einstellungen.hinweis = ''
      rendereEinstellungen()
      $('#einst-root-input')?.focus()
      return
    }
    if (art === 'root-weg') {
      const index = Number(einst.dataset.index)
      syncEinstellungenDraftAusForm()
      const draft = zustand.einstellungen.draft
      if (Number.isFinite(index) && draft && draft.roots.length > 1) {
        draft.roots = draft.roots.filter((_, i) => i !== index)
      }
      zustand.einstellungen.hinweis = ''
      rendereEinstellungen()
      return
    }
    if (art === 'theme-set') {
      setzeTheme(einst.dataset.theme === 'light' ? 'light' : 'dark')
      return
    }
    if (art === 'zuruecksetzen') {
      if (!zustand.einstellungen.geladen) return
      zustand.einstellungen.draft = einstellungenKlon(zustand.einstellungen.geladen)
      zustand.einstellungen.dirty = false
      zustand.einstellungen.hinweis = ''
      rendereEinstellungen()
      return
    }
    if (art === 'speichern') {
      ereignis.preventDefault()
      return speichereEinstellungen()
    }
  }

  const ziel = ereignis.target.closest('[data-aktion]')
  if (!ziel) return

  const menu = ziel.closest('details.menu')
  if (menu && ziel.dataset.aktion) menu.open = false

  const { aktion, projekt, profil, prozess, pfad, ziel: oeffnenZiel } = ziel.dataset
  return aktionAusfuehren(aktion, { projekt, profil, prozess, pfad, oeffnenZiel }, ziel)
})

document.addEventListener('submit', (ereignis) => {
  if (ereignis.target?.id === 'einst-form') {
    ereignis.preventDefault()
    return speichereEinstellungen()
  }
})

document.addEventListener('input', (ereignis) => {
  if (ereignis.target.closest?.('#einst-form')) syncEinstellungenDraftAusForm()
})

document.addEventListener('change', (ereignis) => {
  if (ereignis.target.id === 'folgen') zustand.log.folgen = ereignis.target.checked
  if (ereignis.target.closest?.('#einst-form')) syncEinstellungenDraftAusForm()
})

document.addEventListener('toggle', (ereignis) => {
  const sektion = ereignis.target
  if (!(sektion instanceof HTMLDetailsElement)) return
  if (!sektion.matches('[data-einst-sektion]')) return
  if (!$('#einstellungen')?.contains(sektion)) return
  setzeEinstSektion(sektion.dataset.einstSektion, sektion.open)
  planeEinstDockScrim()
})

$('#befehl-eingabe')?.addEventListener('input', (ereignis) => {
  zustand.befehl.query = ereignis.target.value
  zustand.befehl.index = 0
  aktualisiereBefehle()
})

document.addEventListener('keydown', (ereignis) => {
  if (ereignis.key === 'Enter' && ereignis.target?.id === 'einst-root-input') {
    ereignis.preventDefault()
    document.querySelector('[data-einst="root-dazu"]')?.click()
    return
  }

  const tippt =
    ereignis.target instanceof HTMLElement &&
    (ereignis.target.matches('input, textarea, select') || ereignis.target.isContentEditable)

  const meta = ereignis.metaKey || ereignis.ctrlKey
  if (
    meta &&
    !ereignis.altKey &&
    !ereignis.shiftKey &&
    ereignis.key.toLowerCase() === 's' &&
    zustand.ansicht === 'einstellungen'
  ) {
    ereignis.preventDefault()
    if (einstellungenDirty() && !zustand.einstellungen.speichern) return speichereEinstellungen()
    return
  }
  if (meta && !ereignis.altKey && !ereignis.shiftKey && ereignis.key.toLowerCase() === 'k') {
    ereignis.preventDefault()
    if (befehlOffen()) schliesseBefehl()
    else oeffneBefehl()
    return
  }

  if (befehlOffen()) {
    const n = zustand.befehl.treffer.length
    const eingabe = $('#befehl-eingabe')
    const queryLeer = !(eingabe?.value ?? zustand.befehl.query)

    if (ereignis.key === 'ArrowDown') {
      ereignis.preventDefault()
      if (!n) return
      markiereBefehl((zustand.befehl.index + 1) % n, { scroll: true })
      return
    }
    if (ereignis.key === 'ArrowUp') {
      ereignis.preventDefault()
      if (!n) return
      markiereBefehl((zustand.befehl.index - 1 + n) % n, { scroll: true })
      return
    }
    if (ereignis.key === 'Enter') {
      ereignis.preventDefault()
      return fuehreBefehlAus()
    }
    // Leere Ebene-2-Eingabe: Backspace/← geht eine Ebene hoch statt zu löschen.
    if (
      queryLeer &&
      zustand.befehl.ebene === 'projekt' &&
      (ereignis.key === 'Backspace' || ereignis.key === 'ArrowLeft')
    ) {
      ereignis.preventDefault()
      befehlEineEbeneZurueck()
      return
    }
    if (ereignis.key === 'Escape') {
      ereignis.preventDefault()
      if (befehlEineEbeneZurueck()) return
      schliesseBefehl()
      return
    }
    return
  }

  if (ereignis.key === '/' && !tippt && !ereignis.metaKey && !ereignis.ctrlKey && !ereignis.altKey) {
    if (dateiDialog()?.open || $('#protokoll')?.open || $('#bestaetigung')?.open || $('#eingabe')?.open) {
      return
    }
    ereignis.preventDefault()
    oeffneBefehl()
  }
})

document.addEventListener('toggle', (ereignis) => {
  const panel = ereignis.target
  if (!(panel instanceof HTMLDetailsElement)) return
  if (panel.matches('#detail details.enthüllung[data-panel]')) {
    zustand.detailPanels[panel.dataset.panel] = panel.open
    return
  }
  if (panel.matches('#kandidaten details.kandidaten[data-gruppe]')) {
    zustand.gruppenOffen[panel.dataset.gruppe] = panel.open
    return
  }
  if (panel.matches('details.menu') && !panel.open && zustand._listeWartet) {
    zustand._listeWartet = false
    if (zustand.ansicht === 'uebersicht') rendereUebersicht()
    if (zustand.ansicht === 'detail') rendereDetail()
  }
}, true)

addEventListener('scroll', planeEinstDockScrim, { passive: true })
addEventListener('resize', planeEinstDockScrim, { passive: true })

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stoppePolling()
    return
  }
  pollSofort()
  startePolling()
})

window.addEventListener('popstate', () => {
  if (hatUngespeicherteEinstellungen()) {
    const ok = confirm('Einstellungen haben ungespeicherte Änderungen. Trotzdem verlassen?')
    if (!ok) {
      history.pushState(null, '', '/einstellungen')
      return
    }
    zustand.einstellungen.draft = einstellungenKlon(zustand.einstellungen.geladen)
    zustand.einstellungen.dirty = false
    zustand.einstellungen.hinweis = ''
  }
  wendeRouteAn()
})

window.addEventListener('beforeunload', (ereignis) => {
  if (!hatUngespeicherteEinstellungen()) return
  ereignis.preventDefault()
  ereignis.returnValue = ''
})

const dateiDlg = dateiDialog()
if (dateiDlg) {
  dateiDlg.addEventListener('close', () => {
    zustand.vorschau = null
  })
  dateiDlg.addEventListener('click', (ereignis) => {
    if (ereignis.target === dateiDlg) dateiDlg.close()
  })
}

const bestaetigungDlg = $('#bestaetigung')
if (bestaetigungDlg) {
  bestaetigungDlg.addEventListener('click', (ereignis) => {
    if (ereignis.target === bestaetigungDlg) {
      bestaetigungDlg.returnValue = 'cancel'
      bestaetigungDlg.close()
    }
  })
}

const eingabeDlg = $('#eingabe')
if (eingabeDlg) {
  eingabeDlg.addEventListener('click', (ereignis) => {
    if (ereignis.target === eingabeDlg) {
      eingabeDlg.returnValue = 'cancel'
      eingabeDlg.close()
    }
  })
}

const befehlDlg = befehlDialog()
if (befehlDlg) {
  befehlDlg.addEventListener('click', (ereignis) => {
    if (ereignis.target === befehlDlg) {
      schliesseBefehl()
      return
    }
    if (ereignis.target.closest('#befehl-zurueck')) {
      befehlEineEbeneZurueck()
    }
  })
  befehlDlg.addEventListener('mousemove', (ereignis) => {
    const eintrag = ereignis.target.closest('[data-befehl-index]')
    if (!eintrag || !befehlDlg.contains(eintrag)) return
    const index = Number(eintrag.dataset.befehlIndex)
    if (!Number.isFinite(index) || index === zustand.befehl.index) return
    markiereBefehl(index)
  })
  befehlDlg.addEventListener('close', () => {
    zustand.befehl.ebene = 'root'
    zustand.befehl.projekt = null
    zustand.befehl.query = ''
    zustand.befehl.index = 0
  })
}

$('#liste').innerHTML = `<div class="skelett" aria-busy="true" aria-label="lädt">
  ${'<div class="skelett-zeile"></div>'.repeat(6)}
</div>`

await laden({ ohneRoute: true })
await wendeRouteAn()
zustand.listenSignatur = listenSignaturVon(zustand.daten)
zustand.fussSignatur = fussSignaturVon(zustand.daten)
startePolling()
