/* Daily Notes – features: encrypted quick-edit overlay + Outbox (sync-back), Week view, Weekly review & wins, Goals,
   Health & rest, Search, section nav and due-date pings. No personal data lives in this file; everything comes from the
   decrypted notes, the encrypted local overlay, or the habit tracker. Helpers come from app.js (window.DN) at render time. */
(function () {
  'use strict';
  const C = window.EditsCore;
  const LS = 'dn.overlay.v1', LS_LOCKED = 'dn.overlay.v1.locked', KIND = C.OVERLAY_KIND, EXPORT_KIND = C.KIND;
  const TZ = 'Asia/Manila';
  const D = () => window.DN;
  let key = null, salt = null, iter = null, O = null, raw = {}, merged = {}, missing = new Set(), saving = Promise.resolve();
  let lockedOld = false, ticker = null, clearedNote = 0, searchIndex = [], view = null;

  const rand = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, '0')).join('');
  const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const nowHM = () => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
  const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
  const weekStart = (iso) => addDays(iso, -((new Date(iso + 'T00:00:00Z').getUTCDay() + 6) % 7));
  const fmtD = (iso, o) => new Date(iso + 'T12:00:00Z').toLocaleDateString('en-GB', Object.assign({ timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }, o || {}));
  const isoOf = (s) => { const m = /(\d{4})-(\d{2})-(\d{2})/.exec(s == null ? '' : String(s)); return m ? m[0] : null; };

  /* ================= overlay (encrypted, same key as notes/habits) ================= */
  const fresh = () => ({ v: 1, device: 'd-' + rand(3), edits: [], tomb: {}, settings: { duePings: true }, pinged: {} });
  function normO(x) {
    const o = Object.assign(fresh(), x && typeof x === 'object' ? x : {});
    o.edits = Array.isArray(o.edits) ? o.edits.filter(C.validEdit) : [];
    o.settings = Object.assign({ duePings: true }, o.settings || {});
    o.pinged = o.pinged && typeof o.pinged === 'object' ? o.pinged : {};
    o.tomb = o.tomb && typeof o.tomb === 'object' && !Array.isArray(o.tomb) ? o.tomb : {};
    return o;
  }
  // Sync (sync.js): tell it when edits change (not for device-only things like pings/settings).
  let syncSig = '';
  const curSig = () => C.syncSig(O);
  function noteChange(quiet) { const sg = curSig(); if (sg !== syncSig) { syncSig = sg; if (!quiet && window.Sync) window.Sync.changed('edits'); } }
  // Remove edits matching pred, leaving a tombstone so other devices drop them too.
  function drop(pred) {
    const at = new Date().toISOString(); let n = 0;
    O.edits = O.edits.filter((e) => { if (!pred(e)) return true; O.tomb[e.eid] = at > str(e.at) ? at : str(e.at); n++; return false; });
    return n;
  }
  const str = (v) => (v == null ? '' : String(v));
  function save(quiet) {
    if (!key || !O) return saving;
    noteChange(quiet);
    const snap = JSON.parse(JSON.stringify(O)), k = key, sa = salt, it = iter;
    saving = saving.then(async () => localStorage.setItem(LS, JSON.stringify(await NotesCrypto.encryptJSON(k, snap, sa, it, KIND))))
      .catch((e) => { console.warn('overlay save failed', e); toast('⚠️ Could not save edits on this device'); });
    return saving;
  }
  // Drop edits that notes.json now reflects (Denx synced them).
  function prune() {
    if (!O) return 0;
    const n0 = O.edits.length;
    drop((e) => C.isReflected(raw, e));
    const n = n0 - O.edits.length;
    if (n) { clearedNote = n; save(); }
    return n;
  }
  async function unlock(k, env, notes) {
    raw = notes && typeof notes === 'object' ? notes : {};
    if (O && key === k && salt === env.salt) { prune(); return; }
    key = k; salt = env.salt; iter = env.iter; O = null; lockedOld = !!localStorage.getItem(LS_LOCKED);
    let blob = null;
    try { blob = JSON.parse(localStorage.getItem(LS)); } catch { /* corrupt → none */ }
    if (blob && blob.ct) {
      try { if (blob.salt !== salt) throw new Error('salt'); O = normO(await NotesCrypto.decryptJSON(k, blob, KIND)); }
      catch { localStorage.setItem(LS_LOCKED, JSON.stringify(blob)); lockedOld = true; } // never destroy what we can't read
    }
    if (!O) O = fresh();
    syncSig = curSig();
    prune(); save(); startTicker();
  }
  function lock() { lkEdit = null; lkQuery = ''; key = null; O = null; merged = {}; raw = {}; searchIndex = []; stopTicker(); }
  const ready = () => !!(O && key);
  const pending = () => (O ? O.edits.length : 0);

  function upsert(e) {
    O.edits = O.edits.filter((x) => x.eid !== e.eid);
    if (!C.isReflected(raw, e)) { O.edits.push(e); delete O.tomb[e.eid]; } else O.tomb[e.eid] = e.at;
    save(); D().rerender();
  }
  // Item edits (tick to-do, tasking status, bill paid). Setting an item back to its notes.json state removes the edit.
  function set({ sec, op, item, label, val }) {
    if (!ready()) return;
    const k = C.keyOf(sec, item);
    upsert({ eid: `${sec}:${op}:${k}`, sec, op, key: k, label: label || C.textOf(sec, item), labelText: C.textOf(sec, item), val, at: new Date().toISOString() });
  }
  function undo(sec, op, item) { if (!ready()) return; const k = C.keyOf(sec, item); drop((x) => x.eid === `${sec}:${op}:${k}`); save(); D().rerender(); }
  function add(kind, text, due) {
    if (!ready() || !text.trim()) return false;
    const id = 'loc-' + rand(4), sec = kind === 'todo' ? 'todo' : kind === 'reminder' ? 'reminders' : 'quick_notes';
    const val = sec === 'quick_notes' ? { id, text: text.trim(), date: due || today() } : Object.assign({ id, item: text.trim() }, due ? { due } : {});
    upsert({ eid: 'add:' + id, sec, op: 'add', key: 'id:' + id, label: text.trim(), val, at: new Date().toISOString() });
    return true;
  }
  function logHealth(sec, date, value) {
    if (!ready()) return;
    const f = sec === 'health.sleep' ? 'hours' : 'kg';
    upsert({ eid: `${sec}:log:${date}`, sec, op: 'log', key: 'd:' + date, label: `${date} ${value}`, val: { date, [f]: value }, at: new Date().toISOString() });
  }
  function merge(notes) {
    raw = notes && typeof notes === 'object' ? notes : {};
    if (!ready()) { merged = C.view(raw, today(), nowHM()); return merged; }
    prune();
    const r = C.apply(raw, O.edits, true);
    missing = new Set(r.missing.map((e) => e.eid));
    merged = C.view(r.notes, today(), nowHM()); // no alarms; past-dated to-dos/reminders/taskings count as done (see EditsCore.view)
    feedExercise(merged);
    return merged;
  }
  // Minutes per day from health.exercise → the Exercise habit (counts toward its daily target + weekly progress).
  function exerciseByDay(d) {
    const hh = d && d.health && typeof d.health === 'object' && !Array.isArray(d.health) ? d.health : {};
    const m = {};
    D().objs(hh.exercise, 'date').forEach((x) => { const iso = isoOf(x.date), mn = D().num(x.minutes ?? x.min ?? x.duration); if (iso && mn != null && mn > 0) m[iso] = (m[iso] || 0) + Math.round(mn); });
    return m;
  }
  function feedExercise(d) { if (window.Habits && window.Habits.setExternal && window.DN) { try { window.Habits.setExternal(exerciseByDay(d)); } catch (e) { console.warn(e); } } }
  /* Generic record edits (transactions, va.leads, links…): add / set / del through the Outbox. */
  const rawItemByKey = (sec, k) => { const i = C.findIndex(raw, { sec, key: k }); return i >= 0 ? C.listOf(raw, sec)[i] : null; };
  const pendingAddOf = (sec, it) => (it && it._local === 'added' && it.id ? O.edits.find((e) => e.sec === sec && e.op === 'add' && e.val && e.val.id === it.id) : null);
  const recKey = (sec, it) => (it && it._lkey) || C.keyOf(sec, it);
  function recAdd(sec, v, label) {
    if (!ready()) return null;
    const id = 'loc-' + rand(4);
    upsert({ eid: 'add:' + id, sec, op: 'add', key: 'id:' + id, label: label || C.textOf(sec, v), val: Object.assign({ id }, v), at: new Date().toISOString() });
    return id;
  }
  function recSet(sec, it, v, label) {
    if (!ready()) return false;
    const at = new Date().toISOString(), pa = pendingAddOf(sec, it);
    if (pa) { upsert(Object.assign({}, pa, { label: label || pa.label, val: Object.assign({ id: pa.val.id }, v), at })); return true; }
    const k = recKey(sec, it), r = rawItemByKey(sec, k), prev = O.edits.find((e) => e.eid === `${sec}:set:${k}`);
    upsert({ eid: `${sec}:set:${k}`, sec, op: 'set', key: k, label: prev ? prev.label : label || C.textOf(sec, r || it), labelText: prev ? prev.labelText : C.textOf(sec, r || it), val: v, at });
    return true;
  }
  function recDel(sec, it, label) {
    if (!ready()) return;
    const pa = pendingAddOf(sec, it);
    if (pa) { drop((e) => e.eid === pa.eid); save(); D().rerender(); return; }
    const k = recKey(sec, it), r = rawItemByKey(sec, k), prev = O.edits.find((e) => e.eid === `${sec}:set:${k}`);
    drop((e) => e.eid === `${sec}:set:${k}`);
    upsert({ eid: `${sec}:del:${k}`, sec, op: 'del', key: k, label: prev ? prev.label : label || C.textOf(sec, r || it), labelText: prev ? prev.labelText : C.textOf(sec, r || it), val: null, at: new Date().toISOString() });
  }
  // Simple keyed edits: progress values (WD1 / savings), VA daily counters, exercise + MPAT log entries.
  function setProgress(k, v) { if (!ready()) return; upsert({ eid: `progress:set:${k}`, sec: 'progress', op: 'set', key: k, label: k, val: v, at: new Date().toISOString() }); }
  function logVaDaily(date, sent, replies) { if (!ready()) return; upsert({ eid: `va.daily:log:${date}`, sec: 'va.daily', op: 'log', key: 'd:' + date, label: `${date} ${sent}/${replies}`, val: { date, sent, replies }, at: new Date().toISOString() }); }
  function logEntry(sec, v, label) { return recAdd(sec, v, label); }

  /* ================= small UI bits ================= */
  let toastEl = null;
  function toast(msg) {
    if (!toastEl) { toastEl = document.createElement('div'); toastEl.className = 'hb-toast'; toastEl.id = 'dn-toast'; toastEl.setAttribute('role', 'status'); document.body.append(toastEl); }
    toastEl.textContent = msg; toastEl.classList.add('show');
    clearTimeout(toastEl._t); toastEl._t = setTimeout(() => toastEl.classList.remove('show'), 2600);
  }
  const localChip = (it) => (it && typeof it === 'object' && it._local ? D().h('span', { class: 'chip local', title: 'Edited on this device – waiting for notes.json to catch up' }, '✎ this device') : null);
  function download(name, text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = D().h('a', { href: url, download: name }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* fallback below */ }
    try { const ta = D().h('textarea', { class: 'sr' }); ta.value = text; document.body.append(ta); ta.select(); const ok = document.execCommand('copy'); ta.remove(); return ok; } catch { return false; }
  }

  /* ================= Quick capture + Outbox ================= */
  function captureEl() {
    if (!ready()) return null;
    const { h } = D();
    let kind = 'todo';
    const seg = h('div', { class: 'seg qc-seg', role: 'radiogroup', 'aria-label': 'Type' });
    const kinds = [['todo', '✅ To-do'], ['reminder', '⏰ Reminder'], ['note', '🗒️ Note']];
    kinds.forEach(([k, l]) => seg.append(h('button', { type: 'button', role: 'radio', 'aria-checked': String(k === kind), 'data-v': k, class: k === kind ? 'on' : '',
      onclick: (e) => { kind = k; seg.querySelectorAll('button').forEach((b) => { b.classList.toggle('on', b === e.currentTarget); b.setAttribute('aria-checked', String(b === e.currentTarget)); }); } }, l)));
    const txt = h('input', { id: 'qc-text', type: 'text', placeholder: 'Type and add…', 'aria-label': 'Quick capture text', maxlength: '300', autocomplete: 'off' });
    const due = h('input', { id: 'qc-date', type: 'date', 'aria-label': 'Date (optional)' });
    const form = h('form', { class: 'qc', onsubmit: (e) => {
      e.preventDefault();
      if (!add(kind, txt.value, due.value || '')) { txt.focus(); return; }
      toast(kind === 'note' ? '🗒️ Note saved – syncing via the Outbox' : `➕ ${kind === 'todo' ? 'To-do' : 'Reminder'} added – syncing via the Outbox`);
    } }, seg, h('div', { class: 'qc-row' }, txt, due, h('button', { type: 'submit', class: 'qc-add' }, 'Add')));
    return h('div', { class: 'hero-cap', id: 'c-capture' }, h('p', { class: 'm-h' }, '✍️ Quick capture'), form, h('p', { class: 'small muted' }, 'Saved encrypted on this device · syncs via the Outbox'));
  }
  function exportPayload() { return { dn_edits: 1, device: O.device, exported: new Date().toISOString(), edits: O.edits.map(({ eid, sec, op, key: k, label, labelText, val, at }) => ({ eid, sec, op, key: k, label, labelText, val, at })) }; }
  function denxText() {
    const p = exportPayload();
    const when = new Date(p.exported).toLocaleString('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    return [`Daily Notes – ${p.edits.length} edit${p.edits.length === 1 ? '' : 's'} from my phone (${when} PHT). Please apply to notes.json:`,
      ...p.edits.map((e) => '• ' + C.describe(e)), '', 'JSON (tools/apply-edits.mjs):', JSON.stringify(p)].join('\n');
  }
  function outboxCard() {
    const { h, card, empty } = D();
    const n = pending();
    const list = n ? h('ul', { class: 'ob-list' }, O.edits.map((e) => h('li', { class: 'ob-item' + (missing.has(e.eid) ? ' miss' : '') },
      h('span', { class: 'ob-txt' }, C.describe(e), missing.has(e.eid) ? h('span', { class: 'chip m-unver' }, 'not in notes.json any more') : null,
        h('span', { class: 'ob-at' }, new Date(e.at).toLocaleString('en-GB', { timeZone: TZ, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }))),
      h('button', { type: 'button', class: 'icon', 'aria-label': 'Discard edit: ' + C.describe(e), onclick: () => { drop((x) => x.eid === e.eid); save(); D().rerender(); } }, '✕')))) : empty('Nothing pending — notes.json is up to date with this device. ✨');
    const pre = h('textarea', { class: 'ob-pre', readonly: true, rows: '6', 'aria-label': 'Text for Denx' }); pre.value = n ? denxText() : '';
    const btns = h('div', { class: 'row-btns' },
      h('button', { type: 'button', class: 'tiny', disabled: !n || null, onclick: async () => { const ok = await copyText(denxText()); toast(ok ? '📋 Copied – paste it to Denx' : 'Copy blocked – long-press the text below'); } }, '📋 Copy for Denx'),
      h('button', { type: 'button', class: 'tiny ghost', disabled: !n || null, onclick: exportEnc }, '⬇️ Encrypted export'));
    const body = [
      clearedNote ? h('p', { class: 'ob-cleared' }, `✓ ${clearedNote} edit${clearedNote > 1 ? 's' : ''} now in notes.json – cleared`) : null,
      list, btns,
      n ? h('details', { class: 'm-fold ob-fold' }, h('summary', null, h('span', null, 'Show text for Denx')), pre) : null,
      lockedOld ? h('p', { class: 'small muted' }, '🔐 Edits saved under an older passphrase are kept encrypted (not shown). ',
        h('button', { type: 'button', class: 'tiny ghost', onclick: () => { localStorage.removeItem(LS_LOCKED); lockedOld = false; D().rerender(); } }, 'Discard them')) : null,
      h('p', { class: 'small muted' }, 'Clears itself once Denx’s next notes.json (≈05:24 / 21:24) shows the same state. The copied text is plain – send it only in a private chat.')];
    clearedNote = 0;
    return card(n ? 'coral' : 'mist', '📤', 'Outbox', body, { badge: n ? `${n} pending` : null });
  }
  async function exportEnc() {
    try {
      const env = await NotesCrypto.encryptJSON(key, exportPayload(), salt, iter, EXPORT_KIND);
      download(`daily-notes-edits-${today()}.enc.json`, JSON.stringify(env));
      toast('⬇️ Encrypted edits downloaded – give the file to Denx');
    } catch (e) { console.warn(e); toast('Export failed'); }
  }

  /* ================= collectors shared by Week / Review / pings ================= */
  function datedItems(d) {
    const { str, pick, arr, statusOf, billRows, subRows, peso, isoDate } = D();
    const out = []; // {iso, ico, text, kind, done, key, cls, local}
    arr(d.today ?? d.schedule).forEach((it) => { if (it && typeof it === 'object' && isoDate(it.date)) out.push({ iso: isoDate(it.date), ico: '🗓️', kind: 'event', text: [pick(it, 'time', 'when'), pick(it, 'item', 'event', 'title', 'text')].filter(Boolean).join(' '), local: it._local }); });
    arr(d.taskings).forEach((it) => { if (typeof it !== 'object') return; const iso = isoDate(it.deadline ?? it.due); if (iso) out.push({ iso, ico: '🎖️', kind: 'tasking', text: pick(it, 'task', 'title', 'item'), done: statusOf(it.status).key === 'done', key: C.keyOf('taskings', it), local: it._local }); });
    arr(d.todo ?? d.todos).forEach((it) => { if (typeof it !== 'object') return; const iso = isoDate(it.due ?? it.deadline); if (iso) out.push({ iso, ico: '✅', kind: 'todo', text: pick(it, 'item', 'task', 'text', 'title'), done: !!it.done, key: C.keyOf('todo', it), local: it._local }); });
    arr(d.reminders).forEach((it) => { const o = typeof it === 'string' ? { item: it } : it; const iso = isoDate(o && (o.due ?? o.date)); if (iso) out.push({ iso, ico: '⏰', kind: 'reminder', text: pick(o, 'item', 'text', 'title'), done: !!o.done, key: C.keyOf('reminders', o), local: o._local }); });
    billRows(d).forEach((r) => { if (r.dt && r.dt.iso) out.push({ iso: r.dt.iso, ico: '💳', kind: 'bill', text: `${pick(r.it, 'name', 'title') || 'Bill'} ${r.amount != null ? peso(r.amount) : ''}`.trim(), done: r.key === 'paid', unverified: r.key === 'unverified', key: C.keyOf('bills', r.it), local: r.it._local }); });
    subRows(d).forEach((r) => { if ((r.key === 'active' || r.key === 'other') && r.dt && r.dt.iso) out.push({ iso: r.dt.iso, ico: '🔄', kind: 'renewal', text: `${pick(r.it, 'name') || 'Subscription'} renews${r.php != null ? ' · ' + peso(r.php) : ''}`, approx: r.dt.text.startsWith('≈') }); });
    D().objs(d.goals, 'title').forEach((g) => { const iso = isoDate(g.target_date); if (iso) out.push({ iso, ico: '🎯', kind: 'goal', text: `Goal: ${pick(g, 'title', 'name')}`, done: (D().num(g.progress_pct) ?? 0) >= 100 }); });
    const pft = d.health && typeof d.health === 'object' && d.health.pft && typeof d.health.pft === 'object' ? d.health.pft : null;
    if (pft && isoDate(pft.date)) out.push({ iso: isoDate(pft.date), ico: '🏃', kind: 'pft', text: 'PFT' });
    return out.filter((x) => x.text);
  }

  /* ================= Week view ================= */
  function weekCard(d) {
    const { h, card } = D();
    const t = today(), days = Array.from({ length: 7 }, (_, i) => addDays(t, i)), end = days[6];
    const seen = new Set(), items = datedItems(d).filter((x) => { if (x.done) return false; const k = x.iso + '|' + D().normT(x.text); if (seen.has(k)) return false; seen.add(k); return true; }); // done items leave the calendar; same item twice → once
    const overdue = items.filter((x) => x.iso < t && ['tasking', 'todo', 'reminder', 'bill'].includes(x.kind));
    const strip = overdue.length ? h('div', { class: 'wk-over' }, h('p', { class: 'wk-over-h' }, `⚠️ Overdue (${overdue.length})`),
      h('div', { class: 'wk-chips' }, overdue.sort((a, b) => a.iso.localeCompare(b.iso)).map((x) => h('span', { class: 'chip due-over' }, x.ico, ' ', x.text, ' · ', x.unverified ? 'verify' : `${D().daysBetween(x.iso, t)}d`)))) : null;
    const list = h('ol', { class: 'wk-days' }, days.map((iso, i) => {
      const its = items.filter((x) => x.iso === iso);
      const hb = window.Habits && window.Habits.dueOn ? window.Habits.dueOn(iso) : null;
      return h('li', { class: 'wk-day' + (i === 0 ? ' today' : '') + (new Date(iso + 'T00:00:00Z').getUTCDay() % 6 === 0 ? ' wkend' : '') },
        h('div', { class: 'wk-dh' }, h('strong', null, i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : fmtD(iso, { day: undefined, month: undefined, weekday: 'long' })), h('span', { class: 'muted small' }, fmtD(iso, { weekday: undefined }))),
        its.length ? h('ul', { class: 'wk-items' }, its.map((x) => h('li', { class: `wk-it k-${x.kind}` }, h('span', { class: 'wk-ico', 'aria-hidden': 'true' }, x.ico), h('span', null, x.text, x.approx ? h('span', { class: 'muted small' }, ' (approx)') : null), x.local ? h('span', { class: 'chip local' }, '✎') : null))) : null,
        hb && hb.length ? h('p', { class: 'wk-hb' }, `🌸 ${hb.length} habit${hb.length > 1 ? 's' : ''}: `, hb.map((x) => x.emoji).join(' ')) : null,
        !its.length && !(hb && hb.length) ? h('p', { class: 'wk-free muted small' }, 'Free day ✨') : null);
    }));
    const pings = h('label', { class: 'wk-ping small' }, h('input', { type: 'checkbox', id: 'due-pings', checked: (O && O.settings.duePings) || null, onchange: (e) => { if (O) { O.settings.duePings = e.target.checked; save(); } } }),
      ' 🔔 Due pings while this page is open ', h('span', { class: 'muted' }, window.Habits && window.Habits.notifyOn && window.Habits.notifyOn() ? '(notifications on)' : '(turn on notifications in Habits → Manage)'));
    return card('sky', '🗓️', 'Next 7 days', [strip, list, pings], { wide: true, badge: overdue.length ? `⚠️ ${overdue.length}` : `${fmtD(t, { weekday: undefined })} – ${fmtD(end, { weekday: undefined })}` });
  }

  /* ================= Weekly review + wins ================= */
  const lines = (v) => D().arr(v).map((x) => (typeof x === 'string' ? x.trim() : D().pick(x, 'text', 'item', 'title'))).filter(Boolean);
  function reviewCard(d) {
    const { h, card, pick, arr, statusOf, billRows, objs } = D();
    const t = today(), ws = weekStart(t), we = addDays(ws, 6), inW = (iso) => !!iso && iso >= ws && iso <= we;
    const wr = d.weekly_review && typeof d.weekly_review === 'object' && !Array.isArray(d.weekly_review) ? d.weekly_review : null;
    const hs = window.Habits && window.Habits.weekStats ? window.Habits.weekStats(ws) : null;
    const doneList = [];
    arr(d.todo ?? d.todos).forEach((it) => { if (it && typeof it === 'object' && it.done && !it._autodone && (!isoOf(it.done_on) || inW(isoOf(it.done_on)))) doneList.push({ ico: '✅', text: pick(it, 'item', 'task', 'text', 'title'), local: it._local }); });
    let tasks = 0;
    arr(d.taskings).forEach((it) => { if (it && typeof it === 'object' && statusOf(it.status).key === 'done' && !it._autodone && (!isoOf(it.done_on) || inW(isoOf(it.done_on)))) { tasks++; doneList.push({ ico: '🎖️', text: pick(it, 'task', 'title', 'item'), local: it._local }); } });
    let paid = 0;
    billRows(d).forEach((r) => { const po = isoOf(r.it.paid_on); if (r.key === 'paid' && (po ? inW(po) : r.dt && inW(r.dt.iso))) { paid++; doneList.push({ ico: '💳', text: `${pick(r.it, 'name') || 'Bill'} paid`, local: r.it._local }); } });
    const mpat = Array.isArray(d.mpat_log ?? d.mpat) ? (d.mpat_log ?? d.mpat).filter((x) => x && inW(isoOf(x.date))).length : null;
    const wins = objs(d.wins, 'text').map((w) => ({ iso: isoOf(w.date), text: pick(w, 'text', 'win', 'title') })).filter((w) => w.text);
    const wk = wins.filter((w) => !w.iso || inW(w.iso)), older = wins.filter((w) => w.iso && w.iso < ws).sort((a, b) => b.iso.localeCompare(a.iso));
    const winTxt = wk.map((w) => D().normT(w.text)).join(' | ');
    const doneUniq = doneList.filter((x) => { const n = D().normT(x.text.replace(/ paid$/, '')); return n && !winTxt.includes(n); }); // a win already says it
    const tile = (v, l, cls) => h('div', { class: `m-stat ${cls || ''}` }, h('span', { class: 'm-stat-v' }, v), h('span', { class: 'm-stat-l' }, l));
    const tiles = h('div', { class: 'm-stats rv-stats' },
      tile(hs && hs.pct != null ? Math.round(hs.pct * 100) + '%' : '—', '🌸 Habits (week)', 'm-paid'), tile(hs ? String(hs.perfect) : '—', '💯 Perfect days', 'm-unver'),
      mpat != null ? tile(String(mpat), '✈️ MPAT sessions', 'm-gross') : null, tile(String(tasks), '🎖️ Taskings done', 'm-unpaid'), tile(String(paid), '💳 Bills paid', 'm-paid'));
    const sec = (title, xs) => (xs.length ? [h('p', { class: 'm-h' }, title), h('ul', { class: 'bullets' }, xs.map((x) => h('li', null, x)))] : null);
    const nW = wk.length + doneUniq.length;
    const body = [tiles,
      nW ? h('details', { class: 'm-fold', id: 'rv-wins' }, h('summary', null, h('span', null, `🏆 Wins & done this week (${nW})`)),
        h('ul', { class: 'rv-wins' }, wk.map((w) => h('li', null, '🏆 ', w.text, w.iso ? h('span', { class: 'muted small' }, ' · ' + fmtD(w.iso)) : null)),
          doneUniq.map((x) => h('li', { class: 'rv-done' }, x.ico, ' ', x.text, x.local ? h('span', { class: 'chip local' }, '✎ this device') : null)))) : D().empty('Log a win — small ones count. 🌱'),
      older.length ? h('details', { class: 'm-fold' }, h('summary', null, h('span', null, `Earlier wins (${older.length})`)), h('ul', { class: 'bullets' }, older.slice(0, 20).map((w) => h('li', null, w.text, h('span', { class: 'muted small' }, ' · ' + fmtD(w.iso)))))) : null,
      wr ? sec('✨ Highlights', lines(wr.highlights)) : null, wr ? sec('📘 Lessons', lines(wr.lessons)) : null, wr ? sec('🎯 Next focus', lines(wr.next_focus)) : null];
    return card('lav', '🏆', 'Weekly review', body, { sub: `${wr && D().str(wr.week) ? D().str(wr.week) + ' · ' : ''}${fmtD(ws, { weekday: undefined })} – ${fmtD(we, { weekday: undefined })}` });
  }

  /* ================= Health & rest ================= */
  const SVG = 'http://www.w3.org/2000/svg';
  function svgEl(tag, attrs) { const n = document.createElementNS(SVG, tag); for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v); return n; }
  function spark(points, { ref, fmt, label, color }) {
    const W = 300, H = 64, P = 6;
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'spark', role: 'img', 'aria-label': label });
    if (points.length < 2) { const tx = svgEl('text', { x: W / 2, y: H / 2 + 4, 'text-anchor': 'middle', class: 'spark-empty' }); tx.textContent = points.length ? 'one entry so far' : 'no data yet'; svg.append(tx); return svg; }
    const vs = points.map((p) => p.v).concat(ref != null ? [ref] : []);
    let lo = Math.min(...vs), hi = Math.max(...vs); if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
    const pad = (hi - lo) * 0.12; lo -= pad; hi += pad;
    const t0 = Date.parse(points[0].iso), t1 = Date.parse(points[points.length - 1].iso) || t0 + 1;
    const X = (iso) => P + ((Date.parse(iso) - t0) / Math.max(1, t1 - t0)) * (W - 2 * P), Y = (v) => H - P - ((v - lo) / (hi - lo)) * (H - 2 * P);
    if (ref != null) svg.append(svgEl('line', { x1: P, x2: W - P, y1: Y(ref), y2: Y(ref), class: 'spark-ref' }));
    const pts = points.map((p) => `${X(p.iso).toFixed(1)},${Y(p.v).toFixed(1)}`).join(' ');
    svg.append(svgEl('polyline', { points: `${P},${H - P} ${pts} ${W - P},${H - P}`, class: 'spark-area', fill: color, 'fill-opacity': '0.15', stroke: 'none' }));
    svg.append(svgEl('polyline', { points: pts, class: 'spark-line', stroke: color, fill: 'none' }));
    points.forEach((p, i) => { const c = svgEl('circle', { cx: X(p.iso).toFixed(1), cy: Y(p.v).toFixed(1), r: i === points.length - 1 ? 3.5 : 2.2, fill: p.local ? '#e85584' : color }); const tt = svgEl('title'); tt.textContent = `${p.iso}: ${fmt(p.v)}`; c.append(tt); svg.append(c); });
    return svg;
  }
  function healthCard(d) {
    const { h, card, num, objs, pick, dueInfo, fmtNum } = D();
    const hh = d.health && typeof d.health === 'object' && !Array.isArray(d.health) ? d.health : {};
    const t = today();
    const series = (xs, f) => objs(xs, 'date').map((x) => ({ iso: isoOf(x.date), v: num(x[f]), local: !!x._local })).filter((p) => p.iso && p.v != null && p.iso <= t).sort((a, b) => a.iso.localeCompare(b.iso));
    const sleep = series(hh.sleep, 'hours'), weight = series(hh.weight, 'kg');
    const s7 = sleep.filter((p) => p.iso >= addDays(t, -6));
    const avg = s7.length ? s7.reduce((a, p) => a + p.v, 0) / s7.length : null;
    const lastS = sleep[sleep.length - 1], lastW = weight[weight.length - 1];
    const w30 = weight.filter((p) => p.iso <= addDays(t, -25)).pop() || weight[0];
    const dW = lastW && w30 && w30 !== lastW ? lastW.v - w30.v : null;
    const tile = (v, l, cls) => h('div', { class: `m-stat ${cls}` }, h('span', { class: 'm-stat-v' }, v), h('span', { class: 'm-stat-l' }, l));
    const tiles = h('div', { class: 'm-stats' },
      tile(avg != null ? `${fmtNum(Math.round(avg * 10) / 10)} h` : '—', `😴 Sleep avg 7d${s7.length ? ` (${s7.length} night${s7.length === 1 ? '' : 's'})` : ''}`, avg != null && avg < 6 ? 'm-over' : avg != null && avg < 7 ? 'm-unpaid' : 'm-paid'),
      tile(lastW ? `${fmtNum(lastW.v)} kg` : '—', `⚖️ Weight${dW != null ? ` · ${dW > 0 ? '+' : ''}${fmtNum(Math.round(dW * 10) / 10)} kg since ${fmtD(w30.iso, { weekday: undefined })}` : ''}`, 'm-gross'));
    const chart = (title, pts, opts) => h('div', { class: 'hl-chart' }, h('p', { class: 'hl-ch' }, h('span', null, title), pts.length ? h('span', { class: 'muted small' }, `last ${opts.unit}: ${fmtNum(pts[pts.length - 1].v)} · ${fmtD(pts[pts.length - 1].iso, { weekday: undefined })}`) : null), spark(pts, opts));
    const pft = hh.pft && typeof hh.pft === 'object' ? hh.pft : null;
    const pftDi = pft ? dueInfo(pft.date, false) : null;
    const pftEl = pft ? h('div', { class: 'hl-pft' }, h('p', { class: 'm-h' }, '🏃 PFT ', pftDi ? h('span', { class: `chip ${pftDi.cls}` }, pftDi.label) : null),
      objs(pft.events, 'name').length ? h('table', { class: 'hl-tbl' }, h('thead', null, h('tr', null, h('th', null, 'Event'), h('th', null, 'Target'), h('th', null, 'Latest'))),
        h('tbody', null, objs(pft.events, 'name').map((e) => h('tr', null, h('td', null, pick(e, 'name', 'event')), h('td', null, pick(e, 'target', 'goal') || '—'), h('td', null, pick(e, 'latest', 'last', 'current') || '—'))))) : null) : null;
    const ex = exerciseBlock(d);
    return card('aqua', '💪', 'Health & rest', h('div', { class: 'hl-grid' },
      h('div', { class: 'hl-col' }, tiles, chart('😴 Sleep (hours)', sleep.slice(-14), { ref: 7, fmt: (v) => v + ' h', label: 'Sleep hours, last entries', color: '#5b6fd6', unit: 'night' }),
        chart('⚖️ Weight (kg)', weight.slice(-20), { fmt: (v) => v + ' kg', label: 'Weight trend', color: '#17a28f', unit: 'entry' })),
      h('div', { class: 'hl-col' }, ex, pftEl, pick(hh, 'notes', 'note') ? h('p', { class: 'm-note' }, '📝 ', pick(hh, 'notes', 'note')) : null,
        h('p', { class: 'small muted' }, 'Log sleep, weight and exercise on 🏠 Today → Update → Health. Pink dots = pending sync. Dashed line = 7 h.'))), { wide: true, sub: 'Read-only · from your health log' });
  }
  // Health quick log (rendered inside Today → Update; the Health card itself is read-only on Goals)
  function healthLogForm() {
    const { h, num } = D();
    const t = today();
    const dIn = h('input', { type: 'date', id: 'hl-date', value: t, max: t, 'aria-label': 'Date' });
    const sIn = h('input', { type: 'number', id: 'hl-sleep', inputmode: 'decimal', step: '0.25', min: '0', max: '16', placeholder: 'Sleep h', 'aria-label': 'Sleep hours' });
    const wIn = h('input', { type: 'number', id: 'hl-weight', inputmode: 'decimal', step: '0.1', min: '20', max: '300', placeholder: 'Weight kg', 'aria-label': 'Weight kg' });
    const exT = h('select', { id: 'hl-ex-type', 'aria-label': 'Exercise type' }, C.EX_TYPES.map((x) => h('option', { value: x }, x)));
    const exM = h('input', { type: 'number', id: 'hl-ex-min', inputmode: 'numeric', step: '1', min: '1', max: '600', placeholder: 'Minutes', 'aria-label': 'Exercise minutes' });
    const form = h('form', { class: 'hl-log', novalidate: true, onsubmit: (e) => {
      e.preventDefault();
      const date = dIn.value || t, s = num(sIn.value), w = num(wIn.value), m = num(exM.value);
      if (s == null && w == null && m == null) { toast('Enter sleep hours, weight and/or exercise minutes'); return; }
      if (s != null && (s < 0 || s > 16)) { toast('Sleep hours look off (0–16)'); return; }
      if (w != null && (w < 20 || w > 300)) { toast('Weight looks off (20–300 kg)'); return; }
      if (m != null && (m < 1 || m > 600)) { toast('Exercise minutes look off (1–600)'); return; }
      if (s != null) logHealth('health.sleep', date, s); if (w != null) logHealth('health.weight', date, w);
      if (m != null) logExercise(date, exT.value, m);
      toast('📝 Logged on this device – in the Outbox for Denx');
    } }, h('p', { class: 'm-h' }, '📝 Quick log'),
      h('div', { class: 'hl-row' }, dIn, sIn, wIn),
      h('div', { class: 'hl-row hl-ex' }, h('span', { class: 'hl-ex-l', 'aria-hidden': 'true' }, '🏃'), exT, exM, h('button', { type: 'submit', class: 'qc-add', id: 'hl-submit' }, 'Log')));
    return h('div', { class: 'hl-wrap' }, form, h('p', { class: 'small muted' }, 'Exercise minutes also count toward the 🏃 Exercise habit.'));
  }
  /* ---- exercise log (notes.json health.exercise[] + phone edits) ---- */
  function logExercise(date, type, minutes) {
    const v = C.exVal({ date, type, minutes });
    if (!v || !ready()) return false;
    return !!recAdd('health.exercise', v, `${v.type} ${v.minutes} min`);
  }
  function exerciseBlock(d) {
    const { h, objs, num } = D();
    const hh = d.health && typeof d.health === 'object' && !Array.isArray(d.health) ? d.health : {};
    const t = today(), ws = weekStart(t);
    const xs = objs(hh.exercise, 'date').map((x) => ({ iso: isoOf(x.date), type: C.EX_TYPES.includes(x.type) ? x.type : 'Exercise', min: Math.round(num(x.minutes ?? x.min ?? x.duration) || 0), local: !!x._local })).filter((x) => x.iso && x.min > 0 && x.iso <= t);
    const wk = xs.filter((x) => x.iso >= ws);
    const byType = {}; wk.forEach((x) => { byType[x.type] = (byType[x.type] || 0) + x.min; });
    const tot = wk.reduce((a, x) => a + x.min, 0), mx = Math.max(1, ...Object.values(byType));
    const hb = (window.Habits && window.Habits.summary ? window.Habits.summary() : []).find((x) => x.exercise);
    const goal = hb && hb.type !== 'check' ? (hb.weekly ? hb.weekly * hb.target : hb.target * 7) : null;
    const manual = hb ? Math.max(0, hb.weekVal - tot) : 0;
    return h('div', { class: 'hl-ex-sum', id: 'hl-exercise' },
      h('p', { class: 'm-h' }, '🏃 Exercise this week'),
      h('div', { class: 'm-stats' },
        h('div', { class: 'm-stat m-paid' }, h('span', { class: 'm-stat-v' }, `${tot + manual} min`), h('span', { class: 'm-stat-l' }, goal ? `of ~${goal} min habit goal` : 'logged + habit timer')),
        h('div', { class: 'm-stat m-gross' }, h('span', { class: 'm-stat-v' }, String(wk.length)), h('span', { class: 'm-stat-l' }, `session${wk.length === 1 ? '' : 's'} logged`))),
      Object.keys(byType).length || manual ? h('ul', { class: 'ex-bars' }, Object.entries(byType).sort((a, b) => b[1] - a[1]).map(([k, v]) => h('li', null, h('span', { class: 'ex-k' }, k), h('span', { class: 'ex-bar' }, h('span', { style: { width: Math.round((v / mx) * 100) + '%' } })), h('span', { class: 'ex-v' }, v + ' min'))),
        manual ? h('li', { class: 'muted' }, h('span', { class: 'ex-k' }, 'Habit timer'), h('span', { class: 'ex-bar' }, h('span', { style: { width: Math.min(100, Math.round((manual / mx) * 100)) + '%' } })), h('span', { class: 'ex-v' }, manual + ' min')) : null)
        : h('p', { class: 'empty' }, 'No exercise logged this week yet.'),
      xs.length ? h('ul', { class: 'ex-recent small' }, xs.slice().sort((a, b) => b.iso.localeCompare(a.iso)).slice(0, 5).map((x) => h('li', null, `${fmtD(x.iso)} · ${x.type} · ${x.min} min`, x.local ? h('span', { class: 'chip local' }, '✎') : null))) : null);
  }

  /* ================= Quick notes (notes.json `quick_notes` + local) ================= */
  function quickNotesCard(d) {
    const { h, card, objs, pick } = D();
    const xs = objs(d.quick_notes, 'text').filter((x) => pick(x, 'text', 'note', 'item') && !x.done).slice().reverse();
    if (!xs.length) return null;
    const li = (x) => h('li', null, pick(x, 'text', 'note', 'item'), isoOf(x.date) ? h('span', { class: 'muted small' }, ' · ' + fmtD(isoOf(x.date))) : null, localChip(x));
    return card('lilac', '🗒️', 'Notes', [h('ul', { class: 'bullets' }, xs.slice(0, 4).map(li)),
      xs.length > 4 ? h('details', { class: 'm-fold' }, h('summary', null, h('span', null, `Older notes (${xs.length - 4})`)), h('ul', { class: 'bullets' }, xs.slice(4).map(li))) : null], { badge: xs.length });
  }

  /* ================= Links (notes.json `links` + phone edits via the Outbox) ================= */
  let lkQuery = '', lkEdit = null, lkErr = '';           // lkEdit: null | 'new' | { key, it }
  const lkKey = (it) => (it && it._lkey) || C.keyOf('links', it);
  const lkHost = (u) => { try { return new URL(u).host.replace(/^www\./, ''); } catch { return ''; } };
  const lkShow = (u) => { try { const x = new URL(u), p = x.pathname.replace(/\/+$/, ''); return lkHost(u) + (p && p.length <= 30 ? p : p ? '/…' : ''); } catch { return ''; } };
  // Phone input: add https:// when no scheme was typed ("example.com"); anything that is not http(s) is refused.
  function lkUrlIn(s) { s = str(s).trim(); if (s && !/^[a-z][a-z0-9+.-]*:/i.test(s) && /^[\w-]+(\.[\w-]+)+([\/?#:].*)?$/.test(s)) s = 'https://' + s; return C.safeUrl(s); }
  const rawLinks = () => D().objs(raw.links, 'title');
  function rawLinkByKey(k) { const i = C.findIndex(raw, { sec: 'links', key: k }); return i >= 0 ? D().arr(raw.links)[i] : null; }
  const pendingAdd = (it) => (it && it._local === 'added' && it.id ? O.edits.find((e) => e.sec === 'links' && e.op === 'add' && e.val && e.val.id === it.id) : null);
  function saveLink(target, v) {
    if (!ready()) return false;
    const at = new Date().toISOString();
    if (target === 'new') {
      const id = 'loc-' + rand(4);
      upsert({ eid: 'add:' + id, sec: 'links', op: 'add', key: 'id:' + id, label: v.title, val: Object.assign({ id }, v), at });
      return true;
    }
    const pa = pendingAdd(target.it);
    if (pa) { upsert(Object.assign({}, pa, { label: v.title, val: Object.assign({ id: pa.val.id }, v), at })); return true; }
    const k = target.key, r = rawLinkByKey(k), prev = O.edits.find((e) => e.eid === `links:set:${k}`);
    upsert({ eid: `links:set:${k}`, sec: 'links', op: 'set', key: k, label: prev ? prev.label : D().pick(r || target.it, 'title', 'name'), labelText: prev ? prev.labelText : C.textOf('links', r || target.it), val: v, at });
    return true;
  }
  function deleteLink(target) {
    if (!ready()) return;
    const pa = pendingAdd(target.it);
    if (pa) { drop((e) => e.eid === pa.eid); save(); D().rerender(); return; }
    const k = target.key, r = rawLinkByKey(k), prev = O.edits.find((e) => e.eid === `links:set:${k}`);
    drop((e) => e.eid === `links:set:${k}`);
    upsert({ eid: `links:del:${k}`, sec: 'links', op: 'del', key: k, label: prev ? prev.label : D().pick(r || target.it, 'title', 'name'), labelText: prev ? prev.labelText : C.textOf('links', r || target.it), val: null, at: new Date().toISOString() });
  }
  function linkForm(cats) {
    const { h } = D();
    const it = lkEdit && lkEdit !== 'new' ? lkEdit.it : {};
    const f = (id, label, attrs) => h('label', { class: 'lk-f', for: id }, h('span', null, label), h('input', Object.assign({ id, class: 'lk-in', autocomplete: 'off' }, attrs)));
    const dl = h('datalist', { id: 'lk-cats' }, cats.map((c) => h('option', { value: c })));
    const err = h('p', { class: 'lk-err', role: 'alert', id: 'lk-err' }, lkErr);
    const form = h('form', { class: 'lk-form', id: 'lk-form', novalidate: true, onsubmit: (e) => {
      e.preventDefault();
      const g = (id) => form.querySelector('#' + id).value;
      const title = g('lk-title').trim(), url = lkUrlIn(g('lk-url')), category = g('lk-cat').trim() || 'Other', note = g('lk-note').trim();
      const show = (m) => { err.textContent = m; };
      if (!title) return show('Give the link a title.');
      if (!url) return show('The URL must start with http:// or https:// (e.g. https://example.com).');
      const v = C.linkVal({ title, url, category, note });
      if (!v) return show('That link could not be saved.');
      const isNew = lkEdit === 'new'; lkErr = '';
      lkEdit = null;
      if (!saveLink(isNew ? 'new' : { key: lkKey(it), it }, v)) return;
      toast(isNew ? '🔗 Link added – syncing via the Outbox' : '✎ Link updated – syncing via the Outbox');
    } },
      h('p', { class: 'm-h' }, lkEdit === 'new' ? '➕ New link' : '✎ Edit link'),
      f('lk-title', 'Title', { type: 'text', maxlength: '120', value: D().pick(it, 'title', 'name'), required: true }),
      f('lk-url', 'URL', { type: 'url', inputmode: 'url', maxlength: '2000', placeholder: 'https://…', value: D().pick(it, 'url', 'href'), required: true }),
      f('lk-cat', 'Category', { type: 'text', maxlength: '60', list: 'lk-cats', placeholder: 'e.g. My Apps', value: D().pick(it, 'category') }), dl,
      f('lk-note', 'Note (optional)', { type: 'text', maxlength: '300', value: D().pick(it, 'note') }),
      err,
      h('div', { class: 'row-btns' }, h('button', { type: 'submit', class: 'qc-add', id: 'lk-save' }, 'Save'),
        h('button', { type: 'button', class: 'tiny ghost', onclick: () => { lkEdit = null; lkErr = ''; D().rerender(); } }, 'Cancel'),
        lkEdit !== 'new' ? h('button', { type: 'button', class: 'tiny ghost lk-del', id: 'lk-delete', onclick: () => {
          if (!confirm(`Delete “${D().pick(it, 'title')}”?`)) return;
          const t = { key: lkKey(it), it }; lkEdit = null; deleteLink(t); toast('🗑️ Link deleted – undo by discarding it in the Outbox');
        } }, '🗑️ Delete') : null));
    setTimeout(() => { const t = document.getElementById('lk-title'); if (t && document.activeElement !== t) { t.focus({ preventScroll: true }); form.scrollIntoView({ block: 'nearest' }); } }, 0);
    return form;
  }
  function filterLinks(root, q) {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    let shown = 0;
    root.querySelectorAll('.lk-group').forEach((g) => {
      let n = 0;
      g.querySelectorAll('.lk-row').forEach((r) => { const ok = terms.every((w) => r.dataset.q.includes(w)); r.hidden = !ok; if (ok) n++; });
      g.hidden = !n; shown += n;
    });
    const none = root.querySelector('.lk-none'); if (none) { none.hidden = shown > 0 || !terms.length; none.textContent = `No links match “${q}”.`; }
  }
  function linksCard(d) {
    const { h, card, objs, pick, empty } = D();
    const xs = objs(d.links, 'title').map((it) => ({ it, title: pick(it, 'title', 'name'), url: C.safeUrl(pick(it, 'url', 'href')), cat: pick(it, 'category') || 'Other', note: pick(it, 'note') })).filter((x) => x.title || x.url);
    const cats = []; xs.forEach((x) => { if (!cats.includes(x.cat)) cats.push(x.cat); });
    const canEdit = ready();
    const groups = cats.map((c) => {
      const rows = xs.filter((x) => x.cat === c);
      return h('section', { class: 'lk-group' }, h('h3', { class: 'lk-cat' }, c, h('span', { class: 'muted small' }, ' · ' + rows.length)),
        h('ul', { class: 'lk-list' }, rows.map((x) => h('li', { class: 'lk-row' + (x.it._local ? ' local' : ''), 'data-q': [x.title, x.note, x.cat, lkHost(x.url)].join(' ').toLowerCase() },
          h('div', { class: 'lk-main' }, h('strong', { class: 'lk-title' }, x.title || lkHost(x.url)), localChip(x.it),
            x.note ? h('span', { class: 'lk-note' }, x.note) : null,
            h('span', { class: 'lk-host muted small', title: x.url || null }, x.url ? lkShow(x.url) : '⚠️ not an http(s) link – edit it')),
          h('div', { class: 'lk-acts' },
            x.url ? h('a', { class: 'lk-open', href: x.url, target: '_blank', rel: 'noopener noreferrer', 'aria-label': 'Open ' + x.title }, 'Open ↗') : null,
            x.url ? h('button', { type: 'button', class: 'icon lk-copy', title: 'Copy link', 'aria-label': 'Copy link: ' + x.title, onclick: async () => { const ok = await copyText(x.url); toast(ok ? '📋 Link copied' : 'Copy blocked by the browser'); } }, '📋') : null,
            canEdit ? h('button', { type: 'button', class: 'icon lk-edit', title: 'Edit', 'aria-label': 'Edit link: ' + x.title, onclick: () => { lkEdit = { key: lkKey(x.it), it: x.it }; lkErr = ''; D().rerender(); } }, '✎') : null)))));
    });
    const q = h('input', { type: 'search', id: 'lk-q', class: 'lk-q', placeholder: 'Filter links…', 'aria-label': 'Filter links', autocomplete: 'off', value: lkQuery,
      oninput: (e) => { lkQuery = e.target.value; filterLinks(box, lkQuery); } });
    const box = h('div', { class: 'lk-groups' }, groups, h('p', { class: 'empty lk-none', hidden: true }));
    if (lkQuery) setTimeout(() => filterLinks(box, lkQuery), 0);
    const addBtn = canEdit && !lkEdit ? h('button', { type: 'button', class: 'tiny', id: 'lk-add', onclick: () => { lkEdit = 'new'; lkErr = ''; D().rerender(); } }, '＋ Add link') : null;
    const body = [h('div', { class: 'lk-bar' }, q, addBtn), lkEdit && canEdit ? linkForm(cats) : null,
      xs.length ? box : empty('No links yet — tap ＋ Add link.'),
      h('p', { class: 'small muted' }, 'Links open in a new tab. Adds / edits / deletes are saved encrypted on this device and sync through the Outbox.')];
    return card('mint', '🔗', 'Links', body, { wide: true, badge: xs.length || null });
  }

  /* ================= Search ================= */
  const KEY_CARD = { today: 'c-todo', schedule: 'c-todo', todo: 'c-todo', todos: 'c-todo', taskings: 'c-taskings', tasks: 'c-taskings', reminders: 'c-todo', duty_log: 'c-wd1', duty: 'c-wd1',
    wd1: 'c-wd1', studies: 'c-studies', mmpa: 'c-studies', mpat_log: 'c-mpat', mpat: 'c-mpat', ideas: 'c-ideas', verse: 'c-hero', bills: 'm-bills', bills_outlook: 'm-bills', bills_summary: 'm-bills',
    subscriptions: 'm-subscriptions', decisions: 'm-decisions', automations: 'm-automations', finance_tips: 'm-finance_tips', income: 'm-pay', debts: 'm-debts', balances: 'm-pay',
    wins: 'c-review', weekly_review: 'c-review', goals: 'c-goals', health: 'c-health', quick_notes: 'c-quick_notes', links: 'c-links', finance: 'c-savings', va: 'c-va', transactions: 'm-txlog' };
  const SKIP = new Set(['updated', 'version', 'schema', 'habits']);
  function buildIndex(d) {
    const idTok = D().idTok, out = [];
    const leaves = (v, acc) => {
      if (v == null) return acc;
      if (typeof v === 'string' || typeof v === 'number') { const s = String(v).trim(); if (s) acc.push(s); return acc; }
      if (Array.isArray(v)) { v.forEach((x) => leaves(x, acc)); return acc; }
      if (typeof v === 'object') for (const [k, x] of Object.entries(v)) if (!k.startsWith('_') && !idTok(k) && k !== 'id') { if (['method', 'card', 'payment'].includes(k) && typeof x === 'string') acc.push(D().maskNum(x)); else leaves(x, acc); }
      return acc;
    };
    for (const [k, v] of Object.entries(d || {})) {
      if (SKIP.has(k) || idTok(k) || k.startsWith('_')) continue;
      const cardId = KEY_CARD[k] || 'x-' + k;
      const items = Array.isArray(v) ? v : v && typeof v === 'object' && !['wd1', 'verse', 'bills_summary'].includes(k) ? Object.values(v) : [v];
      const safeItems = k === 'income' ? [] : items; // pay slip lines: searchable by name only (below)
      safeItems.forEach((it) => { const t = leaves(it, []).join(' · '); if (t) out.push({ k, cardId, text: t, local: !!(it && it._local) }); });
      if (k === 'income' && v && typeof v === 'object') ['allowances', 'deductions', 'salary_loans'].forEach((f) => D().objs(v[f], 'name').forEach((x) => out.push({ k, cardId, text: D().pick(x, 'name') })));
    }
    (window.Habits && window.Habits.names ? window.Habits.names() : []).forEach((x) => out.push({ k: 'habits', cardId: 'habits', text: `${x.emoji} ${x.name}` }));
    searchIndex = out;
  }
  const LABEL = { today: 'Schedule', todo: 'To-do', taskings: 'Taskings', reminders: 'Reminders', duty_log: 'Duty log', wd1: 'WD1', studies: 'Studies', mpat_log: 'MPAT', ideas: 'Ideas', verse: 'Verse',
    bills: 'Bills', bills_outlook: 'Bills', subscriptions: 'Subscriptions', decisions: 'Decisions', automations: 'Automations', finance_tips: 'Strategy', income: 'Pay', debts: 'Debts', balances: 'Cash',
    wins: 'Wins', weekly_review: 'Review', goals: 'Goals', health: 'Health', quick_notes: 'Quick notes', habits: 'Habits', links: 'Links', finance: 'Savings', va: 'VA hunt', transactions: 'Money log' };
  function marked(text, terms) {
    const { h } = D(), frag = document.createDocumentFragment();
    if (!terms.length) { frag.append(text); return frag; }
    const re = new RegExp('(' + terms.map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')', 'gi');
    text.split(re).forEach((part, i) => frag.append(i % 2 ? h('mark', null, part) : part));
    return frag;
  }
  function snippet(text, terms) {
    if (text.length <= 140) return text;
    const i = Math.max(0, text.toLowerCase().indexOf(terms[0] || '') - 40);
    return (i > 0 ? '…' : '') + text.slice(i, i + 140) + (i + 140 < text.length ? '…' : '');
  }
  let lastQuery = '';
  function searchCard() {
    const { h, card } = D();
    const res = h('ul', { class: 'sr-list', id: 'sr-list', 'aria-live': 'polite' });
    const inp = h('input', { type: 'search', id: 'sr-q', placeholder: 'Search notes, money, habits…', 'aria-label': 'Search', autocomplete: 'off', value: lastQuery,
      oninput: (e) => { lastQuery = e.target.value; runSearch(res, lastQuery); } });
    setTimeout(() => runSearch(res, lastQuery), 0);
    return card('mist', '🔍', 'Search', [inp, res], { wide: true, sub: 'Everything on this device: notes, edits not yet synced, habit names' });
  }
  function runSearch(res, q) {
    const { h } = D();
    const terms = q.toLowerCase().split(/\s+/).filter((x) => x.length >= 2);
    if (!terms.length) { res.replaceChildren(h('li', { class: 'empty' }, 'Type at least 2 letters.')); return; }
    const hits = searchIndex.filter((x) => { const t = x.text.toLowerCase(); return terms.every((w) => t.includes(w)); }).slice(0, 40);
    res.replaceChildren(...(hits.length ? hits.map((x) => h('li', null, h('button', { type: 'button', class: 'sr-hit', onclick: () => jumpTo(x.cardId, terms) },
      h('span', { class: 'chip sr-sec' }, LABEL[x.k] || x.k.replace(/_/g, ' ')), x.local ? h('span', { class: 'chip local' }, '✎') : null, h('span', { class: 'sr-txt' }, marked(snippet(x.text, terms), terms))))) : [h('li', { class: 'empty' }, `No matches for “${q}”.`)]));
  }
  function jumpTo(cardId, terms) {
    const el = document.getElementById(cardId);
    if (!el) { toast('That section is not on the board'); return; }
    const host = el.closest('#board > *') || el; // merged cards: the id may sit on a block inside a card
    go(host.dataset.sec || 'today');
    el.querySelectorAll('details').forEach((x) => { if (terms.some((w) => x.textContent.toLowerCase().includes(w))) x.open = true; });
    highlightIn(el, terms);
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    host.classList.remove('flash'); void host.offsetWidth; host.classList.add('flash');
  }
  function highlightIn(el, terms) {
    if (!(window.CSS && CSS.highlights && window.Highlight)) return;
    const ranges = [], walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const t = n.data.toLowerCase();
      for (const w of terms) { let i = t.indexOf(w); while (i >= 0) { const r = new Range(); r.setStart(n, i); r.setEnd(n, i + w.length); ranges.push(r); i = t.indexOf(w, i + w.length); } }
    }
    CSS.highlights.set('dn-search', new Highlight(...ranges));
    clearTimeout(highlightIn._t); highlightIn._t = setTimeout(() => CSS.highlights.delete('dn-search'), 8000);
  }

  /* ================= section nav ================= */
  const SECTIONS = [['today', '🏠', 'Today'], ['week', '🗓️', 'Week'], ['money', '💰', 'Money'], ['goals', '🎯', 'Goals'], ['links', '🔗', 'Links'], ['search', '🔍', 'Search']];
  const ALIAS = { health: 'goals' }; // old deep links (#health) → the read-only Health card now lives on Goals
  function navEl() {
    const nav = document.getElementById('secnav');
    if (!nav) return null;
    if (!nav.childElementCount) nav.append(...SECTIONS.map(([k, ico, l]) => D().h('button', { type: 'button', 'data-sec': k, class: 'sn-btn', onclick: () => { go(k); window.scrollTo({ top: 0 }); if (k === 'search') setTimeout(() => { const q = document.getElementById('sr-q'); if (q) q.focus(); }, 50); } },
      h2(ico), D().h('span', { class: 'sn-l' }, l), D().h('span', { class: 'sn-dot', hidden: true }))));
    nav.hidden = false;
    return nav;
  }
  const h2 = (ico) => D().h('span', { class: 'sn-i', 'aria-hidden': 'true' }, ico);
  function go(sec) {
    sec = ALIAS[sec] || sec;
    if (!SECTIONS.some((s) => s[0] === sec)) sec = 'today';
    view = sec;
    try { history.replaceState(null, '', sec === 'today' ? location.pathname + location.search : '#' + sec); } catch { /* file:// etc */ }
    const board = document.getElementById('board');
    if (board) {
      const old = document.getElementById('c-empty-sec'); if (old) old.remove();
      board.dataset.view = sec;
      let shown = 0;
      for (const el of board.children) { el.hidden = (el.dataset.sec || 'today') !== sec; if (!el.hidden) shown++; }
      if (!shown) { const ph = D().card('mist', '🌿', 'Nothing here yet', D().empty('No data for this section in notes.json yet – see README “For Denx”.')); ph.id = 'c-empty-sec'; ph.dataset.sec = sec; board.append(ph); }
    }
    layout();
    const nav = document.getElementById('secnav');
    if (nav) nav.querySelectorAll('.sn-btn').forEach((b) => { const on = b.dataset.sec === sec; b.classList.toggle('on', on); b.setAttribute('aria-current', on ? 'page' : 'false'); });
  }
  /* ================= masonry layout: CSS grid + row spans measured here (gap-free at any width) ================= */
  const ROW = 4; let ro = null, rafL = 0, lastCols = 0;
  function colsOf(board) { return Math.max(1, parseInt(getComputedStyle(board).getPropertyValue('--cols'), 10) || 1); }
  // Classic masonry: each card (in board order) goes to the column(s) whose bottom is highest up; positions are written
  // as explicit grid lines (4 px rows). Then the last card of every column grows to the lowest bottom → an even edge.
  function spanRows(board) {
    const gap = parseFloat(getComputedStyle(board).getPropertyValue('--gap')) || 14, cols = colsOf(board);
    const vis = Array.from(board.children).filter((el) => !el.hidden);
    if (!vis.length) return;
    vis.forEach((el) => { el.style.minHeight = ''; el.style.gridColumn = `span ${Math.min(cols, el._span || 1)}`; el.style.gridRow = 'auto'; });
    const hs = vis.map((el) => el.getBoundingClientRect().height);
    const H = new Array(cols).fill(0), last = new Array(cols).fill(-1), pos = [];
    vis.forEach((el, i) => {
      const sp = Math.min(cols, el._span || 1), rows = Math.max(1, Math.ceil((hs[i] + gap) / ROW));
      let best = 0, bestTop = Infinity;
      for (let c = 0; c + sp <= cols; c++) { const top = Math.max(...H.slice(c, c + sp)); if (top < bestTop) { bestTop = top; best = c; } }
      pos.push({ c: best, sp, top: bestTop, rows });
      for (let c = best; c < best + sp; c++) { H[c] = bestTop + rows; last[c] = i; }
    });
    const maxH = Math.max(...H);
    new Set(last.filter((k) => k >= 0)).forEach((k) => { const p = pos[k], grow = maxH - (p.top + p.rows); if (grow > 0 && cols > 1) { p.rows += grow; vis[k].style.minHeight = (p.rows * ROW - gap) + 'px'; } });
    vis.forEach((el, i) => { const p = pos[i]; el.style.gridColumn = `${p.c + 1} / span ${p.sp}`; el.style.gridRow = `${p.top + 1} / span ${p.rows}`; });
  }
  function layout() {
    const board = document.getElementById('board');
    if (!board || !window.getComputedStyle) return;
    const cols = colsOf(board);
    const vis = Array.from(board.children).filter((el) => !el.hidden);
    const spans = vis.map((el) => {
      if (vis.length === 1 || el.id === 'c-outbox' || el.classList.contains('full')) return cols;
      if (el.id === 'c-hero') return Math.max(1, cols - 1);
      if (el.classList.contains('wide')) return cols >= 3 ? 2 : cols;
      return 1;
    });
    // few cards on a tab: widen them so the row is filled (no empty columns)
    let total = spans.reduce((a, x) => a + x, 0);
    for (let guard = 0; total < cols && guard < 50; guard++) { let k = 0; spans.forEach((x, i) => { if (x < spans[k]) k = i; }); spans[k]++; total++; }
    vis.forEach((el, i) => { el._span = Math.min(spans[i], cols); });
    board.classList.add('masonry');
    lastCols = cols;
    spanRows(board);
    if (window.ResizeObserver) {
      if (!ro) ro = new ResizeObserver(() => { cancelAnimationFrame(rafL); rafL = requestAnimationFrame(() => { const b = document.getElementById('board'); if (b) spanRows(b); }); });
      ro.disconnect(); vis.forEach((el) => ro.observe(el));
    }
  }
  window.addEventListener('resize', () => { const b = document.getElementById('board'); if (!b) return; const c = colsOf(b); if (c !== lastCols) { lastCols = c; layout(); } else spanRows(b); });
  function afterRender(d) {
    buildIndex(d);
    const nav = navEl();
    if (nav) {
      const over = datedItems(d).filter((x) => x.iso < today() && !x.done && ['tasking', 'todo', 'reminder', 'bill'].includes(x.kind)).length;
      const dot = (k, on, txt) => { const b = nav.querySelector(`[data-sec="${k}"] .sn-dot`); if (b) { b.hidden = !on; b.textContent = txt || ''; } };
      dot('week', over > 0, String(over)); dot('today', pending() > 0, String(pending()));
    }
    go(view || (location.hash || '').slice(1) || 'today');
  }
  // Slots for app.js: where each feature card goes on the board.
  function cards(d) {
    const safe = (fn, id) => { try { const el = fn(d); if (el) el.id = id; return el; } catch (e) { console.error(e); return null; } };
    return {
      todayEnd: [ready() && (pending() || lockedOld || clearedNote) ? safe(outboxCard, 'c-outbox') : null],
      todayMid: [safe(quickNotesCard, 'c-quick_notes')],
      week: [safe(weekCard, 'c-week'), safe(reviewCard, 'c-review')],
      goals: [safe(healthCard, 'c-health')],
      links: [safe(linksCard, 'c-links')],
      search: [safe(searchCard, 'c-search')],
    };
  }

  /* ================= due pings (only while the page is open) ================= */
  function tickPings() {
    if (!ready() || !O.settings.duePings || !window.Habits || !window.Habits.notifyOn || !window.Habits.notifyOn()) return;
    const hm = nowHM(); if (hm < '07:00' || hm >= '22:00') return; // quiet hours
    const t = today(), sent = (O.pinged[t] = O.pinged[t] || []);
    for (const k of Object.keys(O.pinged)) if (k !== t) delete O.pinged[k];
    const discreet = window.Habits.discreet();
    let changed = false;
    for (const x of datedItems(merged)) {
      if (x.done || !['bill', 'tasking', 'todo', 'reminder'].includes(x.kind)) continue;
      const dd = D().daysBetween(t, x.iso);
      const when = dd === 0 ? 'today' : dd === 1 ? 'tomorrow' : dd === 3 && x.kind === 'bill' ? 'in 3 days' : null;
      if (!when) continue;
      const tag = `${x.kind}:${x.key || D().hid(x.text)}:${when}`;
      if (sent.includes(tag)) continue;
      sent.push(tag); changed = true;
      const noun = { bill: 'A bill', tasking: 'A tasking', todo: 'A to-do', reminder: 'A reminder' }[x.kind];
      window.Habits.notify(discreet ? '⏰ Due soon' : `${x.ico} Due ${when}`, discreet ? `${noun} is due ${when}.` : `${x.text} — due ${when}.`, 'due-' + tag);
    }
    if (changed) save();
  }
  function startTicker() { stopTicker(); ticker = setInterval(tickPings, 60000); setTimeout(tickPings, 2500); }
  function stopTicker() { clearInterval(ticker); ticker = null; }

  /* ================= sync hooks (sync.js) ================= */
  const syncFields = ({ eid, sec, op, key: k, label, labelText, val, at }) => ({ eid, sec, op, key: k, label, labelText, val, at });
  function syncPayload() { return ready() ? { device: O.device, edits: O.edits.map(syncFields), tomb: Object.assign({}, O.tomb) } : null; }
  // Adopt a merged state from the sync server. Quiet: does not re-trigger a sync. Returns true when the board changed.
  function syncApply(m) {
    if (!ready() || !m) return false;
    const before = curSig();
    O.edits = (m.edits || []).filter(C.validEdit).map(syncFields);
    O.tomb = Object.assign({}, m.tomb || {});
    drop((e) => C.isReflected(raw, e));
    const changed = curSig() !== before;
    save(true);
    if (changed) D().rerender();
    return changed;
  }
  window.Features = { syncPayload, syncApply, unlock, lock, ready, merge, cards, afterRender, set, undo, add, logHealth, logExercise, saveLink, deleteLink, localChip, pending, go, layout, captureEl, healthLogForm,
    recAdd, recSet, recDel, setProgress, logVaDaily, logEntry, toast, exerciseByDay, pendingEdits: () => (O ? O.edits.slice() : []), raw: () => raw, _flush: () => saving, _tick: tickPings };
})();
