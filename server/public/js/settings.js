// Ustawienia: monitory (CRUD, pauza, import z Pterodactyla), powiadomienia, wylogowanie.
import { api, auth } from './api.js';
import { state, upsert, remove, disconnectLive } from './store.js';
import { esc, icon, pill, toast, TYPE_LABEL, isIOS, isDesktopApp } from './util.js';
import { openModal, confirmDialog } from './modal.js';
import { pushSupport, pushStatus, enablePush, disablePush, sendTestPush } from './push.js';

let hostCache = null;
async function hostServices() {
  if (!state.me?.host) return null;
  hostCache ||= api('/host/services').then((r) => r.services).catch((e) => { hostCache = null; throw e; });
  return hostCache;
}

let pteroCache = null;
async function pteroServers(force = false) {
  if (!state.me?.ptero) return null;
  if (!pteroCache || force) pteroCache = api('/ptero/servers').then((r) => r.servers).catch((e) => { pteroCache = null; throw e; });
  return pteroCache;
}

export function renderSettings(root, params) {
  root.innerHTML = `<div class="settings">
    <section class="box">
      <div class="box-head"><h2>Monitory</h2>
        ${state.me?.ptero ? `<button class="btn" data-act="import">${icon('download')}Import z Pterodactyla</button>` : ''}
        <button class="btn primary" data-act="add">${icon('plus')}Dodaj</button></div>
      <div id="mlist-wrap"></div>
      ${!state.me?.ptero && !state.me?.host ? '<p class="muted" style="font-size:13px;margin:12px 0 0">Pterodactyl nie jest skonfigurowany — ustaw <code>PTERO_URL</code> i <code>PTERO_KEY</code> w pliku <code>.env</code> na serwerze, aby importować boty.</p>' : ''}
    </section>
    <section class="box" id="push-box"><h2>Powiadomienia</h2><p class="desc">Dostajesz powiadomienie tylko, gdy coś padnie albo wróci do działania.</p><div id="push-ui"><span class="spinner"></span></div></section>
    <section class="box"><h2>Konto</h2><p class="desc">Zalogowano jako administrator. Sesja jest ważna 30 dni.</p>
      <button class="btn danger" data-act="logout">${icon('logout')}Wyloguj</button></section>
  </div>`;

  root.querySelector('[data-act="add"]').addEventListener('click', () => monitorForm());
  root.querySelector('[data-act="import"]')?.addEventListener('click', importDialog);
  root.querySelector('[data-act="logout"]').addEventListener('click', logout);
  refreshSettingsList(root);
  renderPushUi(root.querySelector('#push-ui'));

  if (params?.get('edit')) {
    const m = state.monitors.get(Number(params.get('edit')));
    history.replaceState(null, '', '#/settings');
    if (m) monitorForm(m);
  }
}

function listHtml() {
  const monitors = [...state.monitors.values()];
  return `<div class="mlist">${monitors.length ? monitors.map((m) => `<div class="mrow" data-id="${m.id}">
          ${pill(m.status)}
          <div class="info"><div class="n">${esc(m.name)}</div><div class="t">${esc(TYPE_LABEL[m.type])} · ${esc(m.type === 'pterodactyl' ? m.pteroServerId : m.type === 'service' ? `usługa ${m.target}` : m.target)} · co ${m.intervalS} s</div></div>
          <div class="acts">
            <button class="btn small" data-act="edit">${icon('edit')}<span>Edytuj</span></button>
            <button class="btn small" data-act="pause">${icon(m.paused ? 'play' : 'pause')}<span>${m.paused ? 'Wznów' : 'Pauza'}</span></button>
            <button class="btn small danger" data-act="delete" aria-label="Usuń ${esc(m.name)}">${icon('trash')}</button>
          </div></div>`).join('') : '<p class="muted">Brak monitorów. Dodaj pierwszy!</p>'}</div>`;
}

