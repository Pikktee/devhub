const $ = (selector) => document.querySelector(selector)

const h = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

const zustand = {
  daten: null,
  ansicht: 'uebersicht',
  projekt: null,
  suche: '',
  log: { profil: 'default', prozess: null, folgen: true },
  agenten: null,
  agentenProjekt: null,
  vorschau: null,
  detailPanels: {},
  gruppenOffen: {},
  listenSignatur: '',
  fussSignatur: '',
  logSignatur: '',
  pollTimer: null,
  ladenLaufend: false
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

async function zeigeHubLog() {
  try {
    const daten = await api('/api/hub-log?lines=150')
    const text = daten.lines?.length ? daten.lines.join('\n') : 'Noch keine Einträge.'
    zeigeProtokollDialog({
      titel: 'Hub-Verlauf',
      rohtext: text,
      hinweisHtml: true,
      hinweis: daten.file
        ? `<span class="protokoll-datei-zeile"><span>Datei: <code title="${h(daten.file)}">${h(daten.file)}</code></span>${pfadAktionenHtml(daten.file, { kompakt: true })}</span>`
        : ''
    })
  } catch (err) {
    zeigeFehler(err.message)
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
    await laden()
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

function passtZurSuche(projekt) {
  if (!zustand.suche) return true
  const q = zustand.suche
  return (
    projekt.name.toLowerCase().includes(q) ||
    anzeigeName(projekt).toLowerCase().includes(q)
  )
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

  const mehr = []
  if (mitAnsehen) {
    mehr.push(menuKnopf('Details ansehen', { aktion: 'detail', projekt: projekt.name }))
  }

  return aktionenMenu([ort, server, mehr])
}

function zeileHtml(projekt, profil) {
  const laeuft = profil.state === 'läuft' || profil.state === 'teilweise'
  const adresse = profil.processes.find((p) => p.role === 'frontend')?.url ?? profil.processes[0]?.url
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

  return `<div class="zeile${konflikt ? ' warnung' : ''}" data-projekt="${h(projekt.name)}" data-profil="${h(profil.profile)}">
    <span class="${konflikt ? 'punkt warnung' : punktKlasse(profil.state)}"></span>
    <span class="power">${powerKnopfHtml(projekt, profil)}</span>
    ${nameHtml(projekt, '', { title: nameTitel || undefined })}
    ${adresse ? `<a class="adr${laeuft ? '' : ' aus'}" href="${h(adresse)}" target="_blank" rel="noreferrer">${h(adresse.replace(/^https?:\/\//, ''))}</a>` : '<span class="adr aus">—</span>'}
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
  return `<div class="zeile still" title="${h(hinweis)}">
    <span class="punkt"></span>
    <span class="power" aria-hidden="true"></span>
    ${nameHtml(projekt, '', { title: art ? `${art} · ${hinweis}` : hinweis })}
    <span class="adr aus">—</span>
    <span class="meta">${h(kurz)}</span>
    <span class="aktionen">${zeilenMenu(projekt, { mitAnsehen: true })}</span>
  </div>`
}

function rendereFuss() {
  const fuss = $('#fuss')
  const daten = zustand.daten
  if (!fuss || !daten) return

  $('#hub-adresse').textContent = location.host
  const s = daten.summary
  const teil = (html, warn = false) =>
    `<span class="fuss-teil${warn ? ' warn' : ''}">${html}</span>`
  const sep = '<span class="fuss-sep" aria-hidden="true">·</span>'

  fuss.innerHTML = [
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

/** Getrennt von der Hauptliste: zugeklappt. Nicht startbare Projekte hängen unten an. */
function kandidatenAufklappHtml(kandidaten, ohneStart = []) {
  if (!kandidaten.length && !ohneStart.length) return ''

  let offen = zustand.gruppenOffen['kein-port']
  if (offen === undefined) offen = false
  if (zustand.suche) offen = true

  const n = kandidaten.length + ohneStart.length
  const zu =
    n === 1 ? '1 Projekt ohne Slot anzeigen' : `${n} Projekte ohne Slot anzeigen`

  const stillTeil = ohneStart.length ? ohneStart.join('') : ''

  return `<details class="kandidaten" data-gruppe="kein-port"${offen ? ' open' : ''}>
    <summary>
      <span class="kandidaten-label kandidaten-zu">${h(zu)}</span>
      <span class="kandidaten-label kandidaten-auf">Ausblenden</span>
      <span class="gruppe-chevron" aria-hidden="true"></span>
    </summary>
    <div class="liste kandidaten-liste">
      ${listeKopfHtml()}
      ${kandidaten.join('')}
      ${stillTeil}
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
    if (!passtZurSuche(projekt)) continue
    // Kein Startkommando: kein Slot möglich — in der aufklappbaren Liste, unten und ruhig.
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
  } else if ((kandidaten.length || ohneStart.length) && !zustand.suche) {
    $('#liste').innerHTML =
      listeKopfHtml() +
      `<div class="liste-intro">
        <strong>Noch keine Projekte mit Slot</strong>
        <p>Nimm ein Projekt auf, damit es hier mit festem Port erscheint. Kandidaten findest du darunter.</p>
      </div>`
  } else if ((kandidaten.length || ohneStart.length) && zustand.suche) {
    $('#liste').innerHTML =
      listeKopfHtml() +
      `<div class="liste-intro">
        <strong>Treffer ohne Slot</strong>
        <p>Passende Projekte ohne Slot sind in der Liste darunter.</p>
      </div>`
  } else {
    $('#liste').innerHTML = listeKopfHtml() + leerHtml()
  }

  if (kandidatenEl) {
    kandidatenEl.innerHTML = kandidatenAufklappHtml(kandidaten, ohneStart)
  }
}

function leerHtml() {
  const titel = 'Keine Projekte gefunden'
  const text = zustand.suche
    ? `Keine Treffer für „${zustand.suche}“. Suche anpassen.`
    : 'Unter ~/Dev wurden keine Kandidaten gefunden.'
  return `<div class="leer-box"><strong>${h(titel)}</strong><p>${h(text)}</p></div>`
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
    </div>
    <span class="aktionen">
      ${
        proc.url && proc.listening
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

  const kopf = `<header class="detail-hero">
    <div class="detail-hero-text">
      <h2><span class="detail-titel">${h(titel)}</span>${
        titel === projekt.name ? '' : ` <span class="sub">${h(projekt.name)}</span>`
      }</h2>
      <div class="detail-meta">
        <span class="pfad" title="${h(projekt.path)}">${h(projekt.path)}</span>
        ${metaChips}
      </div>
    </div>
    <div class="detail-hero-aktionen">
      ${hauptProfil ? primaerAktionHtml(projekt, hauptProfil) : ''}
      ${detailMenu(projekt, hauptProfil)}
    </div>
  </header>`

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
    $('#log').innerHTML = `
      <header class="log-kopf">
        <h2>Log · ${h(titel)}</h2>
        <p class="log-untertitel">Ausgabe dieses Projekts${daten.process ? ` · Prozess <strong>${h(daten.process)}</strong>` : ''}</p>
      </header>
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

// ------------------------------------------------------------------ Routing

function routeAusUrl() {
  const teile = location.pathname.split('/').filter(Boolean).map(decodeURIComponent)
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
  if (zustand.ansicht === 'log' && name) document.title = `Log · ${name} · devhub`
  else if (zustand.ansicht === 'detail' && name) document.title = `${name} · devhub`
  else document.title = 'devhub'
}

function krumeTeil(label, { href, aktuell = false } = {}) {
  const titel = ` title="${h(label)}"`
  if (aktuell) {
    return `<li><span class="krume-aktuell" aria-current="page"${titel}>${h(label)}</span></li>`
  }
  return `<li><a class="krume-glied" href="${h(href)}" data-route="${h(href)}"${titel}>${h(label)}</a></li>`
}

function rendereKrume() {
  const nav = $('#krume')
  if (!nav) return

  if (zustand.ansicht === 'uebersicht' || !zustand.projekt) {
    nav.hidden = true
    nav.innerHTML = ''
    return
  }

  const projekt = zustand.daten?.projects.find((p) => p.name === zustand.projekt)
  const titel = projekt ? anzeigeName(projekt) : zustand.projekt
  const detailUrl = `/projekt/${encodeURIComponent(zustand.projekt)}`
  const teile = [krumeTeil('Übersicht', { href: '/' })]

  if (zustand.ansicht === 'log') {
    teile.push(krumeTeil(titel, { href: detailUrl }))
    teile.push(krumeTeil('Log', { aktuell: true }))
  } else {
    teile.push(krumeTeil(titel, { aktuell: true }))
  }

  nav.innerHTML = `<ol>${teile.join('')}</ol>`
  nav.hidden = false
}

function setzeAnsicht(ansicht) {
  zustand.ansicht = ansicht
  for (const id of ['uebersicht', 'detail', 'log']) $(`#${id}`).hidden = id !== ansicht
  if (ansicht === 'detail') rendereDetail()
  if (ansicht === 'log') rendereLog()
  if (ansicht === 'uebersicht') rendereUebersicht()
  rendereKrume()
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
    setzeAnsicht('uebersicht')
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

function geheZu(ziel, { ersetzen = false } = {}) {
  const url = typeof ziel === 'string' ? ziel : urlFuer(ziel)
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
                [proc.name, proc.role, proc.port ?? '', proc.listening ? 1 : 0, proc.pid ?? '', proc.foreign ? 1 : 0, proc.url ?? ''].join(':')
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

async function laden({ ohneRoute = false, ruhig = false } = {}) {
  if (zustand.ladenLaufend) return
  zustand.ladenLaufend = true
  try {
    const daten = await api('/api/overview?memory=1')
    zustand.daten = daten

    const listeNeu = listenSignaturVon(daten)
    const fussNeu = fussSignaturVon(daten)
    const listeGleich = ruhig && listeNeu === zustand.listenSignatur
    const fussGleich = ruhig && fussNeu === zustand.fussSignatur

    if (!fussGleich) {
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
    if (zustand.ansicht === 'detail') {
      rendereDetail()
      rendereKrume()
    }
  } catch (err) {
    if (!ruhig) zeigeFehler(`Hub antwortet nicht: ${err.message}`)
  } finally {
    zustand.ladenLaufend = false
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
    else laden({ ruhig: true })
  }, 5000)
}

async function pollSofort() {
  if (document.hidden) return
  if (zustand.ansicht === 'log') await rendereLog({ ruhig: true })
  else await laden({ ruhig: true })
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

  const ziel = ereignis.target.closest('[data-aktion]')
  if (!ziel) return

  const menu = ziel.closest('details.menu')
  if (menu && ziel.dataset.aktion) menu.open = false

  const { aktion, projekt, profil, prozess, pfad, ziel: oeffnenZiel } = ziel.dataset
  const koerper = (extra = {}) => ({ method: 'POST', body: JSON.stringify({ profile: profil ?? 'default', ...extra }) })

  switch (aktion) {
    case 'detail':
      return oeffneDetail(projekt)
    case 'start':
      return handle(ziel, () => api(`/api/projects/${encodeURIComponent(projekt)}/up`, koerper()))
    case 'stopp':
      return handle(ziel, () => api(`/api/projects/${encodeURIComponent(projekt)}/down`, koerper()))
    case 'neu':
      return handle(ziel, () => api(`/api/projects/${encodeURIComponent(projekt)}/restart`, koerper()))
    case 'aufnehmen':
      return handle(ziel, async () => {
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
      return handle(ziel, () =>
        api(`/api/projects/${encodeURIComponent(projekt)}/display-name`, {
          method: 'POST',
          body: JSON.stringify({ displayName: neu.trim() })
        })
      )
    }
    case 'alle-stoppen':
      return handle(ziel, () => api('/api/down-all', { method: 'POST', body: '{}' }))
    case 'hub-log':
      return zeigeHubLog()
    case 'sync-projekt':
      return handle(ziel, async () => {
        const ergebnis = await api('/api/sync', { method: 'POST', body: JSON.stringify({ project: projekt }) })
        zeigeSyncBericht(ergebnis, { titel: `Agent-Dateien · ${projekt}` })
      })
    case 'vergessen': {
      const wahl = await frageSlotEntfernen(projekt)
      if (!wahl.ok) return
      return handle(ziel, async () => {
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
      return handle(null, () => api('/api/open', { method: 'POST', body: JSON.stringify({ project: projekt, finder: true }) }))
    case 'pfad-oeffnen':
      return handle(ziel, () => oeffnePfad(pfad, { finder: oeffnenZiel === 'finder' }))
    case 'datei-schliessen':
      schliesseDateiVorschau()
      return
    case 'log':
      return oeffneLog(projekt, { profil: profil ?? 'default', prozess: prozess ?? null })
    case 'log-prozess':
      zustand.log.prozess = prozess
      await geheZu(urlFuer({ ansicht: 'log', projekt: zustand.projekt, log: zustand.log }), { ersetzen: true })
      return
    case 'agent-datei':
      return ladeDateiVorschau(pfad)
    case 'verknuepfen':
      return handle(ziel, async () => {
        await api(`/api/projects/${encodeURIComponent(projekt)}/link`, { method: 'POST', body: '{}' })
        zustand.agentenProjekt = null
        await ladeAgenten(projekt)
        rendereDetail()
      })
    case 'vorschau-zu':
      schliesseDateiVorschau()
      return
  }
})

document.addEventListener('change', (ereignis) => {
  if (ereignis.target.id === 'folgen') zustand.log.folgen = ereignis.target.checked
})

$('#suche').addEventListener('input', (ereignis) => {
  zustand.suche = ereignis.target.value.trim().toLowerCase()
  rendereUebersicht()
})

document.addEventListener('keydown', (ereignis) => {
  const tippt =
    ereignis.target instanceof HTMLElement &&
    (ereignis.target.matches('input, textarea, select') || ereignis.target.isContentEditable)

  if (ereignis.key === '/' && !tippt && !ereignis.metaKey && !ereignis.ctrlKey && !ereignis.altKey) {
    if (dateiDialog()?.open || $('#protokoll')?.open) return
    ereignis.preventDefault()
    $('#suche')?.focus()
    return
  }

  if (ereignis.key === 'Escape') {
    const suche = $('#suche')
    if (suche && document.activeElement === suche && suche.value) {
      suche.value = ''
      zustand.suche = ''
      rendereUebersicht()
    } else {
      suche?.blur()
    }
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
    if (zustand.ansicht === 'detail') {
      rendereDetail()
      rendereKrume()
    }
  }
}, true)

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stoppePolling()
    return
  }
  pollSofort()
  startePolling()
})

window.addEventListener('popstate', () => {
  wendeRouteAn()
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

$('#liste').innerHTML = `<div class="skelett" aria-busy="true" aria-label="lädt">
  ${'<div class="skelett-zeile"></div>'.repeat(6)}
</div>`

await laden({ ohneRoute: true })
await wendeRouteAn()
zustand.listenSignatur = listenSignaturVon(zustand.daten)
zustand.fussSignatur = fussSignaturVon(zustand.daten)
startePolling()
