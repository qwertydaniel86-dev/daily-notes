/* Daily Notes – progress: Today "Update progress" + "Log money" cards, the Money-tab money log, and the read-only Goals tab
   (computed from habits, Health, WD1, the MMPA checklist, the MPAT log, the VA client hunt and finance). No personal data
   lives in this file: every number comes from the decrypted notes, the encrypted overlay (Outbox edits) or the habit tracker.
   Entry happens only on Today / Money; the Goals tab renders no inputs, buttons or selects. */
(function () {
  'use strict';
  const C = window.EditsCore;
  const TZ = 'Asia/Manila';
  const D = () => window.DN, F = () => (window.Features && window.Features.ready() ? window.Features : null);
  const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
  const weekStart = (iso) => addDays(iso, -((new Date(iso + 'T00:00:00Z').getUTCDay() + 6) % 7));
  const isoOf = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s == null ? '' : String(s)); return m ? m[0] : null; };
  const fmtD = (iso, o) => new Date(iso + 'T12:00:00Z').toLocaleDateString('en-GB', Object.assign({ timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }, o || {}));
  const today = () => D().todayISO();
  const pct = (a, b) => (b > 0 ? Math.max(0, Math.min(100, Math.round((a / b) * 100))) : null);
  const toast = (m) => { const f = window.Features; if (f && f.toast) f.toast(m); };
  const TX_WORD = { expense: 'Expense', bill: 'Paid bill', sent: 'Sent money', received: 'Received' };
  const TX_ICO = { expense: '🛒', bill: '💳', sent: '📤', received: '📥' };

  /* ---------- shared bits ---------- */
  function bar(p, label, cls) {
    const { h } = D();
    return h('div', { class: `bar${p == null ? ' unknown' : ''}${cls ? ' ' + cls : ''}`, role: 'progressbar', 'aria-label': label, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': p ?? 0 }, h('span', { style: { width: (p ?? 0) + '%' } }));
  }
  const tile = (v, l, cls) => D().h('div', { class: `m-stat ${cls || ''}` }, D().h('span', { class: 'm-stat-v' }, v), D().h('span', { class: 'm-stat-l' }, l));
  let closeSheet = null;
  function sheet(title, body, id) {
    const { h } = D();
    if (closeSheet) closeSheet();
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    const panel = h('div', { class: 'sheet pg-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title, id: id || null },
      h('div', { class: 'pg-sheet-h' }, h('strong', null, title), h('button', { type: 'button', class: 'icon', 'aria-label': 'Close', onclick: () => close() }, '✕')), body);
    const bg = h('div', { class: 'sheet-bg pg-sheet-bg', onclick: (e) => { if (e.target === bg) close(); } }, panel);
    function close() { bg.remove(); document.removeEventListener('keydown', onKey); if (closeSheet === close) closeSheet = null; }
    document.addEventListener('keydown', onKey);
    document.body.append(bg); closeSheet = close;
    setTimeout(() => { const f = panel.querySelector('input,select,button:not(.icon)'); if (f) f.focus({ preventScroll: true }); }, 0);
    return close;
  }
  function seg(options, cur, onPick, label, idp) {
    const { h } = D();
    const box = h('div', { class: 'seg pg-seg', role: 'radiogroup', 'aria-label': label });
    options.forEach(([v, l]) => box.append(h('button', { type: 'button', role: 'radio', 'data-v': v, id: idp ? `${idp}-${String(v).toLowerCase().replace(/[^a-z]+/g, '')}` : null, 'aria-checked': String(v === cur), class: v === cur ? 'on' : '',
      onclick: (e) => { box.querySelectorAll('button').forEach((b) => { const on = b === e.currentTarget; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); }); onPick(v); } }, l)));
    return box;
  }
  const field = (label, el, cls) => D().h('label', { class: 'pg-f' + (cls ? ' ' + cls : '') }, D().h('span', null, label), el);

  /* ---------- data access (merged notes) ---------- */
  const fin = (d) => (isObj(d.finance) ? d.finance : {});
  const vaOf = (d) => (isObj(d.va) ? d.va : {});
  function txList(d) {
    return D().objs(d.transactions, 'date').map((it) => ({ it, v: C.txVal(it) })).filter((x) => x.v).sort((a, b) => b.v.date.localeCompare(a.v.date) || String(b.it.id || '').localeCompare(String(a.it.id || '')));
  }
  const isOut = (t) => t !== 'received';
  function flows(list) {
    const o = { in: 0, out: 0, cats: {}, accts: {} };
    list.forEach(({ v }) => {
      const a = (o.accts[v.account] = o.accts[v.account] || { in: 0, out: 0 });
      if (isOut(v.type)) { o.out += v.amount; a.out += v.amount; o.cats[v.category] = (o.cats[v.category] || 0) + v.amount; } else { o.in += v.amount; a.in += v.amount; }
    });
    o.net = o.in - o.out;
    return o;
  }
  function vaDaily(d) {
    const m = {};
    D().objs(vaOf(d).daily, 'date').forEach((x) => { const iso = isoOf(x.date); if (!iso) return; const s = D().num(x.sent), r = D().num(x.replies); m[iso] = { sent: Math.max(0, Math.round(s || 0)), replies: Math.max(0, Math.round(r || 0)), local: !!x._local }; });
    return m;
  }
  const leadsOf = (d) => D().objs(vaOf(d).leads, 'name').map((it) => ({ it, v: C.leadVal(it) })).filter((x) => x.v);
  function studies(d) {
    const raw = d.studies ?? d.mmpa;
    const items = D().arr(Array.isArray(raw) ? raw : isObj(raw) && Array.isArray(raw.subjects) ? raw.subjects : raw);
    const lbl = (it) => (typeof it === 'string' ? it : [D().pick(it, 'code', 'name', 'subject'), D().pick(it, 'title')].filter(Boolean).join(' – ') || '(subject)');
    const exam = isObj(raw) ? D().pick(raw, 'exam_date', 'exam') : D().str(d.mmpa_exam_date);
    return { items: items.map((it) => ({ it, label: lbl(it), done: isObj(it) && !!it.done, local: isObj(it) && it._local })), exam };
  }
  const WD1 = { years: ['⏳', 'Time in service', 'yrs'], live: ['🛰️', 'Live intercepts', ''], sim: ['🖥️', 'Sim intercepts', ''], hours: ['⏱️', 'Hours', 'h'] };
  function wd1Rows(d) {
    const w = isObj(d.wd1) ? d.wd1 : null;
    if (!w) return [];
    const order = Object.keys(WD1);
    return Object.keys(w).filter((k) => isObj(w[k]) && /^[a-z][a-z0-9_]{0,19}$/.test(k)).sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99)).map((k) => {
      const [ico, label, unit] = WD1[k] || ['📌', k.replace(/_/g, ' '), ''];
      const req = D().num(w[k].req ?? w[k].required), cur = D().num(w[k].cur ?? w[k].current);
      return { k, ico, label, unit, req, cur, local: !!w[k]._local, pct: req && cur != null ? pct(cur, req) : null };
    });
  }
  const habits = () => (window.Habits && window.Habits.summary ? window.Habits.summary() : []);
  const habitBy = (hs, seed, re) => hs.find((x) => x.seed === seed) || hs.find((x) => re.test(x.name)) || null;
  function savingsOf(d) {
    const f = fin(d), n = D().num;
    const cur = n(f.savingsTotal) ?? n(f.netWorth) ?? n(f.net_worth);
    const g = isObj(f.savingsGoal) ? f.savingsGoal : null;
    const target = g ? n(g.target) : null, due = g ? isoOf(g.target_date) : null;
    return { cur, src: n(f.savingsTotal) != null ? 'savings total' : cur != null ? 'net worth' : null, asOf: isoOf(f.savingsAsOf), local: !!f._local, goal: g, target, due, title: g ? D().pick(g, 'title') : '' };
  }
  function monthsLeft(due, t) {
    const [y1, m1, d1] = t.split('-').map(Number), [y2, m2, d2] = due.split('-').map(Number);
    return (y2 - y1) * 12 + (m2 - m1) + (d2 - d1) / 30;
  }
  // Pace for a savings goal: remaining / months to the deadline (at least 1 month).
  function savingsMath(cur, target, due, t) {
    if (target == null || !(target > 0)) return null;
    const ml = due ? monthsLeft(due, t) : null;
    if (cur == null) return { target, ml };
    const remaining = Math.max(0, target - cur);
    return { target, ml, cur, remaining, pct: pct(cur, target), pace: ml != null && ml > 0 ? remaining / Math.max(1, ml) : null, past: ml != null && ml <= 0 };
  }

  /* ================= Today: Update progress ================= */
  function legacyStudyTicks(d) {
    const f = F(); if (!f) return;
    let t; try { t = JSON.parse(localStorage.getItem('dn.ticks.v1')) || {}; } catch { return; }
    let moved = 0;
    studies(d).items.forEach((x) => { const id = D().hid('study:' + x.label); if (t[id]) { if (!x.done) { f.set({ sec: 'studies', op: 'done', item: x.it, label: x.label, val: true }); moved++; } delete t[id]; localStorage.setItem('dn.ticks.v1', JSON.stringify(t)); } });
    return moved;
  }
  function counter(label, val, onSet, idp) {
    const { h } = D();
    return h('div', { class: 'pg-ctr' }, h('span', { class: 'pg-ctr-l' }, label),
      h('div', { class: 'pg-ctr-b' },
        h('button', { type: 'button', class: 'st-btn', id: idp + '-minus', 'aria-label': 'Less: ' + label, disabled: val <= 0 || null, onclick: () => onSet(Math.max(0, val - 1)) }, '−'),
        h('span', { class: 'pg-ctr-v', id: idp + '-val', 'aria-live': 'polite' }, String(val)),
        h('button', { type: 'button', class: 'st-btn', id: idp + '-plus', 'aria-label': 'More: ' + label, onclick: () => onSet(val + 1) }, '+')));
  }
  function leadForm(it, close) {
    const { h, pick } = D();
    const v0 = it ? C.leadVal(it) || {} : {};
    const name = h('input', { type: 'text', id: 'ld-name', maxlength: '80', value: v0.name || '', placeholder: 'Client / company', autocomplete: 'off' });
    const role = h('input', { type: 'text', id: 'ld-role', maxlength: '80', value: v0.role || '', placeholder: 'e.g. Executive assistant', autocomplete: 'off' });
    const st = h('select', { id: 'ld-status' }, C.LEAD_STATUS.map((s) => h('option', { value: s, selected: s === (v0.status || 'Interested') || null }, s)));
    const note = h('input', { type: 'text', id: 'ld-note', maxlength: '300', value: v0.note || '', placeholder: 'Optional', autocomplete: 'off' });
    const err = h('p', { class: 'lk-err', role: 'alert' });
    return h('form', { class: 'pg-form', id: 'ld-form', novalidate: true, onsubmit: (e) => {
      e.preventDefault();
      const f = F(); if (!f) return;
      if (C.longDigits(note.value)) { err.textContent = 'Notes can’t contain long numbers (account / ID numbers).'; return; }
      const v = C.leadVal({ name: name.value.trim(), role: role.value.trim(), status: st.value, note: note.value.trim() });
      if (!v) { err.textContent = 'Give the lead a client / company name.'; return; }
      if (it) f.recSet('va.leads', it, v, pick(it, 'name')); else f.recAdd('va.leads', v, v.name);
      if (close) close();
      toast(it ? '✎ Lead updated – syncing via the Outbox' : '🤝 Lead added – syncing via the Outbox');
    } }, h('div', { class: 'pg-grid2' }, field('Client / company', name), field('Role / service', role), field('Status', st), field('Note', note)), err,
      h('div', { class: 'row-btns' }, h('button', { type: 'submit', class: 'qc-add', id: 'ld-save' }, it ? 'Save lead' : 'Add lead'), close ? h('button', { type: 'button', class: 'tiny ghost', onclick: close }, 'Cancel') : null));
  }
  function progressPane(d) {
    const { h, num, fmtNum, peso } = D();
    const f = F(), t = today();
    if (!f) return null;
    legacyStudyTicks(d);
    const sec = (ico, title, kids, cls) => h('section', { class: 'pg-sec' + (cls ? ' ' + cls : '') }, h('h3', { class: 'pg-h' }, ico + ' ' + title), kids);
    // VA outreach (today)
    const vd = vaDaily(d), td = vd[t] || { sent: 0, replies: 0 }, ws = weekStart(t);
    let wS = 0, wR = 0; Object.entries(vd).forEach(([k, x]) => { if (k >= ws && k <= t) { wS += x.sent; wR += x.replies; } });
    const va = sec('💼', 'Work applications · today', [
      h('div', { class: 'pg-ctrs' }, counter('Sent', td.sent, (n) => f.logVaDaily(t, n, td.replies), 'va-sent'), counter('Replies', td.replies, (n) => f.logVaDaily(t, td.sent, n), 'va-replies')),
      h('p', { class: 'small muted' }, `This week: ${wS} sent · ${wR} repl${wR === 1 ? 'y' : 'ies'}${wS ? ` · ${Math.round((wR / wS) * 100)}% reply rate` : ''}`)]);
    // leads
    const leads = leadsOf(d), active = leads.filter((x) => x.v.status !== 'Lost');
    const leadSec = sec('🤝', 'Significant leads', [
      active.length ? h('ul', { class: 'pg-leads' }, active.map((x) => h('li', { class: 'pg-lead' + (['Interview', 'Offer'].includes(x.v.status) ? ' hot' : '') },
        h('span', { class: 'pg-lead-t' }, h('strong', null, x.v.name), x.v.role ? h('span', { class: 'muted small' }, ' · ' + x.v.role) : null, D().h('span', null, ' '), window.Features.localChip(x.it)),
        h('select', { class: 'st-sel', 'aria-label': 'Lead status: ' + x.v.name, onchange: (e) => { f.recSet('va.leads', x.it, Object.assign({}, x.v, { status: e.target.value }), x.v.name); toast(`🤝 ${x.v.name} → ${e.target.value}`); } },
          C.LEAD_STATUS.map((s) => h('option', { value: s, selected: s === x.v.status || null }, s))),
        h('button', { type: 'button', class: 'icon', 'aria-label': 'Edit lead: ' + x.v.name, onclick: () => { const cl = sheet('✎ Edit lead', leadForm(x.it, () => cl()), 'ld-sheet'); } }, '✎')))) : h('p', { class: 'small muted' }, 'No leads yet.'),
      leads.length > active.length ? h('p', { class: 'small muted' }, `${leads.length - active.length} lost lead${leads.length - active.length > 1 ? 's' : ''} hidden`) : null,
      h('button', { type: 'button', class: 'tiny', id: 'ld-add', onclick: () => { const cl = sheet('🤝 Significant lead', leadForm(null, () => cl()), 'ld-sheet'); } }, '＋ Significant lead')]);
    // WD1
    const rows = wd1Rows(d);
    const wForm = rows.length ? h('form', { class: 'pg-form', id: 'wd1-form', novalidate: true, onsubmit: (e) => {
      e.preventDefault();
      let n = 0, bad = '';
      rows.forEach((r) => { const el = wForm.querySelector(`[data-k="${r.k}"]`), s = el.value.trim(), v = s === '' ? null : num(s);
        if (s !== '' && (v == null || v < 0)) { bad = r.label; return; }
        const vv = v == null ? null : Math.round(v * 100) / 100;
        if (vv !== r.cur) { f.setProgress('wd1.' + r.k, vv); n++; } });
      toast(bad ? `⚠️ ${bad}: enter a number` : n ? `🛫 WD1 updated (${n}) – syncing via the Outbox` : 'No change');
    } }, h('div', { class: 'pg-grid2' }, rows.map((r) => field(`${r.ico} ${r.label}${r.req != null ? ` (of ${fmtNum(r.req)}${r.unit ? ' ' + r.unit : ''})` : ''}`,
      h('input', { type: 'number', inputmode: 'decimal', step: 'any', min: '0', 'data-k': r.k, id: 'wd1-' + r.k, value: r.cur == null ? '' : String(r.cur), placeholder: 'not set' })))),
      h('button', { type: 'submit', class: 'qc-add', id: 'wd1-save' }, 'Save WD1')) : h('p', { class: 'small muted' }, 'No WD1 tracker in notes yet.');
    const wdSec = sec('🛫', 'WD1 tracker', wForm);
    // MMPA ticks
    const st = studies(d), nd = st.items.filter((x) => x.done).length;
    const mmSec = sec('📚', `MMPA checklist · ${nd}/${st.items.length}`, st.items.length ? h('ul', { class: 'checks pg-checks' }, st.items.map((x, i) => h('li', { class: x.done ? 'done' : '' },
      h('input', { type: 'checkbox', id: 'mm-' + i, checked: x.done || null, onchange: (e) => f.set({ sec: 'studies', op: 'done', item: x.it, label: x.label, val: e.target.checked }) }),
      h('label', { for: 'mm-' + i }, x.label, x.local ? h('span', { class: 'chip local' }, '✎') : null)))) : h('p', { class: 'small muted' }, 'No subjects listed yet.'));
    // MPAT log entry
    const mD = h('input', { type: 'date', id: 'mp-date', value: t, max: t }), mA = h('input', { type: 'text', id: 'mp-area', maxlength: '60', placeholder: 'Area (e.g. Spatial)' });
    const mS = h('input', { type: 'text', id: 'mp-score', maxlength: '20', placeholder: 'Score' }), mT = h('input', { type: 'text', id: 'mp-time', maxlength: '20', placeholder: 'Time' });
    const mN = h('input', { type: 'text', id: 'mp-notes', maxlength: '300', placeholder: 'Notes / weak spots' });
    const mpSec = sec('✈️', 'MPAT practice log', h('form', { class: 'pg-form', id: 'mp-form', novalidate: true, onsubmit: (e) => {
      e.preventDefault();
      const v = C.mpatVal({ date: mD.value || t, area: mA.value.trim(), score: mS.value.trim(), time: mT.value.trim(), notes: mN.value.trim() });
      if (!v || !(v.area || v.score || v.time || v.notes)) { toast('Add an area, score, time or note'); return; }
      f.logEntry('mpat_log', v, `${v.date} ${v.area || ''}`.trim()); toast('✈️ Practice logged – syncing via the Outbox');
    } }, h('div', { class: 'pg-grid2' }, mD, mA, mS, mT), mN, h('button', { type: 'submit', class: 'qc-add', id: 'mp-save' }, 'Log session')));
    // savings
    const sv = savingsOf(d);
    const sIn = h('input', { type: 'number', id: 'sv-total', inputmode: 'decimal', step: 'any', min: '0', placeholder: 'Total savings ₱', value: num(fin(d).savingsTotal) == null ? '' : String(num(fin(d).savingsTotal)) });
    const svSec = sec('💰', 'Savings total', h('form', { class: 'pg-form', id: 'sv-form', novalidate: true, onsubmit: (e) => {
      e.preventDefault();
      const s = sIn.value.trim(), v = s === '' ? null : num(s);
      if (s !== '' && (v == null || v < 0)) { toast('Enter the total in pesos'); return; }
      f.setProgress('finance.savingsTotal', v == null ? null : Math.round(v * 100) / 100); toast(v == null ? 'Savings total cleared' : '💰 Savings total saved – syncing via the Outbox');
    } }, h('div', { class: 'qc-row' }, sIn, h('button', { type: 'submit', class: 'qc-add', id: 'sv-save' }, 'Save')),
      h('p', { class: 'small muted' }, sv.cur != null ? `Now ${peso(sv.cur)}${sv.asOf ? ' · as of ' + fmtD(sv.asOf) : ''} (${sv.src})` : 'Current savings not set yet. All accounts combined; account names only, never numbers.')));
    const au = isObj(d.auto) ? d.auto : {};
    const opt = (el, on, why) => (on ? h('details', { class: 'pg-opt' }, h('summary', null, `✍️ Manual entry (optional) · ${why}`), el) : el);
    return h('div', { class: 'pg-secs', id: 'c-progress' }, opt(va, !!au.work, 'auto from the tracker'), leadSec, mmSec,
      opt(wdSec, !!au.abm, 'controls & hours auto from the ABM board'), opt(mpSec, !!(au.mpat && au.mpat.attempts), 'auto from the MPAT app'), svSec);
  }
  /* ================= Today: one "Update" card – 💸 Money · 💪 Health · 📈 Progress (one pane at a time) ================= */
  let upPane = 'money';
  function updateCard(d) {
    const { h, card } = D();
    const f = F();
    if (!f) return null;
    const panes = { money: logMoneyPane(d), health: f.healthLogForm ? h('div', { id: 'c-healthlog' }, f.healthLogForm()) : null, progress: progressPane(d) };
    const show = (v) => { upPane = v; Object.entries(panes).forEach(([k, el]) => { if (el) el.hidden = k !== v; }); };
    const segEl = seg([['money', '💸 Money'], ['health', '💪 Health'], ['progress', '📈 Progress']].filter(([k]) => panes[k]), upPane, show, 'What to update', 'up-t');
    show(panes[upPane] ? upPane : 'money');
    return card('lilac', '📝', 'Update', [segEl, Object.values(panes)], { wide: true, sub: 'Money · health · progress → feeds Money & Goals · syncs via the Outbox' });
  }

  /* ================= Money: transaction form (Today quick entry + edit sheet) ================= */
  function txForm(d, it, close, idp) {
    const { h, pick, num, billRows, peso } = D();
    const v0 = it ? C.txVal(it) : null, t = today();
    let type = v0 ? v0.type : 'expense';
    const amt = h('input', { type: 'number', id: idp + '-amt', inputmode: 'decimal', step: '0.01', min: '0', placeholder: 'Amount ₱', value: v0 ? String(v0.amount) : '', 'aria-label': 'Amount in PHP' });
    const cat = h('select', { id: idp + '-cat', 'aria-label': 'Category' });
    const acct = h('select', { id: idp + '-acct', 'aria-label': 'Account' }, C.TX_ACCOUNTS.map((a) => h('option', { value: a, selected: (v0 ? v0.account : 'GCash') === a || null }, a)));
    const date = h('input', { type: 'date', id: idp + '-date', value: v0 ? v0.date : t, 'aria-label': 'Date' });
    const note = h('input', { type: 'text', id: idp + '-note', maxlength: '200', placeholder: 'Note (optional)', value: v0 && v0.note ? v0.note : '', autocomplete: 'off', 'aria-label': 'Note' });
    const unpaid = billRows(d).filter((r) => r.key !== 'paid' || (v0 && v0.bill && pick(r.it, 'name', 'title') === v0.bill));
    const bill = h('select', { id: idp + '-bill', 'aria-label': 'Which bill / loan' }, h('option', { value: '' }, '— pick a bill / loan (optional) —'),
      unpaid.map((r, i) => { const nm = pick(r.it, 'name', 'title') || 'Bill'; return h('option', { value: String(i), selected: (v0 && v0.bill === nm) || null }, `${nm}${r.amount != null ? ' · ' + peso(r.amount) : ''}${r.dt && r.dt.iso ? ' · ' + fmtD(r.dt.iso, { weekday: undefined }) : ''}`); }));
    const billWrap = h('div', { class: 'pg-bill' }, bill);
    bill.addEventListener('change', () => { const r = unpaid[+bill.value]; if (r && r.amount != null && !amt.value) amt.value = String(r.amount); if (r) { const nm = pick(r.it, 'name', 'title'); const c = /loan/i.test(nm) ? 'Loan' : 'Bills'; cat.value = c; } });
    const fillCats = () => { const cs = type === 'received' ? C.TX_IN : C.TX_OUT, keep = cat.value || (v0 && v0.type === type ? v0.category : type === 'bill' ? 'Bills' : type === 'sent' ? 'Family' : type === 'received' ? 'Salary' : 'Food');
      cat.replaceChildren(...cs.map((c) => h('option', { value: c, selected: c === keep || null }, c))); if (!cs.includes(cat.value)) cat.value = cs[0]; billWrap.hidden = type !== 'bill'; };
    const segEl = seg(C.TX_TYPES.map((k) => [k, `${TX_ICO[k]} ${TX_WORD[k]}`]), type, (v) => { type = v; cat.value = ''; fillCats(); }, 'Type', idp + '-t');
    fillCats();
    const err = h('p', { class: 'lk-err', role: 'alert' });
    const form = h('form', { class: 'pg-form tx-form', id: idp + '-form', novalidate: true, onsubmit: (e) => {
      e.preventDefault();
      const f = F(); if (!f) return;
      if (C.longDigits(note.value)) { err.textContent = 'Notes can’t contain long numbers (account / ID numbers) – account names only.'; return; }
      const r = type === 'bill' ? unpaid[+bill.value] : null, billName = r ? pick(r.it, 'name', 'title') : v0 && type === 'bill' ? v0.bill : '';
      const v = C.txVal({ type, amount: num(amt.value), category: cat.value, account: acct.value, date: date.value || t, note: note.value.trim(), bill: billName });
      if (!v) { err.textContent = 'Enter an amount above ₱0 and a date.'; return; }
      if (it) f.recSet('transactions', it, v, C.textOf('transactions', it)); else f.recAdd('transactions', v);
      // "Paid bill" + a picked bill → reuse the existing bill "mark paid" edit
      if (r && r.key !== 'paid') f.set({ sec: 'bills', op: 'status', item: r.it, label: billName || 'bill', val: 'paid' });
      if (close) close();
      else { amt.value = ''; note.value = ''; }
      toast(`${TX_ICO[type]} ${it ? 'Entry updated' : 'Logged'} ${peso(v.amount)}${r && r.key !== 'paid' ? ' · bill marked paid' : ''} – syncing via the Outbox`);
    } }, segEl,
      h('div', { class: 'tx-row' }, amt, cat, acct), h('div', { class: 'tx-row' }, date, note), billWrap, err,
      h('div', { class: 'row-btns' }, h('button', { type: 'submit', class: 'qc-add', id: idp + '-save' }, it ? 'Save' : 'Log'),
        close ? h('button', { type: 'button', class: 'tiny ghost', onclick: close }, 'Cancel') : null,
        it ? h('button', { type: 'button', class: 'tiny ghost lk-del', id: idp + '-del', onclick: () => {
          if (!confirm('Delete this money entry?')) return; const f = F(); if (f) f.recDel('transactions', it, C.textOf('transactions', it)); if (close) close(); toast('🗑️ Entry deleted – undo by discarding it in the Outbox');
        } }, '🗑️ Delete') : null));
    return form;
  }
  const editTx = (d, it) => { const cl = sheet('✎ Edit money entry', txForm(d, it, () => cl(), 'txe'), 'tx-sheet'); };
  function txRow(d, x, canEdit) {
    const { h, peso } = D(), v = x.v;
    return h('li', { class: 'tx-it' + (isOut(v.type) ? ' out' : ' in') },
      h('span', { class: 'tx-ico', 'aria-hidden': 'true' }, TX_ICO[v.type]),
      h('span', { class: 'tx-main' }, h('strong', null, v.bill || v.category), h('span', { class: 'muted small' }, ` · ${v.account} · ${fmtD(v.date)}`), v.note ? h('span', { class: 'tx-note small' }, v.note) : null, window.Features.localChip(x.it)),
      h('span', { class: 'tx-amt m-num' }, (isOut(v.type) ? '−' : '+') + peso(v.amount)),
      canEdit ? h('button', { type: 'button', class: 'icon tx-edit', 'aria-label': 'Edit entry', onclick: () => editTx(d, x.it) }, '✎') : null);
  }
  function logMoneyPane(d) {
    const { h, peso } = D();
    const t = today(), fl = flows(txList(d).filter((x) => x.v.date === t));
    return h('div', { id: 'c-logmoney' }, txForm(d, null, null, 'tx'),
      h('p', { class: 'small muted' }, `Today: −${peso(fl.out)} out · +${peso(fl.in)} in · full list on 💰 Money`));
  }
  function moneyLogCard(d) {
    const { h, card, peso, empty } = D();
    const t = today(), month = t.slice(0, 7), canEdit = !!F();
    const list = txList(d), mon = list.filter((x) => x.v.date.slice(0, 7) === month), fl = flows(mon);
    const mName = new Date(t + 'T12:00:00+08:00').toLocaleDateString('en-GB', { timeZone: TZ, month: 'long', year: 'numeric' });
    const tiles = h('div', { class: 'm-stats' }, tile('+' + peso(fl.in), '📥 In', 'm-paid'), tile('−' + peso(fl.out), '📤 Out', 'm-over'), tile((fl.net < 0 ? '−' : '+') + peso(Math.abs(fl.net)), '= Net', fl.net < 0 ? 'm-unpaid' : 'm-gross'));
    const cats = Object.entries(fl.cats).sort((a, b) => b[1] - a[1]), mx = Math.max(1, ...cats.map((c) => c[1]));
    const catEl = cats.length ? h('ul', { class: 'ex-bars tx-cats' }, cats.map(([k, v]) => h('li', null, h('span', { class: 'ex-k' }, k), h('span', { class: 'ex-bar' }, h('span', { style: { width: Math.round((v / mx) * 100) + '%' } })), h('span', { class: 'ex-v' }, peso(v))))) : null;
    const accts = Object.entries(fl.accts).sort((a, b) => (b[1].in + b[1].out) - (a[1].in + a[1].out));
    const acctEl = accts.length ? h('table', { class: 'hl-tbl tx-acct' }, h('thead', null, h('tr', null, h('th', null, 'Account'), h('th', null, 'In'), h('th', null, 'Out'), h('th', null, 'Net'))),
      h('tbody', null, accts.map(([k, a]) => h('tr', null, h('td', null, k), h('td', { class: 'm-num' }, peso(a.in)), h('td', { class: 'm-num' }, peso(a.out)), h('td', { class: 'm-num' + (a.in - a.out < 0 ? ' neg' : '') }, (a.in - a.out < 0 ? '−' : '') + peso(Math.abs(a.in - a.out))))))) : null;
    const body = [h('p', { class: 'm-h' }, `📅 ${mName}`), tiles,
      catEl ? [h('p', { class: 'm-h' }, '🧾 Spending by category'), catEl] : null,
      acctEl ? [h('p', { class: 'm-h' }, '🏦 Per account'), acctEl] : null,
      h('div', { class: 'row-btns' }, h('p', { class: 'm-h' }, '🕒 Recent'), canEdit ? h('button', { type: 'button', class: 'tiny', id: 'txm-add', onclick: () => { const cl = sheet('💸 Log money', txForm(d, null, () => cl(), 'txn'), 'tx-sheet'); } }, '＋ Log money') : null),
      list.length ? h('ul', { class: 'tx-list' }, list.slice(0, 25).map((x) => txRow(d, x, canEdit))) : empty('No money logged yet — use 📝 Update → Money on Today.'),
      list.length > 25 ? h('p', { class: 'small muted' }, `${list.length - 25} older entries not shown`) : null,
      h('p', { class: 'small muted' }, 'From your own log (and Denx’s receipts) – not a bank statement. Account names only.')];
    return card('aqua', '📒', 'Money log', body, { wide: true, badge: mon.length ? `${mon.length} this month` : null, sub: 'Money · expenses, bills, transfers and income you logged' });
  }
  // For the Free cash card (app.js): real logged spending in [start, end).
  function loggedBetween(d, start, end) {
    const xs = txList(d).filter((x) => x.v.date >= start && x.v.date < end);
    const out = xs.filter((x) => isOut(x.v.type)).reduce((a, x) => a + x.v.amount, 0);
    const extraIn = xs.filter((x) => !isOut(x.v.type) && x.v.category !== 'Salary').reduce((a, x) => a + x.v.amount, 0);
    const billOut = xs.filter((x) => x.v.type === 'bill').reduce((a, x) => a + x.v.amount, 0);
    return { n: xs.length, out, extraIn, billOut };
  }

  /* ================= Goals (read-only) ================= */
  function metricOf(g) {
    const m = String(g.metric || '').toLowerCase().trim();
    if (m) return m;
    const t = `${D().pick(g, 'title', 'name')} ${D().pick(g, 'area', 'category')}`.toLowerCase();
    if (/\bwd1\b|upgrade/.test(t)) return 'wd1';
    if (/mmpa|comprehensive|master'?s|thesis/.test(t)) return 'studies';
    if (/\bmpat\b/.test(t)) return 'mpat';
    if (/exercise|fitness|\bpft\b|\brun\b|gym/.test(t)) return 'exercise';
    if (/sleep/.test(t)) return 'sleep';
    if (/devotion|prayer|bible|faith|spiritual/.test(t)) return 'faith';
    if (/\bva\b|virtual assist|client hunt/.test(t)) return 'va';
    if (/saving|net worth|million|₱|\bphp\b/.test(t)) return 'savings';
    return '';
  }
  function computeGoal(d, g, hs, t) {
    const metric = metricOf(g), lines = [];
    let p = null;
    const hab = (seed, re) => habitBy(hs, seed, re);
    const habLine = (x) => x ? `${x.emoji} ${x.name}: ${x.weekly ? `${x.weekDays}/${x.weekly} this week` : `${x.type === 'check' ? '' : `${x.today}/${x.target} today · `}${Math.round((x.rate30 ?? 0) * 100)}% of days (30d)`}` : null;
    if (metric === 'wd1') {
      const rs = wd1Rows(d), set = rs.filter((r) => r.pct != null);
      if (set.length) p = Math.round(set.reduce((a, r) => a + r.pct, 0) / set.length); // per-criterion detail: wd1Block
    } else if (metric === 'studies') {
      const st = studies(d), n = st.items.filter((x) => x.done).length;
      if (st.items.length) p = pct(n, st.items.length); // subject list: studiesBlock
      const sm = hab('mmpa', /mmpa|study/i); if (sm && (sm.monthVal || sm.weekVal)) lines.push(`${sm.emoji} ${sm.name}: ${sm.weekVal} ${sm.unit || ''} this week · ${Math.round((sm.rate30 ?? 0) * 100)}% of days (30d)`.replace(/\s+·/, ' ·'));
    } else if (metric === 'mpat') {
      const x = hab('mpat', /\bmpat\b/i), logs = D().arr(d.mpat_log ?? d.mpat).length;
      if (x && x.monthVal) { p = Math.round((x.rate30 ?? 0) * 100); lines.push(habLine(x)); }
      if (logs) lines.push(`✈️ ${logs} practice session${logs > 1 ? 's' : ''} logged`);
    } else if (metric === 'exercise' || metric === 'sleep' || metric === 'faith') {
      const xs = metric === 'exercise' ? [hab('exercise', /^exercise/i)] : metric === 'sleep' ? [hab('sleep', /sleep/i)] : [hab('devotion', /devotion|bible/i), hab('prayer', /^prayer/i)];
      const live = xs.filter((x) => x && x.monthVal);
      if (live.length) { p = Math.round((live.reduce((a, x) => a + (x.rate30 ?? 0), 0) / live.length) * 100); live.forEach((x) => lines.push(habLine(x))); }
      if (metric === 'sleep') { const sl = sleepAvg(d, t); if (sl) { lines.push(`😴 ${sl.avg.toFixed(1)} h average (last ${sl.n} nights)`); if (p == null) p = pct(sl.avg, 7); } }
    } else if (metric === 'va') {
      const s = vaStats(d, t); const rank = { Interested: 25, Interview: 50, Offer: 75, Hired: 100 };
      const best = Math.max(0, ...leadsOf(d).map((x) => rank[x.v.status] || 0));
      if (s.all.sent || best) p = best; // totals table: vaBlock
    } else if (metric === 'savings') {
      const sv = savingsOf(d), m = savingsMath(sv.cur, D().num(g.target) ?? sv.target, isoOf(g.target_date) || sv.due, t);
      if (m && m.cur != null) { p = m.pct; lines.push(`${D().peso(m.cur)} of ${D().peso(m.target)}`); }
    }
    let src = metric && p != null ? 'auto' : null;
    const ms = D().objs(g.milestones, 'text');
    if (p == null && D().num(g.progress_pct) != null) { p = Math.max(0, Math.min(100, D().num(g.progress_pct))); src = 'notes'; }
    if (p == null && ms.length) { p = pct(ms.filter((m) => m.done).length, ms.length); src = 'milestones'; }
    return { p, lines: lines.filter(Boolean), src, metric, ms };
  }
  function sleepAvg(d, t) {
    const hh = isObj(d.health) ? d.health : {};
    const xs = D().objs(hh.sleep, 'date').map((x) => ({ iso: isoOf(x.date), v: D().num(x.hours) })).filter((x) => x.iso && x.v != null && x.iso <= t && x.iso >= addDays(t, -6));
    return xs.length ? { avg: xs.reduce((a, x) => a + x.v, 0) / xs.length, n: xs.length } : null;
  }
  const AREA_COLORS = ['sky', 'mint', 'lav', 'peach', 'rose', 'lemon', 'aqua', 'lilac', 'coral'];
  const goalState = (g) => { const s = String(g.status || '').toLowerCase().trim(); return /hold|pause|parked/.test(s) ? 'hold' : /done|complete|achieved|closed/.test(s) ? 'done' : 'active'; };
  function goalLink(d, g) {
    const { h, pick, objs } = D();
    const ref = D().str(g.link); if (!ref) return null;
    const L = objs(d.links, 'title').find((x) => D().str(x.id) === ref);
    const url = C.safeUrl(L ? pick(L, 'url', 'href') : ref);
    return url ? h('a', { class: 'gl-link', href: url, target: '_blank', rel: 'noopener noreferrer' }, '🔗 ', L ? pick(L, 'title', 'name') : 'Open', ' ↗') : null;
  }
  function wd1Block(d) {
    const { h, fmtNum, objs, pick, fmtDate, isoDate } = D();
    const rs = wd1Rows(d);
    const duty = objs(d.duty_log ?? d.duty, 'notes').filter((x) => isoDate(x.date) && isoDate(x.date) <= today()).sort((a, b) => String(b.date).localeCompare(String(a.date)));
    if (!rs.length && !duty.length) return null;
    const last = duty[0];
    return h('div', { class: 'gl-blk', id: 'c-wd1' }, rs.map((r) => h('div', { class: 'gl-crit' + (r.pct === 100 ? ' met' : '') },
      h('div', { class: 'meter-top' }, h('span', null, r.ico, ' ', r.label, r.local ? h('span', { class: 'chip local' }, '✎') : null),
        h('span', { class: 'small' }, r.cur == null ? h('span', { class: 'muted' }, `not set / ${fmtNum(r.req)}`) : `${fmtNum(r.cur)} / ${fmtNum(r.req)}${r.unit ? ' ' + r.unit : ''}`, r.pct != null ? ` · ${r.pct >= 100 ? '✓' : r.pct + '%'}` : '')),
      bar(r.pct, r.label, 'thin'))),
      last ? h('p', { class: 'small muted' }, '📡 Last duty: ', fmtDate(isoDate(last.date), { weekday: 'short' }), [pick(last, 'bcc', 'site'), pick(last, 'shift')].filter(Boolean).map((x) => ' · ' + x).join(''), ` · ${duty.length} logged`) : null);
  }
  function studiesBlock(d) {
    const { h, dueInfo } = D();
    const st = studies(d);
    if (!st.items.length) return null;
    const n = st.items.filter((x) => x.done).length, p = pct(n, st.items.length), left = st.items.filter((x) => !x.done);
    const examDi = st.exam ? dueInfo(st.exam, false) : null;
    return h('div', { class: 'gl-blk', id: 'c-studies' }, h('p', { class: 'small' }, `📚 ${n} / ${st.items.length} reviewed`, examDi ? h('span', { class: `chip ${examDi.cls}` }, '🗓️ Exam: ', examDi.label) : null),
      left.length ? h('div', { class: 'gl-chips' }, left.map((x) => h('span', { class: 'chip' + (x.local ? ' local' : '') }, x.label))) : h('p', { class: 'small' }, '🎉 All subjects reviewed'));
  }
  function mpatBlock(d) {
    const { h, objs, pick } = D();
    const xs = objs(d.mpat_log ?? d.mpat, 'notes').filter((x) => isoOf(x.date)).sort((a, b) => String(b.date).localeCompare(String(a.date)));
    return h('div', { class: 'gl-blk', id: 'c-mpat' }, xs.length ? h('ul', { class: 'gl-why small' }, xs.slice(0, 3).map((x) => h('li', null, `✈️ ${fmtD(isoOf(x.date))}`, [pick(x, 'area', 'section', 'test'), pick(x, 'score'), pick(x, 'time', 'duration')].filter(Boolean).map((y) => ' · ' + y).join(''),
      pick(x, 'notes', 'note') ? h('span', { class: 'muted' }, ' — ' + pick(x, 'notes', 'note')) : null, x._local ? h('span', { class: 'chip local' }, '✎') : null))) : h('p', { class: 'small muted' }, '✈️ No practice sessions logged yet — log them on 🏠 Today → Update → Progress.'));
  }
  function vaBlock(d) {
    const { h } = D();
    const t = today(), s = vaStats(d, t), leads = leadsOf(d);
    if (!s.all.sent && !s.all.replies && !leads.length) return h('div', { class: 'gl-blk', id: 'c-va' }, h('p', { class: 'small muted' }, '💼 No applications logged yet — counters on 🏠 Today → Update → Progress.'));
    const rate = (x) => (x.sent ? `${Math.round((x.replies / x.sent) * 100)}%` : '—');
    const by = {}; leads.forEach((x) => { by[x.v.status] = (by[x.v.status] || 0) + 1; });
    const hot = leads.filter((x) => ['Interview', 'Offer'].includes(x.v.status));
    return h('div', { class: 'gl-blk', id: 'c-va' },
      h('table', { class: 'hl-tbl va-tbl' }, h('thead', null, h('tr', null, h('th', null, ''), h('th', null, 'Sent'), h('th', null, 'Replies'), h('th', null, 'Rate'))),
        h('tbody', null, [['This week', s.week], ['All-time', s.all]].map(([l, x]) => h('tr', null, h('td', null, l), h('td', { class: 'm-num' }, String(x.sent)), h('td', { class: 'm-num' }, String(x.replies)), h('td', { class: 'm-num' }, rate(x)))))),
      leads.length ? h('div', { class: 'wk-chips' }, C.LEAD_STATUS.filter((k) => by[k] && k !== 'Lost').map((k) => h('span', { class: `chip va-st va-${k.toLowerCase()}` }, `${k} ${by[k]}`))) : null,
      hot.length ? h('ul', { class: 'va-hot' }, hot.map((x) => h('li', null, x.v.status === 'Offer' ? '🎉 ' : '🗓️ ', h('strong', null, x.v.name), x.v.role ? ` · ${x.v.role}` : '', ' ', h('span', { class: 'chip va-st va-' + x.v.status.toLowerCase() }, x.v.status), x.v.note ? h('span', { class: 'muted small' }, ' · ' + x.v.note) : null))) : null);
  }
  function savingsBlock(d) {
    const { h, peso } = D();
    const sv = savingsOf(d), t = today();
    if (!sv.goal) return null;
    const m = savingsMath(sv.cur, sv.target, sv.due, t);
    const month = t.slice(0, 7), mon = txList(d).filter((x) => x.v.date.slice(0, 7) === month), fl = flows(mon);
    const dueTxt = sv.due ? fmtD(sv.due, { weekday: undefined, year: 'numeric' }) : 'no target date';
    const kids = [];
    if (!m) kids.push(h('p', { class: 'small muted' }, 'Savings goal has no target amount yet.'));
    else if (m.cur == null) kids.push(h('div', { class: 'meter' }, bar(null, sv.title), h('div', { class: 'meter-foot small muted' }, `current savings not set yet · target ${peso(m.target)} by ${dueTxt}${m.ml != null ? ` (${Math.max(0, Math.round(m.ml))} mo)` : ''}`)),
      h('p', { class: 'small muted' }, 'Set your total savings on 🏠 Today → Update → Progress (or Denx adds finance.savingsTotal).'));
    else kids.push(h('div', { class: 'meter' }, h('div', { class: 'meter-top' }, h('span', null, `${peso(m.cur)} of ${peso(m.target)}`), h('span', { class: 'small' }, `${m.pct}%`)), bar(m.pct, sv.title),
        h('div', { class: 'meter-foot small muted' }, `${sv.src}${sv.asOf ? ' · as of ' + fmtD(sv.asOf) : ''}${sv.local ? ' · ✎ this device' : ''} · target ${dueTxt}`)),
      h('div', { class: 'm-stats' }, tile(peso(m.remaining), '⛰️ Remaining', 'm-over'),
        tile(m.remaining <= 0 ? '🎉 done' : m.past ? 'past due' : m.pace != null ? peso(Math.ceil(m.pace)) : '—', m.remaining <= 0 ? 'Goal reached' : `📆 Needed / month${m.ml != null && m.ml > 0 ? ` · ${Math.ceil(m.ml)} mo left` : ''}`, 'm-unpaid')));
    if (mon.length) kids.push(h('p', { class: 'small muted' }, `📒 Logged this month: ${fl.net < 0 ? '−' : '+'}${peso(Math.abs(fl.net))} net (supporting info only – never changes the total)`));
    return h('div', { class: 'gl gl-sav', id: 'c-savings' }, h('div', { class: 'm-top' }, h('strong', { class: 'm-name' }, '💰 ', sv.title || 'Savings goal'), h('span', { class: 'chip area c-sun' }, 'Finance')), kids);
  }
  const BLOCK = { wd1: [wd1Block, 'WD1 upgrade', 'Career'], studies: [studiesBlock, 'MMPA study checklist', 'Studies'], mpat: [mpatBlock, 'MPAT practice', 'Career'], va: [vaBlock, 'Work applications', 'Career'] };
  function goalsCard(d) {
    const { h, card, pick, objs, dueInfo, empty, hid } = D();
    const t = today(), hs = habits();
    const gs = objs(d.goals, 'title').map((g) => ({ g, st: goalState(g), r: computeGoal(d, g, hs, t) }));
    gs.forEach((x) => { if (x.st === 'active' && x.r.src !== 'auto' && x.r.p === 100) x.st = 'done'; });
    const active = gs.filter((x) => x.st === 'active'), hold = gs.filter((x) => x.st === 'hold'), done = gs.filter((x) => x.st === 'done');
    // trackers without a goal in notes.json still get a row (nothing that used to be on Goals disappears)
    const hasData = { wd1: () => wd1Rows(d).length || D().arr(d.duty_log).length, studies: () => studies(d).items.length, mpat: () => D().arr(d.mpat_log ?? d.mpat).length, va: () => isObj(d.va) };
    Object.keys(BLOCK).forEach((k) => { if (!active.some((x) => x.r.metric === k) && !hold.some((x) => x.r.metric === k) && hasData[k]()) { const g = { title: BLOCK[k][1], area: BLOCK[k][2], metric: k }; active.push({ g, st: 'active', r: computeGoal(d, g, hs, t) }); } });
    const used = new Set();
    const areaChip = (area) => (area ? h('span', { class: `chip area c-${AREA_COLORS[parseInt(hid(area.toLowerCase()), 36) % AREA_COLORS.length]}` }, area) : null);
    const row = ({ g, r }) => {
      const area = pick(g, 'area', 'category'), di = dueInfo(g.target_date, r.p === 100);
      const blk = BLOCK[r.metric] && !used.has(r.metric) ? (used.add(r.metric), BLOCK[r.metric][0](d)) : null;
      const msLeft = r.ms.filter((m) => !m.done), msDone = r.ms.length - msLeft.length;
      return h('div', { class: 'gl' },
        h('div', { class: 'm-top' }, h('strong', { class: 'm-name' }, pick(g, 'title', 'name') || '(goal)'), areaChip(area)),
        h('div', { class: 'meter' }, bar(r.p, pick(g, 'title')),
          h('div', { class: 'meter-foot small muted' }, r.p == null ? 'no data yet' : `${r.p}%${r.src === 'notes' ? ' · from notes' : r.src === 'milestones' ? ' · milestones' : ''}`, di ? h('span', { class: `chip ${di.cls}` }, '🏁 ', di.label) : null)),
        r.lines.length ? h('ul', { class: 'gl-why small' }, r.lines.map((x) => h('li', null, x))) : null,
        blk,
        pick(g, 'next_step', 'next') ? h('p', { class: 'gl-next' }, '👉 ', pick(g, 'next_step', 'next')) : null,
        msLeft.length ? h('ul', { class: 'gl-mlist' }, msLeft.map((m) => h('li', null, '⬜ ', pick(m, 'text', 'title', 'item')))) : null,
        msDone ? h('p', { class: 'small muted' }, `✅ ${msDone} milestone${msDone > 1 ? 's' : ''} done`) : null,
        goalLink(d, g));
    };
    const sav = savingsBlock(d);
    if (!active.length && !hold.length && !sav) return card('peach', '🎯', 'Goals', empty('No goals yet — Denx adds them to notes.json (see README).'));
    const holdEl = hold.length ? h('div', { class: 'gl-hold' }, h('p', { class: 'm-h' }, `⏸️ On hold (${hold.length})`),
      h('ul', { class: 'gl-why small' }, hold.map(({ g }) => h('li', null, h('strong', null, pick(g, 'title', 'name')), pick(g, 'next_step', 'next', 'note') ? h('span', { class: 'muted' }, ' — ' + pick(g, 'next_step', 'next', 'note')) : null, ' ', goalLink(d, g))))) : null;
    const auto = active.filter((x) => x.r.src === 'auto').length;
    return card('peach', '🎯', 'Goals', [h('div', { class: 'gl-list' }, active.map(row), sav), holdEl,
      done.length ? h('p', { class: 'small muted' }, `✅ ${done.length} goal${done.length > 1 ? 's' : ''} done (kept in notes.json)`) : null,
      h('p', { class: 'small muted' }, 'Read-only · computed from habits, logs and trackers – update them on 🏠 Today → Update.')], { badge: `${active.length} active${hold.length ? ` · ${hold.length} on hold` : ''}`, wide: true, sub: auto ? `${auto} computed automatically` : null });
  }
  function habitProgressCard() {
    const { h, card, empty } = D();
    const hs = habits();
    if (!hs.length) return card('rose', '🌸', 'Habit progress', empty('Habits load after unlock.'));
    return card('rose', '🌸', 'Habit progress', h('ul', { class: 'hp-list' }, hs.map((x) => {
      const p = x.weekly ? pct(x.weekDays, x.weekly) : Math.round((x.rate7 ?? 0) * 100);
      return h('li', { class: 'hp' }, h('div', { class: 'meter-top' }, h('span', null, x.emoji, ' ', x.name), h('span', { class: 'small' }, x.type === 'check' ? (x.doneToday ? '✓ today' : '— today') : `${x.today}/${x.target}${x.unit ? ' ' + x.unit : ''} today`)),
        bar(p, x.name), h('div', { class: 'meter-foot small muted' }, x.weekly ? `${x.weekDays}/${x.weekly} this week` : `${Math.round((x.rate7 ?? 0) * 100)}% of last 7 days`, ` · 30d ${Math.round((x.rate30 ?? 0) * 100)}%`, x.streak ? ` · 🔥 ${x.streak}${x.unit2}` : '', x.exercise ? ` · ${x.weekVal} min this week` : ''));
    })), { sub: 'From the habit tracker on Today', badge: hs.length });
  }
  function vaStats(d, t) {
    const vd = vaDaily(d), ws = weekStart(t), sum = (pred) => Object.entries(vd).filter(([k]) => pred(k)).reduce((a, [, x]) => ({ sent: a.sent + x.sent, replies: a.replies + x.replies }), { sent: 0, replies: 0 });
    return { week: sum((k) => k >= ws && k <= t), all: sum((k) => k <= t), vd };
  }
  /* ================= exercise log sheet (from the Exercise habit on Today) ================= */
  function openExerciseLog(date) {
    const { h } = D();
    if (!F()) return;
    const t = today(); let type = 'Exercise';
    const min = h('input', { type: 'number', id: 'xl-min', inputmode: 'numeric', step: '1', min: '1', max: '600', placeholder: 'Minutes' });
    const dt = h('input', { type: 'date', id: 'xl-date', value: date || t, max: t });
    const quick = h('div', { class: 'row-btns' }, [15, 30, 45, 60].map((m) => h('button', { type: 'button', class: 'tiny ghost', onclick: () => { min.value = String(m); } }, m + ' min')));
    let close;
    const form = h('form', { class: 'pg-form', id: 'xl-form', novalidate: true, onsubmit: (e) => {
      e.preventDefault();
      const m = D().num(min.value);
      if (m == null || m < 1 || m > 600) { toast('Minutes look off (1–600)'); return; }
      if (window.Features.logExercise(dt.value || t, type, m)) { close(); toast(`🏃 ${type} ${Math.round(m)} min logged – counts toward the Exercise habit`); }
    } }, seg(C.EX_TYPES.map((x) => [x, x]), type, (v) => { type = v; }, 'Activity', 'xl-t'), h('div', { class: 'qc-row' }, dt, min), quick,
      h('div', { class: 'row-btns' }, h('button', { type: 'submit', class: 'qc-add', id: 'xl-save' }, 'Log session')));
    close = sheet('🏃 Log exercise', form, 'xl-sheet');
  }
  if (window.Features) window.Features.openExerciseLog = openExerciseLog;


  /* ================= Today: 📡 Auto-synced – controls/ABM, MPAT and work applications (read-only, filled at publish) ================= */
  function autoCard(d) {
    const { h, card, fmtNum } = D();
    const a = isObj(d.auto) ? d.auto : null;
    if (!a) return null;
    const asOf = (iso) => { if (!iso) return ''; const t = new Date(iso); return isNaN(t) ? '' : 'as of ' + t.toLocaleString('en-GB', { timeZone: TZ, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) + ' PHT'; };
    const grp = (ico, title, when, kids, id) => h('section', { class: 'au-grp', id }, h('div', { class: 'au-h' }, h('h3', null, ico + ' ' + title), when ? h('span', { class: 'au-when' }, when) : null), kids);
    const none = (msg) => h('p', { class: 'small muted au-none' }, msg);
    const g = [];
    // Controls & ABM
    const ab = a.abm;
    if (ab) {
      const c = ab.controls || {}, r = ab.radar || {}, w = isObj(d.wd1) ? d.wd1 : {};
      const lr = isObj(w.live) ? w.live.req : null, hr = isObj(w.hours) ? w.hours.req : null;
      g.push(grp('✈️', 'Controls & ABM', asOf(ab.updated), [
        h('div', { class: 'm-stats au-stats' }, tile(fmtNum(c.total ?? 0), `controls total${lr ? ` · WD1 needs ${lr}` : ''}`, 'au-t'), tile(fmtNum(c.period ?? 0), `controls ${c.from ? fmtD(c.from, { weekday: undefined }) + '–' + fmtD(c.to, { weekday: undefined }) : 'this period'}`, 'au-t'),
          tile(fmtNum(r.total ?? 0), `ABM hours${hr ? ` · of ${fmtNum(hr)}` : ''}`, 'au-t'), tile(c.last ? fmtD(c.last) : '—', 'last control', 'au-t')),
        lr ? bar(pct(c.total || 0, lr), 'Live controls toward WD1', 'au-bar') : null,
        hr ? bar(pct(r.total || 0, hr), 'ABM hours toward WD1', 'au-bar') : null,
        (c.days || []).length ? h('ul', { class: 'au-list' }, c.days.slice().reverse().slice(0, 5).map((x) => h('li', null, h('span', null, fmtD(x.date)), h('strong', null, `${fmtNum(x.n)} control${x.n === 1 ? '' : 's'}`)))) : none('No controls on the board this period.')], 'au-abm'));
    } else g.push(grp('✈️', 'Controls & ABM', '', none('Not synced yet — Denx snapshots the ABM board each refresh.'), 'au-abm'));
    // MPAT
    const m = a.mpat;
    if (m && m.attempts) {
      g.push(grp('🎯', 'MPAT practice', asOf(m.updated), [
        h('div', { class: 'm-stats au-stats' }, tile(String(m.valid7), 'valid sets · 7 days', 'au-t'), tile(m.avg7 != null ? m.avg7 + '%' : '—', 'avg score · 7 days', 'au-t'), tile(m.best != null ? m.best + '%' : '—', 'best score', 'au-t'), tile(String(m.valid), 'valid sets · all', 'au-t')),
        (m.cats || []).length ? h('div', { class: 'au-chips' }, m.cats.map((x) => h('span', { class: 'chip au-chip' }, `${x.cat} · ${x.avg}% avg · ${x.n}×`))) : null,
        (m.recent || []).length ? h('ul', { class: 'au-list' }, m.recent.slice(0, 5).map((x) => h('li', null, h('span', null, `${fmtD(x.date)} · ${x.cat}`), h('strong', null, x.pct != null ? x.pct + '%' : '—')))) : null], 'au-mpat'));
    } else g.push(grp('🎯', 'MPAT practice', '', none('No attempts synced yet — scores flow in once the MPAT app reports them (see README → Auto-feeds).'), 'au-mpat'));
    // Work applications
    const w = a.work;
    if (w) {
      const K = { jobs: 'Jobs', faculty: 'Faculty', leads: 'VA leads' };
      g.push(grp('💼', 'Work applications', asOf(w.updated), [
        h('div', { class: 'm-stats au-stats' }, tile(String(w.today.sent), 'sent today', 'au-t'), tile(String(w.sent7), 'sent · 7 days', 'au-t'), tile(String(w.replies7), 'replies · 7 days', 'au-t'), tile(String(w.total), 'contacted · all', 'au-t')),
        h('div', { class: 'au-chips' }, Object.entries(w.kinds || {}).map(([k, x]) => h('span', { class: 'chip au-chip' }, `${K[k] || k} · ${x.contacted}${x.replies ? ` · ${x.replies} repl${x.replies === 1 ? 'y' : 'ies'}` : ''}`))),
        (w.recent || []).length ? h('ul', { class: 'au-list' }, w.recent.slice(0, 5).map((x) => h('li', null, h('span', { class: 'au-ell' }, [x.title, x.org].filter(Boolean).join(' · ')), h('span', { class: 'au-st' }, `${x.status} · ${fmtD(x.date, { weekday: undefined })}`)))) : null], 'au-work'));
    } else g.push(grp('💼', 'Work applications', '', none('Not synced yet — Denx snapshots the Work Application Tracker each refresh.'), 'au-work'));
    return card('sky', '📡', 'Auto-synced', h('div', { class: 'au-grid' }, g), { wide: true, sub: 'Filled automatically at every refresh · nothing to enter' });
  }
  // Slots for app.js
  function cards(d) {
    const safe = (fn, id) => { try { const el = fn(d); if (el) el.id = id; return el; } catch (e) { console.error(e); return null; } };
    return {
      today: [safe(autoCard, 'c-auto'), safe(updateCard, 'c-update')],
      money: [safe(moneyLogCard, 'm-txlog')],
      goals: [safe(goalsCard, 'c-goals'), safe(habitProgressCard, 'c-habitprog')],
    };
  }
  window.Progress = { cards, loggedBetween, openExerciseLog, savingsMath, computeGoal, metricOf, flows, txList, vaStats, sheet };
})();