/** Odświeża tylko listę monitorów (bez przebudowy sekcji powiadomień). */
export function refreshSettingsList(root) {
  const wrap = root.querySelector('#mlist-wrap');
  if (!wrap) return;
  wrap.innerHTML = listHtml();
  wrap.querySelectorAll('.mrow').forEach((row) => {
    const m = state.monitors.get(Number(row.dataset.id));
    row.querySelector('[data-act="edit"]').addEventListener('click', () => monitorForm(m));
    row.querySelector('[data-act="pause"]').addEventListener('click', async () => {
      try { upsert(await api(`/monitors/${m.id}/pause`, { method: 'POST', body: { paused: !m.paused } })); toast(m.paused ? `Wznowiono: ${m.name}` : `Wstrzymano: ${m.name}`); } catch (e) { toast(e.message, 'error'); }
    });
    row.querySelector('[data-act="delete"]').addEventListener('click', async () => {
      if (!await confirmDialog({ title: `Usunąć „${m.name}”?`, text: 'Historia i incydenty tego monitora zostaną usunięte.', ok: 'Usuń', danger: true })) return;
      try { await api(`/monitors/${m.id}`, { method: 'DELETE' }); remove(m.id); toast('Usunięto'); } catch (e) { toast(e.message, 'error'); }
    });
  });
}

async function renderPushUi(el) {
  if (isDesktopApp()) {
    el.innerHTML = `<div class="push-state">${pill('up').replace('Działa', 'Aktywne')} Powiadomienia Windows z aplikacji desktop</div>
      <p class="muted" style="font-size:13px">Aplikacja działa w tle (ikona w zasobniku) i pokazuje natywne powiadomienia systemu.</p>
      <button class="btn" data-act="local-test">${icon('bell')}Pokaż testowe powiadomienie</button>`;
    el.querySelector('[data-act="local-test"]').addEventListener('click', () => window.desktop.notify({ title: 'S7 Monitor: test powiadomień', body: 'Powiadomienia Windows działają 🎉' }));
    return;
  }
  const sup = pushSupport();
  if (!sup.ok) {
    const msg = {
      'ios-browser': `<b>Na iPhonie powiadomienia działają tylko w aplikacji z ekranu początkowego.</b><br>
         1. Stuknij ${icon('share', 'share-ico')} <b>Udostępnij</b> na dole Safari.<br>2. Wybierz <b>Do ekranu początkowego</b> → <b>Dodaj</b>.<br>
         3. Otwórz S7 Monitor z nowej ikony, zaloguj się i wróć tutaj. (Wymagany iOS 16.4 lub nowszy.)`,
      insecure: 'Powiadomienia wymagają połączenia HTTPS. Skonfiguruj certyfikat (patrz README).',
      unsupported: isIOS() ? 'Ta wersja iOS nie obsługuje powiadomień web push — zaktualizuj do iOS 16.4+.' : 'Ta przeglądarka nie obsługuje powiadomień push.',
    }[sup.reason];
    el.innerHTML = `<div class="alert info">${msg}</div>`;
    return;
  }
  let st;
  try { st = await pushStatus(); } catch (e) { el.innerHTML = `<div class="alert">${esc(e.message)}</div>`; return; }
  const on = st.subscribed && st.permission === 'granted';
  el.innerHTML = `<div class="push-state">${on ? pill('up').replace('Działa', 'Włączone') : pill('paused').replace('Pauza', 'Wyłączone')}
      <span class="sec">${on ? 'To urządzenie dostaje powiadomienia.' : st.permission === 'denied' ? 'Zablokowane w ustawieniach systemu.' : 'To urządzenie nie dostaje powiadomień.'}</span></div>
    <div class="btn-row">
      ${on ? `<button class="btn" data-act="test">${icon('bell')}Wyślij test</button><button class="btn" data-act="off">Wyłącz na tym urządzeniu</button>`
    : `<button class="btn primary" data-act="on" ${st.permission === 'denied' ? 'disabled' : ''}>${icon('bell')}Włącz powiadomienia</button>`}
    </div>`;
  el.querySelector('[data-act="on"]')?.addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    try { await enablePush(); toast('Powiadomienia włączone'); } catch (err) { toast(err.message, 'error'); }
    renderPushUi(el);
  });
  el.querySelector('[data-act="off"]')?.addEventListener('click', async () => { await disablePush(); toast('Wyłączono powiadomienia'); renderPushUi(el); });
  el.querySelector('[data-act="test"]')?.addEventListener('click', async (e) => {
    const b = e.currentTarget; b.disabled = true;
    try { const r = await sendTestPush(); toast(`Wysłano do ${r.sent} urządzeń${r.removed ? `, usunięto ${r.removed} nieaktywnych` : ''}`); } catch (err) { toast(err.message, 'error'); }
    b.disabled = false;
  });
}

