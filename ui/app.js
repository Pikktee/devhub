const $ = (selector) => document.querySelector(selector)

const h = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

const zustand = {
  daten: null,
  ansicht: 'uebersicht',
  projekt: null,
  filter: 'alle',
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

function zeigeProtokoll(text, titel = 'Protokoll') {
  $('#protokoll-titel').textContent = titel
  $('#protokoll-text').textContent = text
  const dlg = $('#protokoll')
  if (typeof dlg.showModal === 'function') dlg.showModal()
  else dlg.setAttribute('open', '')
}

function speicherBytes(bytes) {
  if (!bytes || bytes < 1024) return `${bytes || 0} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1).replace('.', ',')} GB`
}

/** Schicker Ersatz für window.confirm — inkl. Opt-in für Abhängigkeiten. */
function frageSlotEntfernen(projektName) {
  const dlg = $('#bestaetigung')
  const clean = $('#bestaetigung-clean')
  const hint = $('#bestaetigung-clean-hint')
  const option = $('#bestaetigung-option')

  $('#bestaetigung-titel').textContent = `Slot von „${projektName}“ entfernen?`
  $('#bestaetigung-text').textContent = 'Der Slot bleibt gesperrt und wird nicht neu vergeben.'
  $('#bestaetigung-liste').innerHTML = [
    'Hub-Blöcke in AGENTS.md sowie lokale Dateien (Cursor-Regel, launch.json) werden entfernt',
    'Der Dev-Server wird weder gestartet noch gestoppt'
  ]
    .map((t) => `<li>${h(t)}</li>`)
    .join('')

  clean.checked = false
  hint.textContent = 'node_modules, .next und ähnliche Caches — Größe wird ermittelt …'
  option.hidden = false

  let veraltet = false
  api(`/api/projects/${encodeURIComponent(projektName)}/artifacts`)
    .then((daten) => {
      if (veraltet) return
      if (!daten.items?.length) {
        hint.textContent = 'Keine node_modules/.next o. Ä. gefunden — Option ändert nichts'
        return
      }
      const namen = [...new Set(daten.items.map((i) => i.name))].join(', ')
      hint.textContent = `${speicherBytes(daten.bytes)} in ${daten.items.length} Ordner${daten.items.length === 1 ? '' : 'n'} (${namen})`
    })
    .catch(() => {
      if (!veraltet) hint.textContent = 'node_modules, .next und ähnliche Caches'
    })

  return new Promise((resolve) => {
    const fertig = () => {
      veraltet = true
      dlg.removeEventListener('close', fertig)
      if (dlg.returnValue === 'ok') resolve({ ok: true, cleanDeps: clean.checked })
      else resolve({ ok: false, cleanDeps: false })
    }
    dlg.addEventListener('close', fertig)
    if (typeof dlg.showModal === 'function') dlg.showModal()
    else dlg.setAttribute('open', '')
    $('#bestaetigung-ok')?.focus()
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
  return { kopf, text: lines.join('\n') || 'Keine Einträge.' }
}

function zeigeSyncBericht(ergebnis, optionen = {}) {
  const { kopf, text } = formatSyncProtokoll(ergebnis, optionen)
  zeigeProtokoll(text, kopf)
  const geaendert = syncAenderungen(ergebnis).filter((z) => z.changed).length
  zeigeOk(geaendert ? `${geaendert} Datei${geaendert === 1 ? '' : 'en'} · Details im Protokoll` : 'Bereits aktuell')
}

async function handle(knopf, arbeit) {
  const vorher = knopf?.textContent
  if (knopf) {
    knopf.disabled = true
    knopf.textContent = '…'
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
      knopf.textContent = vorher
    }
  }
}

// ------------------------------------------------------------------ Format

const dauer = (iso) => {
  if (!iso) return '—'
  const ms = Date.now() - new Date(iso)
  const min = Math.floor(ms / 60000)
  if (min < 1) return 'gerade eben'
  if (min < 60) return `seit ${min} min`
  const std = Math.floor(min / 60)
  if (std < 24) return min % 60 ? `seit ${std} h ${min % 60} min` : `seit ${std} h`
  return `seit ${Math.floor(std / 24)} Tagen`
}

const speicher = (n) => {
  if (!n) return ''
  const mb = n / (1024 * 1024)
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`
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

function sternHtml(projekt) {
  return `<button class="stern" data-aktion="favorit" data-projekt="${h(projekt.name)}" aria-pressed="${projekt.favorite ? 'true' : 'false'}" title="${projekt.favorite ? 'Favorit entfernen' : 'Als Favorit markieren'}">${projekt.favorite ? '★' : '☆'}</button>`
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
    ${sternHtml(projekt)}
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
    <span>Projekt</span>
    <span>Adresse</span>
    <span>Zustand</span>
    <span></span>
  </div>`
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
  const adresse = profil.processes[0]?.url
  const konflikt = profil.processes.some((p) => p.foreign)
  const speicherSumme = profil.processes.reduce((s, p) => s + (p.memory ?? 0), 0)

  const zustandText = laeuft
    ? [dauer(profil.startedAt), speicher(speicherSumme)].filter(Boolean).join(' · ')
    : projekt.adopted
      ? 'gestoppt'
      : 'kein Slot'

  const primaer = !projekt.adopted
    ? `<button class="knopf primaer" data-aktion="aufnehmen" data-projekt="${h(projekt.name)}" title="Vergibt einen festen Port und schreibt die Agent-Dateien">Slot vergeben</button>`
    : laeuft
      ? `<button class="knopf gefahr" data-aktion="stopp" data-projekt="${h(projekt.name)}" data-profil="${h(profil.profile)}">Stoppen</button>`
      : `<button class="knopf primaer" data-aktion="start" data-projekt="${h(projekt.name)}" data-profil="${h(profil.profile)}">Starten</button>`

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

  return `<div class="zeile${konflikt ? ' warnung' : ''}">
    <span class="${konflikt ? 'punkt warnung' : punktKlasse(profil.state)}"></span>
    ${nameHtml(projekt, '', { title: nameTitel || undefined })}
    ${adresse ? `<a class="adr${laeuft ? '' : ' aus'}" href="${h(adresse)}" target="_blank" rel="noreferrer">${h(adresse.replace(/^https?:\/\//, ''))}</a>` : '<span class="adr aus">—</span>'}
    <span class="meta">${h(zustandText)}</span>
    <span class="aktionen">${primaer}${menu}</span>
    ${hinweis}
  </div>`
}

function ohneStartHtml(projekt) {
  const hinweis = projekt.problems[0] ?? 'Kein Server erkennbar'
  const kurz =
    /Sammelordner/.test(hinweis) ? 'Sammelordner'
    : /liegt in /.test(hinweis) ? 'Unterordner'
    : /Python/.test(hinweis) ? 'braucht dev.json'
    : /Kein Server/.test(hinweis) ? 'kein Server'
    : 'braucht dev.json'
  const art = projekt.stack?.framework ?? projekt.stack?.kind
  return `<div class="zeile">
    <span class="punkt"></span>
    ${nameHtml(projekt, '', { title: art || undefined })}
    <span class="adr aus">—</span>
    <span class="meta" title="${h(hinweis)}">${h(kurz)}</span>
    <span class="aktionen">
      <button class="knopf" data-aktion="detail" data-projekt="${h(projekt.name)}">Ansehen</button>
      ${zeilenMenu(projekt, { mitAnsehen: false })}
    </span>
  </div>`
}

function passtZuFilter(projekt, profil) {
  if (!passtZurSuche(projekt)) return false
  if (zustand.filter === 'laufend') return profil.state === 'läuft' || profil.state === 'teilweise'
  if (zustand.filter === 'gestoppt') return projekt.adopted && profil.state === 'gestoppt'
  if (zustand.filter === 'ohne-port') return !projekt.adopted
  return true
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

/** Getrennt von der Hauptliste: zugeklappt ohne Sektionslabel „Kein Port“. */
function kandidatenAufklappHtml(zeilen) {
  if (!zeilen.length) return ''

  let offen = zustand.gruppenOffen['kein-port']
  if (offen === undefined) offen = false
  if (zustand.suche) offen = true

  const n = zeilen.length
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
      ${zeilen.join('')}
    </div>
  </details>`
}

function rendereUebersicht() {
  const daten = zustand.daten
  if (!daten) return

  gruppenOffenMerken()
  rendereFuss()

  const zaehlen = { alle: 0, laufend: 0, gestoppt: 0, 'ohne-port': 0 }
  for (const projekt of daten.projects) {
    if (!projekt.profiles.length) {
      zaehlen.alle++
      zaehlen['ohne-port']++
      continue
    }
    for (const profil of projekt.profiles) {
      zaehlen.alle++
      if (!projekt.adopted) zaehlen['ohne-port']++
      else if (profil.state === 'läuft' || profil.state === 'teilweise') zaehlen.laufend++
      else zaehlen.gestoppt++
    }
  }
  for (const chip of document.querySelectorAll('.filter .chip')) {
    const key = chip.dataset.filter
    const basis = { alle: 'Alle', laufend: 'Laufend', gestoppt: 'Gestoppt', 'ohne-port': 'Ohne Port' }[key]
    chip.textContent = `${basis} · ${zaehlen[key] ?? 0}`
    chip.setAttribute('aria-pressed', String(zustand.filter === key))
  }

  const favoriten = []
  const laufend = []
  const gestoppt = []
  const ohnePort = []

  for (const projekt of daten.projects) {
    // Ein Projekt ohne erkanntes Startkommando hat keine Profile — es darf
    // trotzdem nicht aus der Liste fallen, sonst sucht man es vergeblich.
    if (!projekt.profiles.length) {
      if (zustand.filter === 'laufend' || zustand.filter === 'gestoppt') continue
      if (!passtZurSuche(projekt)) continue
      const html = ohneStartHtml(projekt)
      if (projekt.favorite) favoriten.push(html)
      else ohnePort.push(html)
      continue
    }
    for (const profil of projekt.profiles) {
      if (!passtZuFilter(projekt, profil)) continue
      const html = zeileHtml(projekt, profil)
      if (projekt.favorite) {
        favoriten.push(html)
        continue
      }
      if (!projekt.adopted) ohnePort.push(html)
      else if (profil.state === 'läuft' || profil.state === 'teilweise') laufend.push(html)
      else gestoppt.push(html)
    }
  }

  const hatSlotGruppen = favoriten.length || laufend.length || gestoppt.length
  const kandidatenEl = $('#kandidaten')

  if (zustand.filter === 'ohne-port') {
    $('#liste').innerHTML = ohnePort.length
      ? listeKopfHtml() + ohnePort.join('')
      : listeKopfHtml() + leerHtml()
    if (kandidatenEl) kandidatenEl.innerHTML = ''
    return
  }

  const haupt = []
  if (favoriten.length) haupt.push(listeGruppe('Favoriten', favoriten))
  if (laufend.length) haupt.push(listeGruppe('Läuft', laufend))
  if (gestoppt.length) haupt.push(listeGruppe('Gestoppt', gestoppt))

  if (haupt.length) {
    $('#liste').innerHTML = listeKopfHtml() + haupt.join('')
  } else if (ohnePort.length && !zustand.suche) {
    $('#liste').innerHTML =
      listeKopfHtml() +
      `<div class="liste-intro">
        <strong>Noch keine Projekte mit Slot</strong>
        <p>Nimm ein Projekt auf, damit es hier mit festem Port erscheint. Kandidaten findest du darunter.</p>
      </div>`
  } else if (ohnePort.length && zustand.suche) {
    $('#liste').innerHTML =
      listeKopfHtml() +
      `<div class="liste-intro">
        <strong>Treffer ohne Slot</strong>
        <p>Passende Projekte ohne Slot sind in der Liste darunter.</p>
      </div>`
  } else {
    $('#liste').innerHTML = listeKopfHtml() + leerHtml()
  }

  if (kandidatenEl) kandidatenEl.innerHTML = kandidatenAufklappHtml(ohnePort)
}

function leerHtml() {
  const texte = {
    alle: {
      titel: 'Keine Projekte gefunden',
      text: zustand.suche
        ? `Keine Treffer für „${zustand.suche}“. Filter oder Suche anpassen.`
        : 'Unter ~/Dev wurden keine Kandidaten gefunden.'
    },
    laufend: {
      titel: 'Nichts läuft gerade',
      text: 'Starte ein Projekt über „Starten“, oder wechsle den Filter.'
    },
    gestoppt: {
      titel: 'Keine gestoppten Server',
      text: 'Aufgenommene Projekte, die gerade nicht laufen, erscheinen hier.'
    },
    'ohne-port': {
      titel: 'Alle Projekte haben einen Slot',
      text: 'Neue Ordner unter ~/Dev erscheinen hier, bis du sie aufnimmst.'
    }
  }
  const t = texte[zustand.filter] ?? texte.alle
  return `<div class="leer-box"><strong>${h(t.titel)}</strong><p>${h(t.text)}</p></div>`
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

  return `<div class="prozess">
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

  return `<section class="karte server-karte${haupt ? ' haupt' : ''}">
    <div class="karte-kopf">
      <div class="server-status">
        <span class="${punktKlasse(profil.state)}" aria-hidden="true"></span>
        <h3>${h(titel)}</h3>
        <span class="sub">${h(zustandLabel(profil))}</span>
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
    <button class="pfad-zelle" data-aktion="agent-datei" data-pfad="${h(eintrag.path)}">${h(eintrag.label)}${eintrag.directory ? '/' : ''}</button>
    <span class="meta">${h(groesse)} · ${h(eintrag.kind)}</span>
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
      <h2>${sternHtml(projekt)} <span class="detail-titel">${h(titel)}</span>${
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

  if (v.directory) {
    const kinder = v.children?.length
      ? v.children
          .map(
            (c) => `<button type="button" class="datei-eintrag" data-aktion="agent-datei" data-pfad="${h(c.path)}">
              <span class="datei-name">${h(c.name)}${c.directory ? '/' : ''}</span>
              <span class="hint">${c.directory ? 'Ordner' : 'Datei'}</span>
            </button>`
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
          <span class="meta" title="${h(daten.file)}">${h(daten.file)}</span>
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
        p.favorite ? 1 : 0,
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

    if (listeGleich) return

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

  const ziel = ereignis.target.closest('[data-aktion], [data-filter]')
  if (!ziel) return

  const menu = ziel.closest('details.menu')
  if (menu && ziel.dataset.aktion) menu.open = false

  if (ziel.dataset.filter) {
    zustand.filter = ziel.dataset.filter
    for (const chip of document.querySelectorAll('.filter .chip')) {
      chip.setAttribute('aria-pressed', String(chip === ziel))
    }
    return rendereUebersicht()
  }

  const { aktion, projekt, profil, prozess, pfad } = ziel.dataset
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
    case 'favorit':
      return handle(null, () => api(`/api/projects/${encodeURIComponent(projekt)}/favorite`, { method: 'POST', body: '{}' }))
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
