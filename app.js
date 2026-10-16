/* Daily Notes – renderer. Reads decrypted notes (schema: see README) and renders Keep-style cards.
   Tolerant by design: every section may be missing, null, empty, or use string/object items. */
(function () {
  'use strict';
  const TZ = 'Asia/Manila';
  const DATA_URL = 'notes.enc.json';
  const LS_KEY = 'dn.key.v1';      // { salt, key } – only when "Remember on this device" is ticked
  const LS_TICKS = 'dn.ticks.v1';  // local-only checkbox state for to-do / studies
  const REFRESH_MS = 15 * 60 * 1000;

  const $ = (id) => document.getElementById(id);
  let memKey = null;      // CryptoKey for this session
  let lastEnvelope = null;
  let lastRendered = '';

  /* ---------- tiny DOM helper (textContent only, never innerHTML with data) ---------- */
  function h(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'style') Object.assign(n.style, v); // CSSOM (allowed by CSP), never a style attribute
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids.flat(Infinity)) {
      if (k == null || k === false || k === '') continue;
      n.append(k instanceof Node ? k : document.createTextNode(String(k)));
    }
    return n;
  }

  /* ---------- value helpers ---------- */
  const str = (v) => (v == null ? '' : typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
  const pick = (o, ...keys) => { if (o && typeof o === 'object') for (const k of keys) { const s = str(o[k]); if (s) return s; } return ''; };
  const arr = (v) => (Array.isArray(v) ? v.filter((x) => x != null && x !== '') : v && typeof v === 'object' ? [v] : typeof v === 'string' && v.trim() ? [v] : []);
  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && isFinite(+v.replace(/,/g, '')) ? +v.replace(/,/g, '') : null);
  const fmtNum = (n) => (n == null ? '—' : n.toLocaleString('en-US', { maximumFractionDigits: 2 }));

  function todayISO() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  }
  // Only strict ISO dates (YYYY-MM-DD, optionally with time) are treated as dates; free text ("Sunday (TBC)") is shown as-is.
  function isoDate(s) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(str(s)); return m ? `${m[1]}-${m[2]}-${m[3]}` : null; }
  function daysBetween(a, b) { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000); }
  function fmtDate(iso, opts) {
    const d = new Date(iso + 'T12:00:00+08:00');
    return isNaN(d) ? iso : d.toLocaleDateString('en-GB', Object.assign({ timeZone: TZ, day: 'numeric', month: 'short' }, opts || {}));
  }
  function dueInfo(raw, done) {
    const iso = isoDate(raw);
    if (!str(raw)) return null;
    if (!iso) return { label: str(raw), cls: 'due-text' };
    const d = daysBetween(todayISO(), iso);
    let rel = d === 0 ? 'today' : d === 1 ? 'tomorrow' : d === -1 ? 'yesterday' : d < 0 ? `${-d}d overdue` : `in ${d}d`;
    let cls = 'due-ok';
    if (done) cls = 'due-done';
    else if (d < 0) cls = 'due-over';
    else if (d <= 2) cls = 'due-soon';
    return { label: done ? fmtDate(iso, { weekday: 'short' }) : `${fmtDate(iso, { weekday: 'short' })} · ${rel}`, cls, overdue: !done && d < 0, days: d };
  }

  function statusOf(s) {
    const t = str(s).toLowerCase();
    if (/done|complete|closed|✅|🟢/.test(t)) return { key: 'done', label: 'Done', dot: '🟢' };
    if (/progress|ongoing|wip|started|🟡/.test(t)) return { key: 'prog', label: 'In progress', dot: '🟡' };
    return { key: 'open', label: str(s) && !/open|🔴/.test(t) ? str(s) : 'Open', dot: '🔴' };
  }

  /* ---------- local ticks (device only) ---------- */
  // Tick ids are stored as short hashes, so localStorage does not hold note text in the clear.
  function hid(s) { let x = 5381; for (let i = 0; i < s.length; i++) x = ((x << 5) + x + s.charCodeAt(i)) >>> 0; return x.toString(36); }
  function ticks() { try { return JSON.parse(localStorage.getItem(LS_TICKS)) || {}; } catch { return {}; } }
  function setTick(id, v) { const t = ticks(); if (v) t[id] = 1; else delete t[id]; localStorage.setItem(LS_TICKS, JSON.stringify(t)); }

  // Payment methods show the account NAME only: any run of 3+ digits (card / account digits) is masked.
  const maskNum = (s) => str(s).replace(/\d[\d\s-]{1,}\d/g, (m) => (m.replace(/\D/g, '').length >= 3 ? '••••' : m)).replace(/\s*••••(\s*••••)*/g, ' ••••').trim();
  /* ---------- card builders ---------- */
  function card(color, icon, title, body, opts) {
    opts = opts || {};
    return h('article', { class: `card c-${color}${opts.wide ? ' wide' : ''}` },
      h('h2', null, h('span', { class: 'ico', 'aria-hidden': 'true' }, icon), title, opts.badge ? h('span', { class: 'badge' }, opts.badge) : null),
      opts.sub ? h('p', { class: 'sub' }, opts.sub) : null,
      body);
  }
  const empty = (msg) => h('p', { class: 'empty' }, msg);

  function headerCard(d) {
    const t = todayISO();
    const v = d.verse;
    const vText = typeof v === 'string' ? v : pick(v, 'text', 'verse');
    const vRef = typeof v === 'object' ? pick(v, 'ref', 'reference') : '';
    const upd = str(d.updated);
    return h('article', { class: 'card c-sun wide hero' },
      h('p', { class: 'hero-date' }, '📅 ', new Date(t + 'T12:00:00+08:00').toLocaleDateString('en-GB', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })),
      vText ? h('blockquote', { class: 'verse' }, h('span', { class: 'ico', 'aria-hidden': 'true' }, '📖 '), `“${vText}”`, vRef ? h('cite', null, ` — ${vRef}`) : null)
            : h('p', { class: 'verse muted' }, '📖 “This is the day that the LORD has made; let us rejoice and be glad in it.” — Psalm 118:24'),
      h('p', { class: 'tag' }, 'Capture fast · Follow up faster · Finish strong 💪'),
      upd ? h('p', { class: 'small muted' }, 'Notes updated ', fmtUpdated(upd)) : null);
  }
  function fmtUpdated(s) {
    const d = new Date(s);
    return isNaN(d) ? s : d.toLocaleString('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }) + ' PHT';
  }

  function scheduleCard(d) {
    const items = arr(d.today ?? d.schedule);
    const body = items.length ? h('ul', { class: 'sched' }, items.map((it) => {
      const time = typeof it === 'string' ? '' : pick(it, 'time', 'when');
      const what = typeof it === 'string' ? it : pick(it, 'item', 'event', 'title', 'text');
      const where = typeof it === 'object' ? pick(it, 'where', 'location', 'place') : '';
      return h('li', null, h('span', { class: 'time' }, time || '•'), h('span', null, what, where ? h('span', { class: 'muted small' }, ` 📍 ${where}`) : null));
    })) : empty('Nothing on the schedule. Enjoy the margin. ☕');
    return card('sky', '🗓️', "Today's schedule", body, { badge: items.length || null });
  }

  function checklist(prefix, items, labelFn, doneFn, extraFn) {
    const t = ticks();
    return h('ul', { class: 'checks' }, items.map((it, i) => {
      const label = labelFn(it);
      const id = hid(`${prefix}:${label}`);
      const dataDone = doneFn(it);
      const checked = dataDone || !!t[id];
      const li = h('li', { class: checked ? 'done' : '' });
      const cb = h('input', { type: 'checkbox', id: `${prefix}-${i}`, checked: checked || null, disabled: dataDone || null,
        title: dataDone ? 'Marked done in notes' : 'Tick on this device',
        onchange: (e) => { setTick(id, e.target.checked); li.classList.toggle('done', e.target.checked); } });
      li.append(cb, h('label', { for: `${prefix}-${i}` }, label, extraFn ? extraFn(it) : null));
      return li;
    }));
  }

  function todoCard(d) {
    const items = arr(d.todo ?? d.todos);
    const lbl = (it) => (typeof it === 'string' ? it : pick(it, 'item', 'task', 'text', 'title'));
    const F = window.Features && window.Features.ready() ? window.Features : null;
    if (!items.length) return card('mint', '✅', 'To-do', empty('All clear — no to-dos yet. ✨'));
    const t = ticks();
    const list = h('ul', { class: 'checks' }, items.map((it, i) => {
      const label = lbl(it), tid = hid(`todo:${label}`);
      const dataDone = typeof it === 'object' && !!it.done, legacy = !dataDone && !!t[tid]; // legacy = old device-only tick
      const checked = dataDone || legacy;
      const li = h('li', { class: checked ? 'done' : '' });
      const cb = h('input', { type: 'checkbox', id: `todo-${i}`, checked: checked || null, title: F ? 'Saved encrypted on this device and sent to Denx via the Outbox' : 'Tick on this device',
        onchange: (e) => {
          if (legacy) setTick(tid, false);
          if (F) F.set({ sec: 'todo', op: 'done', item: it, label, val: e.target.checked });
          else { setTick(tid, e.target.checked); li.classList.toggle('done', e.target.checked); }
        } });
      const di = typeof it === 'object' ? dueInfo(it.due ?? it.deadline, dataDone) : null;
      li.append(cb, h('label', { for: `todo-${i}` }, label, di ? h('span', { class: `chip ${di.cls}` }, di.label) : null, localMark(it)));
      return li;
    }));
    return card('mint', '✅', 'To-do', list, { badge: items.filter((x) => !(x && x.done)).length || null });
  }
  const localMark = (it) => (window.Features ? window.Features.localChip(it) : null);

  function statusCtl(it, st) {
    const F = window.Features && window.Features.ready() ? window.Features : null;
    if (!F) return h('span', { class: `chip st-${st.key}` }, `${st.dot} ${st.label}`);
    const title = pick(it, 'task', 'title', 'item') || '(untitled)';
    return h('select', { class: `st-sel st-${st.key}`, 'aria-label': 'Status: ' + title, onchange: (e) => F.set({ sec: 'taskings', op: 'status', item: it, label: title, val: e.target.value }) },
      ['Open', 'In progress', 'Done'].map((v) => { const s2 = statusOf(v); return h('option', { value: v, selected: s2.key === st.key || null }, `${s2.dot} ${v}`); }));
  }
  function taskingsCard(d) {
    const items = arr(d.taskings ?? d.tasks).map((it) => (typeof it === 'string' ? { task: it } : it));
    if (!items.length) return card('lav', '🎖️', 'Unit taskings', empty('No open taskings. 🙌'), { wide: true });
    const rows = items.map((it, i) => {
      const st = statusOf(it.status);
      const di = dueInfo(it.deadline ?? it.due, st.key === 'done');
      return { it, st, di, i };
    });
    const rank = (r) => (r.st.key === 'done' ? 3 : r.di && r.di.overdue ? 0 : r.st.key === 'prog' ? 1 : 2);
    rows.sort((a, b) => rank(a) - rank(b) || ((a.di && a.di.days != null ? a.di.days : 1e9) - (b.di && b.di.days != null ? b.di.days : 1e9)) || a.i - b.i);
    const c = { open: 0, prog: 0, done: 0, over: 0 };
    rows.forEach((r) => { c[r.st.key]++; if (r.di && r.di.overdue) c.over++; });
    const summary = h('p', { class: 'summary' },
      h('span', { class: 'chip st-open' }, `🔴 ${c.open} Open`), h('span', { class: 'chip st-prog' }, `🟡 ${c.prog} In progress`),
      h('span', { class: 'chip st-done' }, `🟢 ${c.done} Done`), c.over ? h('span', { class: 'chip due-over' }, `⚠️ ${c.over} overdue`) : null);
    const list = h('ul', { class: 'tasks' }, rows.map(({ it, st, di }) =>
      h('li', { class: `task st-${st.key}${di && di.overdue ? ' overdue' : ''}` },
        h('div', { class: 'task-top' }, h('strong', null, pick(it, 'task', 'title', 'item') || '(untitled)', localMark(it)), statusCtl(it, st)),
        h('div', { class: 'task-meta' },
          pick(it, 'lead', 'opr', 'owner') ? h('span', null, '👤 ', pick(it, 'lead', 'opr', 'owner')) : null,
          di ? h('span', { class: `chip ${di.cls}` }, di.overdue ? '⚠️ ' : '📅 ', di.label) : h('span', { class: 'muted' }, '📅 no deadline')),
        pick(it, 'notes', 'note') ? h('p', { class: 'task-notes' }, '📝 ', pick(it, 'notes', 'note')) : null)));
    return card('lav', '🎖️', 'Unit taskings follow-ups', [summary, list], { wide: true, badge: items.length });
  }

  function dutyCard(d) {
    const items = arr(d.duty_log ?? d.duty).map((it) => (typeof it === 'string' ? { notes: it } : it));
    items.sort((a, b) => str(b.date).localeCompare(str(a.date)));
    const body = items.length ? h('ul', { class: 'log' }, items.slice(0, 10).map((it) => {
      const iso = isoDate(it.date);
      return h('li', null,
        h('div', { class: 'log-top' }, h('strong', null, iso ? fmtDate(iso, { weekday: 'short', year: 'numeric' }) : str(it.date) || '—'),
          pick(it, 'bcc', 'site') ? h('span', { class: 'chip' }, '📡 ', pick(it, 'bcc', 'site')) : null,
          pick(it, 'shift') ? h('span', { class: 'chip' }, '🕐 ', pick(it, 'shift')) : null),
        pick(it, 'notes', 'note') ? h('p', { class: 'small' }, pick(it, 'notes', 'note')) : null);
    })) : empty('No duty entries yet.');
    return card('peach', '📡', 'WD duty log', body, { sub: 'Unclassified admin notes only.', badge: items.length || null });
  }

  const WD1_LABELS = { years: ['⏳', 'Time in service', 'yrs'], live: ['🛰️', 'Live intercepts', ''], sim: ['🖥️', 'Sim intercepts', ''], hours: ['⏱️', 'Hours', 'h'] };
  function wd1Card(d) {
    const w = d.wd1 && typeof d.wd1 === 'object' ? d.wd1 : null;
    const keys = w ? Object.keys(w).filter((k) => w[k] && typeof w[k] === 'object') : [];
    if (!keys.length) return card('rose', '🎯', 'WD1 upgrade tracker', empty('No tracker data yet.'));
    const order = Object.keys(WD1_LABELS);
    keys.sort((a, b) => ((order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99)));
    let tot = 0, cnt = 0;
    const rows = keys.map((k) => {
      const [ico, label, unit] = WD1_LABELS[k] || ['📌', k.replace(/_/g, ' '), ''];
      const req = num(w[k].req ?? w[k].required), cur = num(w[k].cur ?? w[k].current);
      const pct = req && cur != null ? Math.max(0, Math.min(100, Math.round((cur / req) * 100))) : null;
      if (pct != null) { tot += pct; cnt++; }
      const togo = req != null && cur != null ? Math.max(0, req - cur) : null;
      return h('div', { class: 'meter' },
        h('div', { class: 'meter-top' }, h('span', null, ico, ' ', label),
          h('span', { class: 'small' }, cur == null ? h('span', { class: 'muted' }, `not set / ${fmtNum(req)}${unit ? ' ' + unit : ''}`) : `${fmtNum(cur)} / ${fmtNum(req)}${unit ? ' ' + unit : ''}`)),
        h('div', { class: `bar${pct == null ? ' unknown' : ''}`, role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': pct ?? 0, 'aria-label': label },
          h('span', { style: { width: `${pct ?? 0}%` } })),
        h('div', { class: 'meter-foot small muted' }, pct == null ? 'not set yet · update on 🏠 Today → Update progress' : pct >= 100 ? '🎉 Requirement met' : `${pct}% · ${fmtNum(togo)}${unit ? ' ' + unit : ''} to go`));
    });
    return card('rose', '🎯', 'WD1 upgrade tracker', rows, { badge: cnt ? `${Math.round(tot / cnt)}% avg` : null });
  }

  function mpatCard(d) {
    const items = arr(d.mpat_log ?? d.mpat).map((it) => (typeof it === 'string' ? { notes: it } : it));
    items.sort((a, b) => str(b.date).localeCompare(str(a.date)));
    const body = items.length ? h('ul', { class: 'log' }, items.slice(0, 12).map((it) => {
      const iso = isoDate(it.date);
      const score = pick(it, 'score'), time = pick(it, 'time', 'duration');
      return h('li', null,
        h('div', { class: 'log-top' }, h('strong', null, iso ? fmtDate(iso, { weekday: 'short' }) : str(it.date) || '—'),
          pick(it, 'area', 'section', 'test') ? h('span', { class: 'chip' }, '🧩 ', pick(it, 'area', 'section', 'test')) : null,
          score || time ? h('span', { class: 'chip st-done' }, '🎯 ', [score, time].filter(Boolean).join(' · ')) : null),
        pick(it, 'notes', 'weak_spots', 'note') ? h('p', { class: 'small' }, '📝 ', pick(it, 'notes', 'weak_spots', 'note')) : null);
    })) : empty('No practice sessions logged yet. Track the trend, not just the score. ✈️');
    return card('aqua', '✈️', 'MPAT practice log', body, { badge: items.length || null });
  }

  function ideasCard(d) {
    const items = arr(d.ideas);
    const body = items.length ? h('ul', { class: 'bullets' }, items.map((it) => {
      const t = typeof it === 'string' ? it : pick(it, 'item', 'idea', 'text', 'title');
      const tag = typeof it === 'object' ? pick(it, 'tag', 'project') : '';
      return h('li', null, t, tag ? h('span', { class: 'chip' }, '#', tag) : null);
    })) : empty('Brain-dump first, polish later. 💭');
    return card('lilac', '💡', 'Ideas / HIRAM PH', body, { badge: items.length || null });
  }

  function remindersCard(d) {
    const items = arr(d.reminders).map((it) => (typeof it === 'string' ? { item: it } : it));
    items.sort((a, b) => (isoDate(a.due) || '9999').localeCompare(isoDate(b.due) || '9999'));
    const body = items.length ? h('ul', { class: 'bullets rem' }, items.map((it) => {
      const di = dueInfo(it.due ?? it.date, !!it.done);
      return h('li', { class: di && di.overdue ? 'overdue' : '' }, pick(it, 'item', 'text', 'title') || '(reminder)', localMark(it),
        di ? h('span', { class: `chip ${di.cls}` }, di.overdue ? '⚠️ ' : '⏰ ', di.label) : null);
    })) : empty('No reminders. No late fees, no stress. 😌');
    return card('coral', '💸', 'Reminders', body, { badge: items.length || null });
  }

  /* ---------- money (all optional): bills · bills_summary · bills_outlook · subscriptions · decisions · automations · finance_tips ----------
     Cards render only when their key exists in the decrypted notes. No figures live in this (public) code. */
  const MONEY_FMT = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const peso = (n) => (n == null ? '—' : (n < 0 ? '−₱' : '₱') + MONEY_FMT.format(Math.abs(n)));
  const money = (n, cur) => (n == null ? '—' : cur === 'PHP' ? peso(n) : cur === 'USD' ? 'US$' + MONEY_FMT.format(n) : `${cur} ${MONEY_FMT.format(n)}`);
  const objs = (v, key) => arr(v).map((x) => (typeof x === 'string' ? { [key]: x } : x)).filter((x) => x && typeof x === 'object' && !Array.isArray(x));
  // Loose date: first YYYY-MM-DD anywhere in the text ("~2026-10-24", "2026-10-17 (approx)"). approx when the rest hints at it.
  function looseDate(raw) {
    const s = str(raw), m = /(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (!m || isNaN(Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`))) return null;
    return { iso: `${m[1]}-${m[2]}-${m[3]}`, approx: /~|≈|approx|about|around|est|\?/i.test(s.replace(m[0], '')) };
  }
  const relDays = (d) => (d === 0 ? 'today' : d === 1 ? 'tomorrow' : d === -1 ? 'yesterday' : d < 0 ? `${-d}d ago` : `in ${d}d`);
  // Date chip for money items: {text, cls, days|null}; free text shown as-is.
  function moneyDate(raw, { settled = false, pastWord = 'overdue', soonDays = 3 } = {}) {
    const s = str(raw);
    if (!s) return null;
    const ld = looseDate(s);
    if (!ld) return { text: s, cls: 'due-text', days: null };
    const d = daysBetween(todayISO(), ld.iso);
    const when = (ld.approx ? '≈ ' : '') + fmtDate(ld.iso, { weekday: 'short' }) + (ld.iso.slice(0, 4) !== todayISO().slice(0, 4) ? ' ' + ld.iso.slice(0, 4) : '');
    if (settled) return { text: when, cls: 'due-done', days: d, iso: ld.iso };
    const rel = d < 0 ? (pastWord === 'overdue' ? `${-d}d overdue` : `${-d}d ${pastWord}`) : relDays(d);
    return { text: `${when} · ${rel}`, cls: d < 0 ? 'due-over' : d <= soonDays ? 'due-soon' : 'due-ok', days: d, iso: ld.iso };
  }
  const neutralChip = (raw) => h('span', { class: 'chip m-neutral' }, '• ', str(raw) || 'no status');

  const BILL_ST = { paid: ['✅', 'Paid', 'm-paid'], unpaid: ['⏳', 'Unpaid', 'm-unpaid'], overdue: ['🚨', 'Overdue', 'm-over'], unverified: ['❔', 'Unverified', 'm-unver'] };
  function billRows(d) {
    return objs(d.bills, 'name').map((it, i) => {
      const raw = str(it.status).toLowerCase().trim();
      const paid = raw === 'paid';
      const dt = moneyDate(it.due ?? it.due_date ?? it.date, { settled: paid });
      let key = BILL_ST[raw] ? raw : raw ? 'other' : 'none';
      if ((key === 'unpaid' || key === 'none') && dt && dt.days != null && dt.days < 0) key = 'overdue'; // auto overdue
      const amount = num(it.amount);
      return { it, i, key, raw, dt, amount, soon: !paid && dt && dt.days != null && dt.days >= 0 && dt.days <= 3 };
    });
  }
  function billCtl(r) {
    const F = window.Features && window.Features.ready() ? window.Features : null;
    if (!F) return null;
    const name = pick(r.it, 'name', 'title', 'item') || 'bill';
    if (r.it._local && r.key === 'paid') return h('div', { class: 'm-act' }, localMark(r.it), h('button', { type: 'button', class: 'tiny ghost', onclick: () => F.undo('bills', 'status', r.it) }, '↶ Undo'));
    if (r.key === 'paid') return null;
    return h('div', { class: 'm-act' }, h('button', { type: 'button', class: 'tiny ghost', 'aria-label': 'Mark paid: ' + name, onclick: () => F.set({ sec: 'bills', op: 'status', item: r.it, label: name, val: 'paid' }) }, '✓ Mark paid'));
  }
  function billsCard(d) {
    const sum = d.bills_summary && typeof d.bills_summary === 'object' && !Array.isArray(d.bills_summary) ? d.bills_summary : null;
    const outlook = arr(d.bills_outlook).map((x) => (typeof x === 'string' ? x.trim() : pick(x, 'text', 'item', 'note', 'title'))).filter(Boolean);
    const t = todayISO(), month = t.slice(0, 7);
    const rows = billRows(d);
    rows.sort((a, b) => ((a.dt && a.dt.iso) || '9999').localeCompare((b.dt && b.dt.iso) || '9999') || a.i - b.i);
    // current-month totals (by due date)
    const tot = { paid: 0, unpaid: 0, unver: 0, other: 0, n: 0 };
    let overN = 0, overAmt = 0;
    rows.forEach((r) => {
      if (r.key === 'overdue') { overN++; overAmt += r.amount || 0; }
      if (!r.dt || !r.dt.iso || r.dt.iso.slice(0, 7) !== month || r.amount == null) return;
      tot.n++;
      if (r.key === 'paid') tot.paid += r.amount;
      else if (r.key === 'unverified') tot.unver += r.amount;
      else if (r.key === 'other') tot.other += r.amount;
      else tot.unpaid += r.amount;
    });
    const monthName = new Date(t + 'T12:00:00+08:00').toLocaleDateString('en-GB', { timeZone: TZ, month: 'long' });
    const stat = (cls, label, v) => h('div', { class: `m-stat ${cls}` }, h('span', { class: 'm-stat-v' }, peso(v)), h('span', { class: 'm-stat-l' }, label));
    const totals = h('div', { class: 'm-stats' },
      stat('m-unpaid', `⏳ Unpaid · ${monthName}`, tot.unpaid),
      stat('m-paid', `✅ Paid · ${monthName}`, tot.paid),
      tot.unver ? stat('m-unver', '❔ Unverified', tot.unver) : null,
      tot.other ? stat('m-neutral', '• Other status', tot.other) : null);
    const mt = sum ? num(sum.month_total ?? sum.total) : null;
    const forOther = sum && /^\d{4}-\d{2}/.test(str(sum.month)) && str(sum.month).slice(0, 7) !== month;
    const sumLine = sum && (mt != null || pick(sum, 'note')) ? h('p', { class: 'm-sumline' },
      mt != null ? h('strong', null, `🧾 ${forOther ? fmtDate(str(sum.month).slice(0, 7) + '-15', { day: undefined, month: 'long', year: 'numeric' }) : monthName} total: ${peso(mt)}`) : null, pick(sum, 'note') ? h('span', { class: 'small muted' }, ' ', pick(sum, 'note')) : null) : null;
    const list = rows.length ? h('ul', { class: 'm-list' }, rows.map((r) => {
      const st = BILL_ST[r.key];
      const chip = st ? h('span', { class: `chip ${st[2]}` }, st[0], ' ', st[1]) : neutralChip(r.raw);
      const dueCls = r.dt ? (r.key === 'paid' ? 'due-done' : r.dt.cls) : '';
      return h('li', { class: `m-item b-${r.key}${r.soon ? ' soon' : ''}` },
        h('div', { class: 'm-top' }, h('strong', { class: 'm-name' }, pick(r.it, 'name', 'title', 'item') || '(bill)'), h('span', { class: 'm-amt' }, peso(r.amount))),
        h('div', { class: 'm-meta' }, chip,
          r.dt ? h('span', { class: `chip ${dueCls}` }, r.soon ? '🔔 ' : r.dt.days != null && r.dt.days < 0 && r.key !== 'paid' ? '⚠️ ' : '📅 ', r.dt.text,
            r.key === 'unverified' && r.dt.days != null && r.dt.days < 0 ? ' · verify' : '') : h('span', { class: 'chip due-text' }, '📅 no due date')),
        pick(r.it, 'note', 'notes') ? h('p', { class: 'm-note' }, '📝 ', pick(r.it, 'note', 'notes')) : null,
        billCtl(r));
    })) : empty('No bills listed. 🎉');
    const out = outlook.length ? h('div', { class: 'm-outlook' }, h('p', { class: 'm-h' }, '🔭 Outlook'), h('ul', { class: 'bullets' }, outlook.map((x) => h('li', null, x)))) : null;
    const dueSoon = rows.filter((r) => r.soon).length;
    return card('peach', '💳', 'Bills & loans', [
      rows.length ? totals : null, sumLine,
      overN ? h('p', { class: 'summary' }, h('span', { class: 'chip due-over' }, `🚨 ${overN} overdue · ${peso(overAmt)}`)) : null,
      list, out], { badge: dueSoon ? `🔔 ${dueSoon} due ≤3d` : rows.length || null, sub: 'Money · sorted by due date' });
  }

  const SUB_ST = { active: ['🟢', 'Active', 'm-paid'], 'maybe lapsed': ['🟠', 'Maybe lapsed', 'm-unpaid'], cancelled: ['⚫', 'Cancelled', 'm-cancel'] };
  const CYCLE = { monthly: [1, '/mo'], month: [1, '/mo'], yearly: [1 / 12, '/yr'], annual: [1 / 12, '/yr'], annually: [1 / 12, '/yr'], year: [1 / 12, '/yr'],
    quarterly: [1 / 3, '/qtr'], weekly: [52 / 12, '/wk'] };
  function subRows(d) {
    const rows = objs(d.subscriptions, 'name').map((it, i) => {
      const cur = (str(it.currency) || 'PHP').toUpperCase().replace('₱', 'PHP').replace('$', 'USD');
      const amount = num(it.amount), pe = num(it.php_equiv ?? it.php);
      const php = cur === 'PHP' ? (amount ?? pe) : pe;
      const cyc = CYCLE[str(it.cycle).toLowerCase()] || (str(it.cycle) ? null : CYCLE.monthly);
      const raw = str(it.status).toLowerCase().trim().replace(/[_-]/g, ' ');
      const key = raw === 'canceled' ? 'cancelled' : SUB_ST[raw] ? raw : raw ? 'other' : 'active';
      return { it, i, cur, amount, php, cyc, key, raw, monthly: php != null && cyc ? php * cyc[0] : null, dt: moneyDate(it.next ?? it.next_charge ?? it.renews, { settled: key === 'cancelled', pastWord: 'ago' }) };
    });
    const rank = { active: 0, other: 1, 'maybe lapsed': 2, cancelled: 3 };
    return rows.sort((a, b) => rank[a.key] - rank[b.key] || ((a.dt && a.dt.iso) || '9999').localeCompare((b.dt && b.dt.iso) || '9999') || a.i - b.i);
  }
  // monthly-equivalent ₱: active (+ unknown status) vs "maybe lapsed"; cancelled excluded
  function subTotals(rows) {
    let active = 0, maybe = 0, uncounted = 0;
    rows.forEach((r) => {
      if (r.key === 'cancelled') return;
      if (r.monthly == null) { uncounted++; return; }
      if (r.key === 'maybe lapsed') maybe += r.monthly; else active += r.monthly;
    });
    return { active, maybe, uncounted };
  }
  function subscriptionsCard(d) {
    const rows = subRows(d);
    const { active, maybe, uncounted } = subTotals(rows);
    const total = rows.length ? h('div', { class: 'm-stats' },
      h('div', { class: 'm-stat m-paid' }, h('span', { class: 'm-stat-v' }, peso(active)), h('span', { class: 'm-stat-l' }, `🔁 per month · ≈ ${peso(active * 12)}/yr`)),
      maybe ? h('div', { class: 'm-stat m-unpaid' }, h('span', { class: 'm-stat-v' }, '+' + peso(maybe)), h('span', { class: 'm-stat-l' }, '🟠 if “maybe lapsed” still bills')) : null) : null;
    const list = rows.length ? h('ul', { class: 'm-list' }, rows.map((r) => {
      const st = SUB_ST[r.key];
      const unit = r.cyc ? r.cyc[1] : str(r.it.cycle) ? ` · ${str(r.it.cycle)}` : '';
      const price = r.amount != null ? money(r.amount, r.cur) + unit : r.php != null ? peso(r.php) + unit : '—';
      const eq = r.cur !== 'PHP' && r.php != null ? `≈ ${peso(r.php)}` : r.cyc && r.cyc[0] !== 1 && r.monthly != null ? `≈ ${peso(r.monthly)}/mo` : '';
      return h('li', { class: `m-item s-${r.key.replace(' ', '-')}` },
        h('div', { class: 'm-top' }, h('strong', { class: 'm-name' }, pick(r.it, 'name', 'title', 'service') || '(subscription)'),
          h('span', { class: 'm-amt' }, price, eq ? h('span', { class: 'm-eq' }, eq) : null)),
        h('div', { class: 'm-meta' }, st ? h('span', { class: `chip ${st[2]}` }, st[0], ' ', st[1]) : neutralChip(r.raw),
          r.dt ? h('span', { class: `chip ${r.dt.cls === 'due-over' ? 'due-text' : r.dt.cls}` }, '🔄 ', r.dt.text) : null,
          pick(r.it, 'method', 'card', 'payment') ? h('span', { class: 'chip' }, '💳 ', maskNum(pick(r.it, 'method', 'card', 'payment'))) : null),
        pick(r.it, 'note', 'notes') ? h('p', { class: 'm-note' }, '📝 ', pick(r.it, 'note', 'notes')) : null);
    })) : empty('No subscriptions listed.');
    return card('sky', '🔁', 'Subscriptions', [total, uncounted ? h('p', { class: 'small muted' }, `${uncounted} not counted (no ₱ amount or unknown cycle)`) : null, list],
      { badge: rows.filter((r) => r.key !== 'cancelled').length || null, sub: 'Money · monthly-equivalent in ₱' });
  }

  const DEC_ST = { open: ['❓', 'Open', 'm-over'], waiting: ['⏳', 'Waiting', 'm-unpaid'], decided: ['✅', 'Decided', 'm-paid'] };
  function decisionsCard(d) {
    const items = objs(d.decisions, 'title');
    const rank = { open: 0, other: 1, waiting: 2, decided: 3 };
    const rows = items.map((it, i) => {
      const raw = str(it.status).toLowerCase().trim();
      return { it, i, raw, key: DEC_ST[raw] ? raw : raw ? 'other' : 'open' };
    }).sort((a, b) => rank[a.key] - rank[b.key] || a.i - b.i);
    const list = rows.length ? h('ul', { class: 'm-list' }, rows.map((r) => {
      const st = DEC_ST[r.key];
      const since = str(r.it.since ?? r.it.date), ld = looseDate(since);
      const age = ld ? -daysBetween(todayISO(), ld.iso) : null;
      return h('li', { class: `m-item d-${r.key}` },
        h('div', { class: 'm-top' }, h('strong', { class: 'm-name' }, pick(r.it, 'title', 'name', 'item') || '(decision)'),
          st ? h('span', { class: `chip ${st[2]}` }, st[0], ' ', st[1]) : neutralChip(r.raw)),
        pick(r.it, 'detail', 'details', 'note', 'notes') ? h('p', { class: 'm-note' }, pick(r.it, 'detail', 'details', 'note', 'notes')) : null,
        since ? h('div', { class: 'm-meta' }, h('span', { class: 'chip due-text' }, '🕰️ since ',
          ld ? fmtDate(ld.iso, ld.iso.slice(0, 4) !== todayISO().slice(0, 4) ? { year: 'numeric' } : {}) + (age > 0 ? ` · ${age}d` : '') : since)) : null);
    })) : empty('Nothing waiting on you. 🧘');
    return card('lemon', '🤔', 'Needs a decision', list, { badge: rows.filter((r) => r.key !== 'decided').length || null });
  }

  const AUTO_ST = { ok: ['🟢', 'OK', 'm-paid'], failed: ['🔴', 'Failed', 'm-over'], unknown: ['⚪', 'Unknown', 'm-neutral'] };
  function automationsCard(d) {
    const items = objs(d.automations, 'name');
    const rows = items.map((it, i) => { const raw = str(it.status).toLowerCase().trim(); return { it, i, raw, key: AUTO_ST[raw] ? raw : raw ? 'other' : 'unknown' }; });
    rows.sort((a, b) => (a.key === 'failed' ? 0 : 1) - (b.key === 'failed' ? 0 : 1) || a.i - b.i);
    const ago = (ms) => { const m = Math.round(ms / 60000); return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : m < 2880 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`; };
    const list = rows.length ? h('ul', { class: 'm-list' }, rows.map((r) => {
      const st = AUTO_ST[r.key], lr = str(r.it.last_run ?? r.it.last), lt = lr ? Date.parse(lr) : NaN;
      return h('li', { class: `m-item a-${r.key}` },
        h('div', { class: 'm-top' }, h('strong', { class: 'm-name' }, pick(r.it, 'name', 'title') || '(automation)'),
          st ? h('span', { class: `chip ${st[2]}` }, st[0], ' ', st[1]) : neutralChip(r.raw)),
        pick(r.it, 'description', 'desc', 'what') ? h('p', { class: 'm-note' }, pick(r.it, 'description', 'desc', 'what')) : null,
        h('div', { class: 'm-meta' },
          pick(r.it, 'schedule', 'when', 'cron') ? h('span', { class: 'chip' }, '🕐 ', pick(r.it, 'schedule', 'when', 'cron')) : null,
          h('span', { class: 'chip due-text' }, '↻ last run: ', lr ? (isNaN(lt) ? lr : `${fmtUpdated(lr)} · ${ago(Date.now() - lt)}`) : '—')));
    })) : empty('No automations listed.');
    const failed = rows.filter((r) => r.key === 'failed').length;
    return card('aqua', '🤖', 'Automations', list, { badge: failed ? `🔴 ${failed} failed` : rows.length || null });
  }

  function tipsCard(d) {
    const items = arr(d.finance_tips).map((x) => (typeof x === 'string' ? { text: x.trim() } : x && typeof x === 'object' ? { title: pick(x, 'title', 'name'), text: pick(x, 'text', 'detail', 'tip') } : null))
      .filter((x) => x && (x.title || x.text));
    const body = items.length ? h('ol', { class: 'm-tips' }, items.map((x) => h('li', null, x.title ? h('strong', null, x.title) : null, x.title && x.text ? ' — ' : null, x.text ? h('span', null, x.text) : null)))
      : empty('No strategy notes yet.');
    return card('mint', '🧭', 'Money strategy', body, { badge: items.length || null });
  }
  /* ---------- pay / free cash / debts (optional: income · balances · debts) ----------
     Id-like keys (tin, gsis, pagibig, philhealth, id, account, number …) are stripped before anything is read, so they can never render. */
  const ID_LIKE = /tin|gsis|pagibig|philhealth|id|account|number/;
  const idLike = (k) => ID_LIKE.test(String(k).toLowerCase().replace(/[^a-z]/g, ''));
  function scrub(v) {
    if (Array.isArray(v)) return v.map(scrub);
    if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) if (!idLike(k)) o[k] = scrub(x); return o; }
    return v;
  }
  const pad2 = (n) => String(n).padStart(2, '0');
  const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m = 1..12
  function paydayISO(y, m, day) { while (m < 1) { m += 12; y--; } while (m > 12) { m -= 12; y++; } return `${y}-${pad2(m)}-${pad2(Math.min(day, lastDay(y, m)))}`; }
  const monthLabel = (y, m0) => new Date(Date.UTC(y, m0, 15)).toLocaleDateString('en-GB', { timeZone: 'UTC', month: 'short', year: 'numeric' });
  const sumOf = (xs) => xs.reduce((a, x) => a + (x.amount || 0), 0);
  const cents = (n) => Math.round(n * 100);
  // Latest payday on/before today and the next one after it (days > month length → last day of month, e.g. 30 → 28 Feb).
  function payCycle(paydays, t) {
    const [y, m] = t.split('-').map(Number), seen = new Map();
    for (let k = -2; k <= 2; k++) paydays.forEach((p) => { const iso = paydayISO(y, m + k, p.day); if (!seen.has(iso)) seen.set(iso, p); });
    const all = [...seen].map(([iso, p]) => ({ iso, p })).sort((a, b) => a.iso.localeCompare(b.iso));
    const last = all.filter((x) => x.iso <= t).pop(), next = all.find((x) => x.iso > t);
    return last && next ? { last, next } : null;
  }
  function incomeModel(d) {
    const inc = d.income && typeof d.income === 'object' && !Array.isArray(d.income) ? scrub(d.income) : null;
    if (!inc) return null;
    const line = (x) => ({ name: pick(x, 'name', 'title', 'item') || '(item)', amount: num(x.amount), group: pick(x, 'group', 'category') });
    const allow = objs(inc.allowances, 'name').map(line), ded = objs(inc.deductions, 'name').map(line);
    const paydays = arr(inc.paydays).map((p) => (typeof p === 'object' ? { day: parseInt(str(p.day), 10), amount: num(p.amount) } : { day: parseInt(str(p), 10), amount: null }))
      .filter((p) => p.day >= 1 && p.day <= 31).sort((a, b) => a.day - b.day);
    const sG = num(inc.monthly_gross), sD = num(inc.monthly_deductions), sN = num(inc.monthly_net);
    const lG = allow.length ? sumOf(allow) : null, lD = ded.length ? sumOf(ded) : null;
    const gross = sG ?? lG, deductions = sD ?? lD;
    const net = sN ?? (gross != null && deductions != null ? gross - deductions : paydays.length && paydays.every((p) => p.amount != null) ? sumOf(paydays) : null);
    paydays.forEach((p) => { if (p.amount == null && net != null) { p.amount = net / paydays.length; p.est = true; } });
    const diffs = [];
    const cmp = (label, stated, items) => { if (stated != null && items != null && cents(stated) !== cents(items)) diffs.push(`${label}: line items differ from slip total by ${peso(Math.abs(items - stated))}`); };
    cmp('Allowances', sG, lG); cmp('Deductions', sD, lD);
    if (sN != null && paydays.length && paydays.every((p) => !p.est)) cmp('Paydays', sN, sumOf(paydays));
    if (sN != null && sG != null && sD != null && cents(sG - sD) !== cents(sN)) diffs.push(`Net: gross − deductions differs from slip net by ${peso(Math.abs(sG - sD - sN))}`);
    return { inc, allow, ded, paydays, gross, deductions, net, stated: { g: sG != null, d: sD != null, n: sN != null }, diffs,
      loans: objs(inc.salary_loans, 'name').map((x) => ({ name: pick(x, 'name', 'title') || '(loan)', amount: num(x.amount), term: str(x.term) })), note: pick(inc, 'note', 'notes') };
  }
  const balancesOf = (d) => objs(scrub(d.balances), 'name').map((x) => ({ name: pick(x, 'name', 'title') || '(cash)', amount: num(x.amount ?? x.balance) })).filter((x) => x.amount != null);
  const stat = (cls, label, v) => h('div', { class: `m-stat ${cls}` }, h('span', { class: 'm-stat-v' }, typeof v === 'number' || v == null ? peso(v) : v), h('span', { class: 'm-stat-l' }, label));
  const lineRow = (name, amt, extra) => h('li', { class: 'm-line' }, h('span', null, name, extra ? h('span', { class: 'muted small' }, ' ', extra) : null), h('span', { class: 'm-num' }, peso(amt)));

  function payCard(d) {
    const M = incomeModel(d);
    if (!M) return card('mint', '💰', 'Pay', empty('No pay details.'));
    const t = todayISO(), [ty, tm] = t.split('-').map(Number);
    const tiles = h('div', { class: 'm-stats m-3' },
      stat('m-gross', `🧾 Gross${M.stated.g ? '' : ' (items)'}`, M.gross), stat('m-unpaid', `➖ Deductions${M.stated.d ? '' : ' (items)'}`, M.deductions),
      stat('m-paid', `💵 Net${M.stated.n ? '' : ' (calc.)'}`, M.net));
    const diffs = M.diffs.length ? h('ul', { class: 'm-diffs' }, M.diffs.map((x) => h('li', null, 'ℹ️ ', x))) : null;
    let payday = null;
    const cyc = M.paydays.length ? payCycle(M.paydays, t) : null;
    if (cyc) {
      const dd = daysBetween(t, cyc.next.iso), isToday = cyc.last.iso === t;
      payday = h('div', { class: 'm-payday' + (isToday ? ' today' : '') },
        isToday ? h('p', { class: 'm-pay-big' }, '🎉 Payday today · ', h('strong', null, peso(cyc.last.p.amount))) : null,
        h('p', { class: isToday ? 'small' : 'm-pay-big' }, '📆 Next payday ', h('strong', null, fmtDate(cyc.next.iso, { weekday: 'short' })),
          ` · ${relDays(dd)} · `, h('strong', null, peso(cyc.next.p.amount)), cyc.next.p.est ? h('span', { class: 'muted small' }, ' (est.)') : null),
        h('p', { class: 'small muted' }, 'Paydays: ', M.paydays.map((p) => (p.day >= 29 ? `${p.day} (or month-end)` : String(p.day))).join(' & ')));
    }
    const fold = (title, n, total, body) => h('details', { class: 'm-fold' },
      h('summary', null, h('span', null, title, ` (${n})`), h('span', { class: 'm-num' }, peso(total))), body);
    const allow = M.allow.length ? fold('➕ Allowances & pay', M.allow.length, sumOf(M.allow), h('ul', { class: 'm-lines' }, M.allow.map((x) => lineRow(x.name, x.amount)))) : null;
    let ded = null;
    if (M.ded.length) {
      const groups = new Map();
      M.ded.forEach((x) => { const g = x.group || ''; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(x); });
      const grouped = groups.size > 1 || !groups.has('');
      ded = fold('➖ Deductions', M.ded.length, sumOf(M.ded), [...groups].map(([g, xs]) => h('div', { class: 'm-group' },
        grouped ? h('p', { class: 'm-gh' }, h('span', null, g || 'Other'), h('span', { class: 'm-num' }, peso(sumOf(xs)))) : null,
        h('ul', { class: 'm-lines' }, xs.map((x) => lineRow(x.name, x.amount))))));
    }
    const loans = M.loans.length ? h('div', { class: 'm-loans' }, h('p', { class: 'm-h' }, '🏦 Salary loans'), M.loans.map((L) => {
      const m = /(\d+)\s*\/\s*(\d+)/.exec(L.term), paid = m ? +m[1] : null, total = m ? +m[2] : null;
      const ok = paid != null && total > 0, pct = ok ? Math.max(0, Math.min(100, Math.round((paid / total) * 100))) : null, left = ok ? Math.max(0, total - paid) : null;
      return h('div', { class: 'meter' },
        h('div', { class: 'meter-top' }, h('span', null, L.name), h('span', { class: 'small' }, L.amount != null ? `${peso(L.amount)}/mo` : '')),
        h('div', { class: `bar${ok ? '' : ' unknown'}`, role: 'progressbar', 'aria-label': L.name, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': pct ?? 0 }, h('span', { style: { width: `${pct ?? 0}%` } })),
        h('div', { class: 'meter-foot small muted' }, !ok ? (L.term ? `term “${L.term}”` : 'no term') : left === 0 ? '🎉 Paid off' :
          `${paid}/${total} paid · ${left} mo left · ≈ payoff ${monthLabel(ty, tm - 1 + left)}${L.amount != null ? ` · ≈ ${peso(left * L.amount)} to go` : ''}`));
    })) : null;
    return card('mint', '💰', 'Pay', [tiles, diffs, payday, allow, ded, loans, M.note ? h('p', { class: 'm-note' }, '📝 ', M.note) : null], { sub: 'Money · slip totals are the source of truth' });
  }

  function freeCashCard(d) {
    const M = incomeModel(d), t = todayISO(), [ty, tm] = t.split('-').map(Number);
    const cash = balancesOf(d), cashSum = sumOf(cash);
    const bills = billRows(d), subs = subRows(d);
    const ledger = (rows, total, label) => h('div', { class: 'm-ledger' },
      h('ul', { class: 'm-lines' }, rows.filter(Boolean).map(([sign, name, amt, items]) => h('li', { class: 'm-line' + (sign === '−' ? ' minus' : '') },
        h('span', null, `${sign} ${name}`, items && items.length ? h('span', { class: 'm-items' }, items.join(' · ')) : null), h('span', { class: 'm-num' }, (sign === '−' ? '−' : '') + peso(amt))))),
      h('p', { class: 'm-result' + (total < 0 ? ' neg' : '') }, h('span', null, `= ${label}`), h('strong', { class: 'm-num' }, total < 0 ? `−${peso(-total)}` : peso(total), total < 0 ? h('span', { class: 'm-short' }, ' shortfall') : null)));
    const blocks = [];
    const notes = [];
    // pay-period view
    const cyc = M && M.paydays.length ? payCycle(M.paydays, t) : null;
    if (cyc) {
      const start = cyc.last.iso, end = cyc.next.iso, inP = (iso) => iso >= start && iso < end;
      const endIncl = new Date(Date.parse(end + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
      const pb = bills.filter((r) => r.key !== 'paid' && r.amount != null && r.dt && r.dt.iso && inP(r.dt.iso));
      const ps = subs.filter((r) => (r.key === 'active' || r.key === 'other') && r.php != null && r.dt && r.dt.iso && inP(r.dt.iso));
      const before = bills.filter((r) => r.key !== 'paid' && r.amount != null && r.dt && r.dt.iso && r.dt.iso < start);
      const lapsed = subs.filter((r) => r.key === 'maybe lapsed' && r.php != null && (!r.dt || !r.dt.iso || inP(r.dt.iso)));
      const pay = cyc.last.p.amount ?? 0, bSum = sumOf(pb), sSum = ps.reduce((a, r) => a + r.php, 0);
      const free = pay - bSum - sSum + cashSum;
      blocks.push(h('p', { class: 'm-h' }, `🗓️ This pay period · ${fmtDate(start, { weekday: 'short' })} – ${fmtDate(endIncl, { weekday: 'short' })}`),
        ledger([['+', `Payday ${fmtDate(start)}`, pay],
          ['−', `Bills due (${pb.length})`, bSum, pb.map((r) => `${pick(r.it, 'name', 'title') || 'bill'} ${fmtDate(r.dt.iso)}`)],
          ['−', `Subscriptions renewing (${ps.length})`, sSum, ps.map((r) => `${pick(r.it, 'name') || 'sub'} ${fmtDate(r.dt.iso)}`)],
          cash.length ? ['+', 'Cash on hand', cashSum, cash.map((x) => x.name)] : null], free, 'Free cash this period'));
      if (before.length) notes.push(`${peso(sumOf(before))} in ${before.length} not-paid bill${before.length > 1 ? 's' : ''} due before this period (overdue/unverified) not included.`);
      // real logged spending since payday (💸 Log money) vs the plan above
      const P = window.Progress && window.Progress.loggedBetween ? window.Progress.loggedBetween(d, start, end) : null;
      if (P && P.n) {
        const left = free - P.out + P.extraIn; // bills paid from the log drop out of "Bills due" above, so they are counted here once
        blocks.push(h('p', { class: 'm-h' }, `📒 Logged since payday (${P.n} entr${P.n === 1 ? 'y' : 'ies'})`),
          ledger([['+', 'Free cash (plan above)', free], ['−', `Logged spending${P.billOut ? ` (incl. ${peso(P.billOut)} bills paid)` : ''}`, P.out],
            P.extraIn ? ['+', 'Extra money in (not salary)', P.extraIn] : null], left, 'Left after logged spending'));
        notes.push('Logged spending uses your 💸 money log since payday; cash on hand may already include some of it.');
      }
      if (lapsed.length) notes.push(`“Maybe lapsed” subscriptions not counted (${peso(lapsed.reduce((a, r) => a + r.php, 0))} if they still bill).`);
    } else notes.push(M ? 'Add income.paydays to see the pay-period view.' : 'Add income (monthly_net, paydays) to see free cash.');
    // monthly view
    if (M && M.net != null) {
      const month = t.slice(0, 7), mName = new Date(t + 'T12:00:00+08:00').toLocaleDateString('en-GB', { timeZone: TZ, month: 'long' });
      const mb = bills.filter((r) => r.amount != null && r.dt && r.dt.iso && r.dt.iso.slice(0, 7) === month);
      const bs = d.bills_summary && typeof d.bills_summary === 'object' ? d.bills_summary : null;
      const sum = bs && (!str(bs.month) || str(bs.month).slice(0, 7) === month) ? num(bs.month_total) : null; // optional month "YYYY-MM" guards against a stale total
      const mBills = sum ?? sumOf(mb), st = subTotals(subs);
      blocks.push(h('p', { class: 'm-h' }, `📅 ${mName} (whole month)`),
        ledger([['+', 'Net pay', M.net], ['−', sum != null ? 'Bills this month (summary total)' : `Bills due this month (${mb.length})`, mBills],
          ['−', 'Subscriptions (monthly equiv.)', st.active], cash.length ? ['+', 'Cash on hand', cashSum] : null], M.net - mBills - st.active + cashSum, `Free cash · ${mName}`));
    }
    return card('sun', '🧮', 'Free cash', [blocks, notes.length ? h('ul', { class: 'm-diffs' }, notes.map((x) => h('li', null, 'ℹ️ ', x))) : null,
      h('p', { class: 'small muted' }, 'Estimate only — from your notes, not a bank balance. Paid bills excluded from the period view.')], { badge: '≈ estimate', sub: 'Money · what is left after bills & subscriptions' });
  }

  function debtsCard(d) {
    const items = objs(scrub(d.debts), 'name').map((x, i) => ({ i, name: pick(x, 'name', 'title') || '(debt)', bal: num(x.balance ?? x.amount), rate: num(x.rate_pct ?? x.rate), min: num(x.min_payment ?? x.minimum), orig: num(x.original ?? x.principal) }));
    if (!items.length) return card('rose', '⛰️', 'Debt-free plan', empty('No debts listed. 🎉'));
    items.sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1) || (a.bal ?? 0) - (b.bal ?? 0) || a.i - b.i); // avalanche: highest rate first
    const open = items.filter((x) => (x.bal ?? 0) > 0), total = sumOf(open.map((x) => ({ amount: x.bal })));
    const tiles = h('div', { class: 'm-stats' }, stat('m-over', '⛰️ Total owed', total),
      stat('m-unpaid', '📆 Minimums / month', sumOf(open.map((x) => ({ amount: x.min })))));
    let prog = null;
    if (open.length && items.every((x) => x.orig != null && x.bal != null)) {
      const o = items.reduce((a, x) => a + x.orig, 0), pct = o > 0 ? Math.max(0, Math.min(100, Math.round((1 - items.reduce((a, x) => a + x.bal, 0) / o) * 100))) : 0;
      prog = h('div', { class: 'meter' }, h('div', { class: 'meter-top' }, h('span', null, '🏁 Debt-free progress'), h('span', { class: 'small' }, `${pct}%`)),
        h('div', { class: 'bar', role: 'progressbar', 'aria-label': 'Debt-free progress', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('span', { style: { width: pct + '%' } })));
    }
    // simulate paying the sum of minimums with avalanche roll-over (monthly interest = rate_pct / 12)
    let eta = null;
    if (open.length && open.every((x) => x.min != null && x.min > 0)) {
      const b = open.map((x) => ({ bal: x.bal, r: (x.rate || 0) / 1200, min: x.min })), budget = b.reduce((a, x) => a + x.min, 0);
      let mo = 0;
      while (mo < 600 && b.some((x) => x.bal > 0.005)) {
        mo++; let left = budget;
        b.forEach((x) => { if (x.bal > 0) x.bal += x.bal * x.r; });
        b.forEach((x) => { const p = Math.min(x.min, x.bal); x.bal -= p; left -= p; });
        for (const x of b) { if (left <= 0) break; const p = Math.min(left, x.bal); x.bal -= p; left -= p; }
      }
      const [ty, tm] = todayISO().split('-').map(Number);
      eta = mo >= 600 ? h('p', { class: 'm-diffs neg' }, '⚠️ Minimums barely cover interest — no payoff in 50 years at this pace.')
        : h('p', { class: 'm-sumline' }, '🏁 Debt-free in ≈ ', h('strong', null, `${mo} months (${monthLabel(ty, tm - 1 + mo)})`), h('span', { class: 'small muted' }, ' paying the minimums, extra rolled to the top debt'));
    }
    const list = h('ol', { class: 'm-list m-aval' }, items.map((x, k) => h('li', { class: `m-item${k === 0 && (x.bal ?? 0) > 0 ? ' soon' : ''}` },
      h('div', { class: 'm-top' }, h('strong', { class: 'm-name' }, `${k + 1}. ${x.name}`), h('span', { class: 'm-amt' }, peso(x.bal))),
      h('div', { class: 'm-meta' }, x.rate != null ? h('span', { class: 'chip m-over' }, `${fmtNum(x.rate)}% / yr`) : h('span', { class: 'chip m-neutral' }, 'rate ?'),
        x.min != null ? h('span', { class: 'chip' }, `min ${peso(x.min)}`) : null, k === 0 && (x.bal ?? 0) > 0 ? h('span', { class: 'chip m-paid' }, '🎯 extra cash goes here') : null))));
    return card('rose', '⛰️', 'Debt-free plan', [tiles, prog, eta, h('p', { class: 'm-h' }, '🏔️ Avalanche order (highest rate first)'), list], { badge: open.length || null, sub: 'Money · estimate' });
  }

  // Only render money cards whose key is present (keeps the board clean when the writer omits them).
  function moneyCards(d) {
    const has = (k) => Object.prototype.hasOwnProperty.call(d, k) && d[k] != null;
    const out = [];
    if (has('income')) out.push(['pay', payCard]);
    if (has('income') || has('balances')) out.push(['freecash', freeCashCard]);
    if (has('bills') || has('bills_summary') || has('bills_outlook')) out.push(['bills', billsCard]);
    if (has('subscriptions')) out.push(['subscriptions', subscriptionsCard]);
    if (has('decisions')) out.push(['decisions', decisionsCard]);
    if (has('debts')) out.push(['debts', debtsCard]);
    return out;
  }
  function moneyCardsLate(d) {
    const has = (k) => Object.prototype.hasOwnProperty.call(d, k) && d[k] != null;
    const out = [];
    if (has('automations')) out.push(['automations', automationsCard]);
    if (has('finance_tips')) out.push(['finance_tips', tipsCard]);
    return out;
  }

  const KNOWN = new Set(['updated', 'verse', 'today', 'schedule', 'todo', 'todos', 'taskings', 'tasks', 'duty_log', 'duty', 'wd1', 'studies', 'mmpa', 'mmpa_exam_date', 'mpat_log', 'mpat', 'ideas', 'reminders', 'habits', 'version', 'schema',
    'bills', 'bills_summary', 'bills_outlook', 'subscriptions', 'decisions', 'automations', 'finance_tips', 'income', 'balances', 'debts',
    'wins', 'weekly_review', 'goals', 'health', 'quick_notes', 'links', 'finance', 'va', 'transactions']);
  function extraCards(d) {
    // Unknown top-level sections are shown generically so nothing the writer adds is silently lost.
    // Id-like keys are hidden here too (token match, so words like "ideas"/"video" are not caught): tin, gsis, pag-ibig, philhealth, id, account, number.
    const idTok = (k) => /gsis|pag_?ibig|philhealth/.test(String(k).toLowerCase().replace(/-/g, '_')) ||
      String(k).replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase().split(/[^a-z]+/).some((w) => ['tin', 'id', 'ids', 'account', 'accounts', 'acct', 'number', 'numbers', 'no'].includes(w));
    const clean = (v) => (Array.isArray(v) ? v.map(clean) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([a]) => !idTok(a)).map(([a, y]) => [a, clean(y)])) : v);
    return Object.keys(d).filter((k) => !KNOWN.has(k) && !k.startsWith('_') && !idTok(k) && d[k] != null && d[k] !== '').map((k) => {
      const v = clean(d[k]);
      const items = arr(v);
      const line = (x) => (typeof x === 'object' ? Object.entries(x).filter(([, y]) => y != null && y !== '').map(([a, y]) => `${a}: ${typeof y === 'object' ? JSON.stringify(y) : y}`).join(' · ') : String(x));
      const el = card('mist', '📌', k.replace(/_/g, ' '), items.length ? h('ul', { class: 'bullets' }, items.map((x) => h('li', null, line(x)))) : empty('—'));
      el.id = 'x-' + k; return el;
    });
  }

  let lastRaw = null;
  function render(rawData) {
    if (!rawData || typeof rawData !== 'object' || Array.isArray(rawData)) rawData = {};
    lastRaw = rawData;
    const F = window.Features && window.Features.ready() ? window.Features : null;
    const d = F ? F.merge(rawData) : rawData; // encrypted local edits merged over notes.json
    const board = $('board');
    const safe = (fn) => { try { return fn(d); } catch (e) { console.error(e); return card('mist', '⚠️', fn.name, empty('Could not render this section.')); } };
    const tag = (sec, id) => (el) => { if (el) { if (id && !el.id) el.id = id; el.dataset.sec = sec; } return el; };
    const money = (list, secOf) => list.map(([k, fn]) => { let c; try { c = fn(d); c.id = 'm-' + k; } catch (e) { console.error(e); c = card('mist', '⚠️', k.replace(/_/g, ' '), empty('Could not render this section.')); }
      c.dataset.sec = secOf ? secOf(k) : 'money'; return c; });
    const fx = F ? F.cards(d) : { todayTop: [], todayMid: [], todayEnd: [], week: [], health: [], links: [], search: [] };
    const px = window.Progress ? window.Progress.cards(d) : { todayProgress: [], money: [], goals: [] };
    const habitsCard = window.Habits ? window.Habits.el() : null;
    const T = (fn, id) => tag('today', id)(safe(fn)), G = (fn, id) => tag('goals', id)(safe(fn));
    board.replaceChildren(...[
      T(headerCard, 'c-hero'), ...fx.todayTop.map(tag('today')), tag('today')(habitsCard), T(scheduleCard, 'c-schedule'), T(todoCard, 'c-todo'), T(remindersCard, 'c-reminders'),
      T(taskingsCard, 'c-taskings'), ...(px.todayProgress || []).map(tag('today')), ...fx.todayMid.map(tag('today')), T(dutyCard, 'c-duty'), T(ideasCard, 'c-ideas'),
      ...fx.week.map(tag('week')),
      ...money(moneyCards(d)), ...(px.money || []).map(tag('money')), ...money(moneyCardsLate(d), (k) => (k === 'automations' ? 'today' : 'money')),
      ...(px.goals || []).map(tag('goals')), G(wd1Card, 'c-wd1'), G(mpatCard, 'c-mpat'),
      ...fx.health.map(tag('health')), ...(fx.links || []).map(tag('links')), ...fx.search.map(tag('search')),
      ...safe(extraCards).map(tag('today')), ...(fx.todayEnd || []).map(tag('today'))].filter(Boolean));
    $('updated').textContent = str(d.updated) ? '⟳ ' + fmtUpdated(str(d.updated)) : '';
    if (F) F.afterRender(d);
  }
  function rerender() { if (!lastRaw) return; const y = window.scrollY; render(lastRaw); window.scrollTo(0, y); }

  // Helpers for features.js (no data – functions only).
  const idTok = (k) => /gsis|pag_?ibig|philhealth/.test(String(k).toLowerCase().replace(/-/g, '_')) ||
    String(k).replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase().split(/[^a-z]+/).some((w) => ['tin', 'id', 'ids', 'account', 'accounts', 'acct', 'number', 'numbers', 'no'].includes(w));
  window.DN = { maskNum, h, str, pick, arr, num, objs, fmtNum, card, empty, todayISO, isoDate, daysBetween, fmtDate, dueInfo, statusOf, hid, peso, moneyDate, billRows, subRows, idTok, rerender };

  /* ---------- auth / data flow ---------- */
  async function fetchEnvelope() {
    const r = await fetch(DATA_URL + '?t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) throw new Error('Notes file not found (' + r.status + ')');
    return r.json();
  }
  function showGate(msg) {
    $('app').hidden = true; $('gate').hidden = false;
    $('gate-msg').textContent = msg || '';
    $('pass').value = ''; $('pass').focus();
  }
  function showApp() { $('gate').hidden = true; $('app').hidden = false; }
  function forget() { localStorage.removeItem(LS_KEY); memKey = null; lastRaw = null; if (window.Sync) window.Sync.lock(); if (window.Habits) window.Habits.lock(); if (window.Features) window.Features.lock(); const n = $('secnav'); if (n) n.hidden = true; }

  async function openWith(key, env) {
    const data = await NotesCrypto.decryptWithKey(key, env);
    memKey = key; lastEnvelope = env;
    // Habit tracker: encrypted local data, unlocked with the same key (never blocks the notes on failure).
    if (window.Habits) { try { await window.Habits.unlock(key, env, data); } catch (e) { console.warn('habits unavailable', e); } }
    if (window.Features) { try { await window.Features.unlock(key, env, data); } catch (e) { console.warn('edits overlay unavailable', e); } }
    const sig = env.iv + env.ct.length;
    if (sig !== lastRendered) { render(data); lastRendered = sig; }
    showApp();
    if (window.Sync) { try { window.Sync.unlock(key, env); } catch (e) { console.warn('sync unavailable', e); } }
  }

  async function onLogin(e) {
    e.preventDefault();
    const btn = $('unlock'), pass = $('pass').value, remember = $('remember').checked;
    if (!pass) return;
    btn.disabled = true; btn.textContent = 'Unlocking…'; $('gate-msg').textContent = '';
    try {
      const env = lastEnvelope || (await fetchEnvelope());
      // Sync on: also derive the sync-server verifier (separate PBKDF2, different salt) – in parallel.
      const wantVf = !!(window.Sync && window.Sync.configured());
      const [key, vf] = await Promise.all([NotesCrypto.deriveKey(pass, env, remember), wantVf ? NotesCrypto.authVerifier(pass).catch(() => null) : null]);
      if (window.Sync) window.Sync.setVf(vf);
      try { await openWith(key, env); }
      catch { throw new Error('Wrong passphrase. Try again.'); }
      if (remember) localStorage.setItem(LS_KEY, JSON.stringify(Object.assign({ salt: env.salt, key: await NotesCrypto.exportRawKey(key) }, vf ? { vf } : {})));
      else localStorage.removeItem(LS_KEY);
      $('pass').value = '';
    } catch (err) {
      $('gate-msg').textContent = err.message || 'Could not unlock.';
      $('pass').select();
    } finally { btn.disabled = false; btn.textContent = 'Unlock'; }
  }

  async function refresh() {
    if (!memKey) return;
    let env;
    try { env = await fetchEnvelope(); } catch { return; } // offline / server down: keep showing what we have
    try {
      await openWith(memKey, env);
    } catch (err) {
      // Passphrase/salt rotated or file broken: drop the remembered key and ask again.
      forget(); lastEnvelope = null; showGate('Notes changed or key expired — please unlock again.');
    }
  }

  async function boot() {
    if (!window.crypto || !crypto.subtle) { showGate('This browser lacks WebCrypto (needs HTTPS).'); $('unlock').disabled = true; return; }
    $('login').addEventListener('submit', onLogin);
    $('lock').addEventListener('click', () => { forget(); $('board').replaceChildren(); lastRendered = ''; showGate('Locked.'); });
    $('refresh').addEventListener('click', refresh);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
    setInterval(() => { if (!document.hidden) refresh(); }, REFRESH_MS);

    // Offline support: cache the app shell + last notes.enc.json (ciphertext only) in a service worker.
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1'))
      navigator.serviceWorker.register('sw.js').catch((e) => console.warn('offline cache unavailable', e));
    let env;
    try { env = await fetchEnvelope(); lastEnvelope = env; } catch (err) { showGate(err.message); return; }
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(LS_KEY)); } catch { /* ignore */ }
    if (saved && saved.key && saved.salt === env.salt) {
      if (window.Sync) window.Sync.setVf(saved.vf || null);
      try { await openWith(await NotesCrypto.importRawKey(saved.key), env); return; } catch { forget(); }
    } else if (saved) forget();
    showGate();
  }
  boot();
})();