async function logout() {
  try {
    if (pushSupport().ok && !isDesktopApp()) await disablePush().catch(() => {});
  } finally {
    auth.clear(); disconnectLive();
    location.hash = '#/login';
    location.reload();
  }
}

function monitorForm(m = null) {
  const v = m || { type: 'http', intervalS: 30, failThreshold: 2 };
  const modal = openModal(`<h2>${m ? 'Edytuj monitor' : 'Nowy monitor'}</h2>
    <form id="mform" novalidate>
      <div class="field"><label>Typ</label><div class="segmented" id="f-type">
        ${['http', 'fivem', 'pterodactyl', 'service'].filter((t) => t === v.type || (t === 'service' ? state.me?.host : t === 'pterodactyl' ? state.me?.ptero || !state.me?.host : true)).map((t) => `<button type="button" data-type="${t}" aria-pressed="${v.type === t}">${{ http: 'Strona', fivem: 'FiveM', pterodactyl: 'Bot (Ptero)', service: 'Usługa VPS' }[t]}</button>`).join('')}
      </div></div>
      <div class="field"><label for="f-name">Nazwa</label><input class="input" id="f-name" required maxlength="80" value="${esc(v.name || '')}" placeholder="np. Bot EMS"></div>
      <div class="field" data-for="http fivem"><label for="f-target" id="f-target-label">Adres</label><input class="input" id="f-target" value="${esc(v.target || '')}" inputmode="url" autocapitalize="off" spellcheck="false"><span class="hint" id="f-target-hint"></span></div>
      <div class="field" data-for="service"><label for="f-svc">Usługa na serwerze</label><div id="f-svc-wrap"><input class="input" id="f-svc" value="${esc(v.type === 'service' ? v.target || '' : '')}" placeholder="np. community-bot" autocapitalize="off" spellcheck="false"></div><span class="hint">Bot lub program działający na VPS-ie jako usługa systemowa.</span></div>
      <div class="field" data-for="pterodactyl http fivem"><label for="f-ptero" id="f-ptero-label">Serwer w Pterodactylu</label><div id="f-ptero-wrap"></div><span class="hint" id="f-ptero-hint"></span></div>
      <div class="grid-2">
        <div class="field"><label for="f-int">Interwał (s)</label><input class="input" id="f-int" type="number" min="10" max="3600" inputmode="numeric" value="${esc(v.intervalS)}"></div>
        <div class="field"><label for="f-thr">Próg awarii</label><input class="input" id="f-thr" type="number" min="1" max="20" inputmode="numeric" value="${esc(v.failThreshold)}"><span class="hint">nieudane sprawdzenia z rzędu</span></div>
      </div>
      <div class="grid-2" data-for="http">
        <div class="field"><label for="f-codes">Oczekiwane kody</label><input class="input" id="f-codes" value="${esc(v.expectedCodes || '')}" placeholder="200-399"></div>
        <div class="field"><label for="f-kw">Słowo kluczowe</label><input class="input" id="f-kw" value="${esc(v.keyword || '')}" placeholder="opcjonalne"></div>
      </div>
      <p class="error-msg" id="f-err" role="alert"></p>
      <div class="btn-row"><button type="button" class="btn" data-a="cancel">Anuluj</button><button class="btn primary" type="submit">${m ? 'Zapisz' : 'Dodaj'}</button></div>
    </form>`);
  const f = modal.el;
  let type = v.type;
  const pteroWrap = f.querySelector('#f-ptero-wrap');
  const setPteroInput = async () => {
    const cur = f.querySelector('#f-ptero')?.value ?? v.pteroServerId ?? '';
    const optional = type !== 'pterodactyl';
    f.querySelector('#f-ptero-label').textContent = optional ? 'Powiąż z Pterodactylem (opcjonalnie)' : 'Serwer w Pterodactylu';
    f.querySelector('#f-ptero-hint').textContent = optional ? 'Dodaje CPU/RAM i przyciski zasilania do tego monitora.' : '';
    let servers = null;
    try { servers = await pteroServers(); } catch { /* panel niedostępny */ }
    if (servers) {
      pteroWrap.innerHTML = `<select class="input" id="f-ptero">${optional ? '<option value="">— brak —</option>' : '<option value="">— wybierz —</option>'}
        ${servers.map((s) => `<option value="${esc(s.id)}" ${s.id === cur ? 'selected' : ''}>${esc(s.name)} (${esc(s.id)})</option>`).join('')}
        ${cur && !servers.find((s) => s.id === cur) ? `<option value="${esc(cur)}" selected>${esc(cur)}</option>` : ''}</select>`;
    } else {
      pteroWrap.innerHTML = `<input class="input" id="f-ptero" value="${esc(cur)}" placeholder="ID serwera, np. a1b2c3d4" autocapitalize="off" spellcheck="false">`;
    }
    if (type === 'pterodactyl') {
      f.querySelector('#f-ptero').addEventListener('change', (e) => {
        const s = servers?.find((x) => x.id === e.target.value);
        const name = f.querySelector('#f-name');
        if (s && !name.value) name.value = s.name;
      });
    }
  };
  const setServiceInput = async () => {
    let list = null;
    try { list = await hostServices(); } catch { /* agent niedostępny */ }
    if (!list || f.querySelector('select#f-svc')) return;
    const cur = f.querySelector('#f-svc')?.value || '';
    f.querySelector('#f-svc-wrap').innerHTML = `<select class="input" id="f-svc"><option value="">— wybierz —</option>
      ${list.map((s) => `<option value="${esc(s.id)}" ${s.id === cur ? 'selected' : ''}>${esc(s.label)}${s.kind === 'infra' ? '' : ` (${esc(s.unit)})`}</option>`).join('')}
      ${cur && !list.find((s) => s.id === cur) ? `<option value="${esc(cur)}" selected>${esc(cur)}</option>` : ''}</select>`;
    f.querySelector('#f-svc').addEventListener('change', (e) => {
      const s = list.find((x) => x.id === e.target.value);
      const name = f.querySelector('#f-name');
      if (s && !name.value) name.value = s.label;
    });
  };
  const sync = () => {
    f.querySelectorAll('#f-type button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.type === type)));
    f.querySelectorAll('[data-for]').forEach((el) => el.classList.toggle('hidden', !el.dataset.for.split(' ').includes(type)));
    f.querySelector('#f-target-label').textContent = type === 'fivem' ? 'Adres serwera FiveM' : 'Adres strony';
    f.querySelector('#f-target').placeholder = type === 'fivem' ? 'http://1.2.3.4:30120' : 'https://example.com';
    f.querySelector('#f-target-hint').textContent = type === 'fivem' ? 'IP i port serwera (domyślnie 30120).' : 'Pełny adres z https://';
    const pf = f.querySelector('[data-for~="pterodactyl"]');
    if ((!state.me?.ptero && type !== 'pterodactyl') || type === 'service') pf.classList.add('hidden');
    if (type === 'service') setServiceInput(); else setPteroInput();
  };
  f.querySelector('#f-type').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { type = b.dataset.type; sync(); } });
  f.querySelector('[data-a="cancel"]').addEventListener('click', () => modal.close());
  f.querySelector('#mform').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = f.querySelector('button[type="submit"]'); btn.disabled = true;
    const body = {
      name: f.querySelector('#f-name').value.trim(), type,
      target: type === 'service' ? f.querySelector('#f-svc').value.trim() : f.querySelector('#f-target').value.trim(),
      pteroServerId: type === 'service' ? null : f.querySelector('#f-ptero')?.value.trim() || null,
      intervalS: Number(f.querySelector('#f-int').value), failThreshold: Number(f.querySelector('#f-thr').value),
      expectedCodes: f.querySelector('#f-codes').value.trim() || null, keyword: f.querySelector('#f-kw').value || null,
    };
    try {
      const saved = await api(m ? `/monitors/${m.id}` : '/monitors', { method: m ? 'PUT' : 'POST', body });
      upsert(saved); modal.close(); toast(m ? 'Zapisano zmiany' : `Dodano: ${saved.name}`);
    } catch (err) { f.querySelector('#f-err').textContent = err.message; btn.disabled = false; }
  });
  sync();
}

async function importDialog() {
  const modal = openModal(`<h2>Import z Pterodactyla</h2><p class="sec" style="margin-top:-6px">Zaznacz serwery (boty), które chcesz monitorować.</p>
    <div id="imp-list"><div class="loading-block"><span class="spinner"></span></div></div>
    <p class="error-msg" id="imp-err"></p>
    <div class="btn-row"><button class="btn" data-a="cancel">Anuluj</button><button class="btn primary" data-a="ok" disabled>Importuj</button></div>`);
  const el = modal.el;
  el.querySelector('[data-a="cancel"]').addEventListener('click', () => modal.close());
  let servers;
  try { servers = await pteroServers(true); } catch (e) { el.querySelector('#imp-list').innerHTML = `<div class="alert">${esc(e.message)}</div>`; return; }
  if (!servers.length) { el.querySelector('#imp-list').innerHTML = '<div class="alert info">Klucz API nie ma dostępu do żadnego serwera.</div>'; return; }
  el.querySelector('#imp-list').innerHTML = `<div class="check-list">${servers.map((s) => `<label class="check-item ${s.monitored ? 'disabled' : ''}">
      <input type="checkbox" value="${esc(s.id)}" ${s.monitored ? 'disabled checked' : ''}>
      <div class="ci-text"><div><b>${esc(s.name)}</b></div><div class="muted" style="font-size:12px">${esc(s.id)}${s.node ? ` · ${esc(s.node)}` : ''}${s.monitored ? ' · już monitorowany' : ''}</div></div></label>`).join('')}</div>`;
  const ok = el.querySelector('[data-a="ok"]');
  const boxes = [...el.querySelectorAll('input:not(:disabled)')];
  const upd = () => { const n = boxes.filter((b) => b.checked).length; ok.disabled = !n; ok.textContent = n ? `Importuj (${n})` : 'Importuj'; };
  boxes.forEach((b) => b.addEventListener('change', upd));
  ok.addEventListener('click', async () => {
    ok.disabled = true;
    let done = 0;
    for (const b of boxes.filter((x) => x.checked)) {
      const s = servers.find((x) => x.id === b.value);
      try { upsert(await api('/monitors', { method: 'POST', body: { name: s.name, type: 'pterodactyl', pteroServerId: s.id } })); done++; } catch (e) { el.querySelector('#imp-err').textContent = e.message; }
    }
    pteroCache = null;
    toast(`Zaimportowano ${done} ${done === 1 ? 'serwer' : 'serwerów'}`);
    modal.close();
  });
}
