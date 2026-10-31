/* Daily Notes – edits core (shared by the browser overlay and tools/apply-edits.mjs). No data lives here.
   An edit: { eid, sec, op, key, label, labelText, val, at }
     sec / op (see OPS_BY):
       todo done|add · taskings status · bills status · reminders add|done · quick_notes add · health.sleep|health.weight log
       health.exercise add (val {id, date, type, minutes}) · mpat_log add (val {id, date, area, score, time, notes})
       studies done (MMPA checklist tick) · progress set (key "wd1.<field>" | "finance.savingsTotal", val number|null)
       va.daily log (val {date, sent, replies}) · va.leads add|set (val {name, role, status, note})
       links add|set|del (val {title, url, category, note}) · transactions add|set|del (val {date, type, amount, category, account, note, bill})
     key: "id:<item.id>" when the item has an id, else "h:<hash of section|text>" (see keyOf). Dotted sections live in
          nested objects (health.sleep → notes.health.sleep, va.daily → notes.va.daily).
   A sync state (Sheet blob / pull-edits): { dn_edits:1, device, exported, edits:[…], tomb:{eid: iso} } – see mergeSync. */
(function (root) {
  'use strict';
  const str = (v) => (v == null ? '' : typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
  const pick = (o, ...ks) => { if (o && typeof o === 'object') for (const k of ks) { const s = str(o[k]); if (s) return s; } return ''; };
  const norm = (s) => str(s).toLowerCase().replace(/\s+/g, ' ');
  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && isFinite(+v.replace(/,/g, '')) ? +v.replace(/,/g, '') : null);
  const isObj = (x) => !!(x && typeof x === 'object' && !Array.isArray(x));
  const isoOk = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str(s)); return !!m && !isNaN(Date.parse(m[0] + 'T00:00:00Z')) && new Date(m[0] + 'T00:00:00Z').toISOString().slice(0, 10) === m[0]; };
  function hid(s) { let x = 5381; for (let i = 0; i < s.length; i++) x = ((x << 5) + x + s.charCodeAt(i)) >>> 0; return x.toString(36); }
  const OLD = ['todo', 'taskings', 'bills', 'reminders', 'quick_notes', 'health.sleep', 'health.weight']; // v1 sections: any of done|status|add|log
  const OPS_BY = { links: ['add', 'set', 'del'], transactions: ['add', 'set', 'del'], 'va.leads': ['add', 'set'], 'va.daily': ['log'],
    'health.exercise': ['add'], mpat_log: ['add'], studies: ['done'], progress: ['set'] };
  const SECS = OLD.concat(Object.keys(OPS_BY));
  const OPS = ['done', 'status', 'add', 'log', 'set', 'del'];

  /* ---------- value normalisers (null = invalid) ---------- */
  // Only plain http(s) links are ever stored, applied or rendered (no javascript:, data:, mailto: …).
  function safeUrl(u) {
    const s = str(u);
    if (!s || s.length > 2000 || /\s/.test(s) || !/^https?:\/\/[^\/?#\s]+/i.test(s)) return '';
    try { const x = new URL(s); return x.protocol === 'http:' || x.protocol === 'https:' ? s : ''; } catch { return /^https?:\/\/[\w.-]+(:\d+)?([\/?#]|$)/i.test(s) ? s : ''; }
  }
  const longDigits = (s) => /\d[\d\s-]{7,}\d/.test(str(s).replace(/[₱,.]/g, '')); // looks like an account / ID number
  function linkVal(v) {
    if (!isObj(v)) return null;
    const o = { title: str(v.title || v.name).slice(0, 120), url: safeUrl(v.url || v.href), category: str(v.category).slice(0, 60) || 'Other', note: str(v.note).slice(0, 300) };
    return o.title && o.url ? o : null;
  }
  const TX_TYPES = ['expense', 'bill', 'sent', 'received'];
  const TX_OUT = ['Food', 'Transport', 'Bills', 'Loan', 'Family', 'Shopping', 'Health', 'Church/Giving', 'Business', 'Other'];
  const TX_IN = ['Salary', 'Allowance', 'VA client', 'Refund', 'Other'];
  const TX_ACCOUNTS = ['GoTyme', 'Maya', 'MariBank', 'GCash', 'Cash', 'Other'];
  function txVal(v) {
    if (!isObj(v)) return null;
    const type = norm(v.type).replace(/^paid ?bill$/, 'bill').replace(/^sent money$/, 'sent');
    const amount = num(v.amount);
    if (!TX_TYPES.includes(type) || amount == null || !(amount > 0) || amount > 1e8 || !isoOk(v.date)) return null;
    const cats = type === 'received' ? TX_IN : TX_OUT, ci = cats.map(norm).indexOf(norm(v.category)), ai = TX_ACCOUNTS.map(norm).indexOf(norm(v.account));
    const note = str(v.note).slice(0, 200), bill = str(v.bill).slice(0, 120);
    if (longDigits(note)) return null; // never store account / ID numbers
    const o = { date: str(v.date), type, amount: Math.round(amount * 100) / 100, category: ci >= 0 ? cats[ci] : type === 'bill' ? 'Bills' : 'Other', account: ai >= 0 ? TX_ACCOUNTS[ai] : 'Other' };
    if (note) o.note = note; if (bill && type === 'bill') o.bill = bill;
    return o;
  }
  const LEAD_STATUS = ['Interested', 'Interview', 'Offer', 'Hired', 'Lost'];
  function leadVal(v) {
    if (!isObj(v)) return null;
    const si = LEAD_STATUS.map(norm).indexOf(norm(v.status));
    const o = { name: str(v.name || v.client || v.company).slice(0, 80), role: str(v.role || v.service).slice(0, 80), status: si >= 0 ? LEAD_STATUS[si] : 'Interested' };
    const note = str(v.note).slice(0, 300); if (note) o.note = note;
    if (!o.name || longDigits(note)) return null;
    return o;
  }
  const EX_TYPES = ['Exercise', 'Gym', 'Run', 'Walk', 'Sports'];
  function exVal(v) {
    if (!isObj(v)) return null;
    const ti = EX_TYPES.map(norm).indexOf(norm(v.type)), m = num(v.minutes);
    if (!isoOk(v.date) || m == null || m < 1 || m > 600) return null;
    return Object.assign(str(v.id) ? { id: str(v.id) } : {}, { date: str(v.date), type: ti >= 0 ? EX_TYPES[ti] : 'Exercise', minutes: Math.round(m) });
  }
  function mpatVal(v) {
    if (!isObj(v) || !isoOk(v.date)) return null;
    const o = Object.assign(str(v.id) ? { id: str(v.id) } : {}, { date: str(v.date) });
    [['area', 60], ['score', 20], ['time', 20], ['notes', 300]].forEach(([k, n]) => { const s = str(v[k]).slice(0, n); if (s) o[k] = s; });
    return o;
  }
  const cnt = (x) => { const n = num(x); return n == null ? null : Math.max(0, Math.min(9999, Math.round(n))); };
  function dailyVal(v) { if (!isObj(v) || !isoOk(v.date)) return null; const s = cnt(v.sent) ?? 0, r = cnt(v.replies) ?? 0; return { date: str(v.date), sent: s, replies: r }; }
  // wd1.<field> progress edits are RETIRED (Oct 2026): the whole WD1 card is pulled from the ABM board, so an old phone edit (e.g. wd1.live)
  // is invalid → dropped from the Outbox / sync queue (badge clears) and never applied.
  const PROGRESS_KEY = /^(finance\.savingsTotal)$/;
  const progVal = (v) => (v === null ? null : (() => { const n = num(v); return n != null && n >= 0 && n <= 1e10 ? Math.round(n * 100) / 100 : undefined; })());
  // record sections (add / set / del of whole items)
  const REC = { links: linkVal, transactions: txVal, 'va.leads': leadVal };

  /* ---------- items ---------- */
  function textOf(sec, it) {
    if (typeof it === 'string') return it.trim();
    if (!it || typeof it !== 'object') return '';
    if (sec === 'bills') return [pick(it, 'name', 'title', 'item'), str(it.due ?? it.due_date ?? it.date)].filter(Boolean).join(' | ');
    if (sec === 'taskings') return pick(it, 'task', 'title', 'item');
    if (sec === 'quick_notes') return pick(it, 'text', 'note', 'item');
    if (sec === 'links') return [pick(it, 'title', 'name'), pick(it, 'url', 'href')].filter(Boolean).join(' | ');
    if (sec === 'studies') return [pick(it, 'code', 'name', 'subject'), pick(it, 'title')].filter(Boolean).join(' – ');
    if (sec === 'transactions') return [str(it.date), str(it.type), str(it.amount), pick(it, 'category'), pick(it, 'note')].filter(Boolean).join(' | ');
    if (sec === 'va.leads') return [pick(it, 'name', 'client', 'company'), pick(it, 'role', 'service')].filter(Boolean).join(' | ');
    if (sec === 'health.exercise') return [str(it.date), pick(it, 'type'), str(it.minutes)].join(' | ');
    if (sec === 'mpat_log') return [str(it.date), pick(it, 'area'), pick(it, 'score')].filter(Boolean).join(' | ');
    return pick(it, 'item', 'task', 'text', 'title');
  }
  const hashKey = (sec, it) => 'h:' + hid(sec + '|' + norm(textOf(sec, it)));
  function keyOf(sec, it) { return it && typeof it === 'object' && str(it.id) ? 'id:' + str(it.id) : hashKey(sec, it); }
  function listOf(notes, sec) {
    if (!isObj(notes)) return [];
    if (sec.includes('.')) { const [a, b] = sec.split('.'); const o = notes[a]; const v = isObj(o) ? o[b] : null; return Array.isArray(v) ? v : []; }
    if (sec === 'studies') { const v = notes.studies ?? notes.mmpa; return Array.isArray(v) ? v : isObj(v) && Array.isArray(v.subjects) ? v.subjects : []; }
    const v = notes[sec === 'todo' && notes.todo == null ? 'todos' : sec];
    return Array.isArray(v) ? v : [];
  }
  function findIndex(notes, e) {
    const xs = listOf(notes, e.sec);
    let i = xs.findIndex((x) => keyOf(e.sec, x) === e.key);
    if (i < 0) i = xs.findIndex((x) => hashKey(e.sec, x) === e.key);
    if (i < 0 && e.label) i = xs.findIndex((x) => norm(textOf(e.sec, x)) === norm(e.labelText || e.label));
    return i;
  }
  const sameRec = (sec, it, v) => { const a = it && typeof it === 'object' ? REC[sec](it) : null; return !!(a && v && JSON.stringify(a) === JSON.stringify(v)); };
  const LOGF = { 'health.sleep': ['hours'], 'health.weight': ['kg'], 'va.daily': ['sent', 'replies'] };
  // progress paths
  function getProg(notes, k) {
    const [a, b] = k.split('.');
    const o = isObj(notes) ? notes[a] : null; if (!isObj(o)) return undefined;
    if (a === 'wd1') { const f = o[b]; return isObj(f) ? (f.cur ?? f.current ?? null) : undefined; }
    return o[b] ?? null;
  }
  const taskKey = (s) => { const t = norm(s); return /done|complete|closed/.test(t) ? 'done' : /progress|ongoing|wip|started/.test(t) ? 'prog' : 'open'; };
  // Does notes.json already show this edit's result?
  function isReflected(notes, e) {
    if (!isObj(notes) || !e) return false;
    if (e.sec === 'progress') { const g = getProg(notes, e.key); return g !== undefined && (g === null ? e.val === null : num(g) === e.val); }
    if (REC[e.sec] && e.op !== 'add') {
      const xs = listOf(notes, e.sec);
      if (e.op === 'del') return findIndex(notes, e) < 0;
      const v = REC[e.sec](e.val); if (!v) return false;
      const i = findIndex(notes, e);
      return i >= 0 ? sameRec(e.sec, xs[i], v) : xs.some((x) => sameRec(e.sec, x, v));
    }
    if (e.op === 'add') {
      const xs = listOf(notes, e.sec), v = e.val || {};
      // repeatable entries (two ₱50 lunches, two walks a day): match by id; text only when Denx's copy has no id
      const byId = ['transactions', 'health.exercise', 'mpat_log', 'va.leads'].includes(e.sec);
      return xs.some((x) => (x && typeof x === 'object' && v.id && str(x.id) === v.id) || ((!byId || !(x && typeof x === 'object' && str(x.id))) && norm(textOf(e.sec, x)) && norm(textOf(e.sec, x)) === norm(textOf(e.sec, v))));
    }
    if (e.op === 'log') {
      const fs = LOGF[e.sec] || [], v = e.val || {};
      return listOf(notes, e.sec).some((x) => x && str(x.date).slice(0, 10) === v.date && fs.every((f) => Math.abs((num(x[f]) ?? 0) - (num(v[f]) ?? 0)) < 0.01));
    }
    const i = findIndex(notes, e);
    if (i < 0) return false;
    const it = listOf(notes, e.sec)[i];
    if (e.op === 'done') return !!(it && typeof it === 'object' && it.done) === !!e.val;
    if (e.op === 'status' && e.sec === 'taskings') return taskKey(it && it.status) === taskKey(e.val);
    if (e.op === 'status' && e.sec === 'bills') return norm(it && it.status) === norm(e.val);
    return false;
  }
  const clone = (x) => JSON.parse(JSON.stringify(x));
  // Apply edits to a copy of notes. mark=true tags touched items with _local (browser only; never written by the CLI).
  function apply(notes, edits, mark) {
    const out = clone(isObj(notes) ? notes : {});
    const res = { applied: [], reflected: [], missing: [] };
    const ensure = (sec) => {
      if (sec.includes('.')) { const [a, b] = sec.split('.'); if (!isObj(out[a])) out[a] = {}; if (!Array.isArray(out[a][b])) out[a][b] = []; return out[a][b]; }
      if (sec === 'studies') { const v = out.studies ?? out.mmpa; if (isObj(v)) { if (!Array.isArray(v.subjects)) v.subjects = []; return v.subjects; } if (out.studies == null && Array.isArray(out.mmpa)) return out.mmpa; }
      const k = sec === 'todo' && out.todo == null && Array.isArray(out.todos) ? 'todos' : sec;
      if (!Array.isArray(out[k])) out[k] = out[k] == null ? [] : [out[k]];
      return out[k];
    };
    const ordered = [...(edits || [])].sort((a, b) => (a.op === 'add' ? 0 : 1) - (b.op === 'add' ? 0 : 1) || str(a.at).localeCompare(str(b.at)));
    for (const e of ordered) {
      if (!validEdit(e)) continue;
      if (isReflected(out, e)) { res.reflected.push(e); continue; }
      if (e.sec === 'progress') {
        const [a, b] = e.key.split('.');
        if (!isObj(out[a])) out[a] = {};
        if (a === 'wd1') { if (!isObj(out.wd1[b])) out.wd1[b] = {}; out.wd1[b].cur = e.val; if (mark) out.wd1[b]._local = 'edited'; }
        else { out[a][b] = e.val; if (b === 'savingsTotal') out[a].savingsAsOf = str(e.at).slice(0, 10); if (mark) out[a]._local = 'edited'; }
        res.applied.push(e); continue;
      }
      const xs = ensure(e.sec);
      if (REC[e.sec]) {
        if (e.op === 'add') { const v = REC[e.sec](e.val); if (!v) { res.missing.push(e); continue; } const it = Object.assign(str(e.val.id) ? { id: str(e.val.id) } : {}, v); if (!it.note) delete it.note; if (e.sec === 'va.leads') it.updated = str(e.at).slice(0, 10); if (mark) it._local = 'added'; xs.push(it); res.applied.push(e); continue; }
        const i = findIndex(out, e);
        if (i < 0) { res.missing.push(e); continue; }
        if (e.op === 'del') { xs.splice(i, 1); res.applied.push(e); continue; }
        const v = REC[e.sec](e.val); if (!v) { res.missing.push(e); continue; }
        const prev = typeof xs[i] === 'object' && xs[i] ? xs[i] : {};
        const it = xs[i] = Object.assign(str(prev.id) ? { id: str(prev.id) } : {}, v);
        for (const [k2, x] of Object.entries(prev)) if (!(k2 in it) && !['name', 'href', 'note', 'client', 'company', 'service', 'bill', '_local', '_lkey'].includes(k2) && !(k2 in v)) it[k2] = x; // keep extra fields Denx added
        if (!it.note) delete it.note;
        if (e.sec === 'va.leads') it.updated = str(e.at).slice(0, 10);
        if (mark) { it._local = 'edited'; it._lkey = e.key; }
        res.applied.push(e); continue;
      }
      if (e.op === 'add') {
        const v = e.sec === 'health.exercise' ? exVal(e.val) : e.sec === 'mpat_log' ? mpatVal(e.val) : clone(e.val || {});
        if (!v) { res.missing.push(e); continue; }
        if (mark) v._local = 'added'; xs.push(v); res.applied.push(e); continue;
      }
      if (e.op === 'log') {
        const v = e.sec === 'va.daily' ? dailyVal(e.val) : clone(e.val || {}), j = xs.findIndex((x) => x && str(x.date).slice(0, 10) === v.date);
        if (mark) v._local = 'logged';
        if (j >= 0) xs[j] = Object.assign({}, xs[j], v); else xs.push(v);
        xs.sort((a, b) => str(a && a.date).localeCompare(str(b && b.date)));
        res.applied.push(e); continue;
      }
      const i = findIndex(out, e);
      if (i < 0) { res.missing.push(e); continue; }
      let it = xs[i];
      if (typeof it !== 'object' || it == null) it = xs[i] = e.sec === 'taskings' ? { task: str(it) } : e.sec === 'studies' ? { title: str(it) } : { item: str(it) };
      if (e.op === 'done') it.done = !!e.val;
      else if (e.op === 'status') it.status = e.val;
      if (e.op === 'status' && e.sec === 'bills' && e.val === 'paid' && !it.paid_on) it.paid_on = str(e.at).slice(0, 10);
      if (e.op === 'done' && e.val && !it.done_on) it.done_on = str(e.at).slice(0, 10);
      if (e.op === 'done' && !e.val) delete it.done_on;
      if (e.op === 'status' && e.sec === 'taskings' && taskKey(e.val) === 'done' && !it.done_on) it.done_on = str(e.at).slice(0, 10);
      if (mark) it._local = 'edited';
      res.applied.push(e);
    }
    return { notes: out, ...res };
  }
  const php = (n) => '₱' + (num(n) ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const TX_WORD = { expense: 'Expense', bill: 'Paid bill', sent: 'Sent money', received: 'Received' };
  function describe(e) {
    const q = (s) => `“${str(s)}”`, v = e.val || {};
    switch (e.sec + ':' + e.op) {
      case 'todo:done': return `To-do ${e.val ? '✅ done' : '↩︎ not done'}: ${q(e.label)}`;
      case 'reminders:done': return `Reminder ${e.val ? '✅ done' : '↩︎ not done'}: ${q(e.label)}`;
      case 'taskings:status': return `Tasking → ${e.val}: ${q(e.label)}`;
      case 'bills:status': return `Bill marked ${e.val}: ${q(e.label)}`;
      case 'todo:add': return `New to-do: ${q(v.item)}${v.due ? ` (due ${v.due})` : ''}`;
      case 'reminders:add': return `New reminder: ${q(v.item)}${v.due ? ` (due ${v.due})` : ''}`;
      case 'quick_notes:add': return `Quick note: ${q(v.text)}`;
      case 'health.sleep:log': return `Sleep logged: ${v.date} · ${v.hours} h`;
      case 'health.weight:log': return `Weight logged: ${v.date} · ${v.kg} kg`;
      case 'health.exercise:add': return `Exercise logged: ${v.date} · ${str(v.type) || 'Exercise'} ${v.minutes} min`;
      case 'mpat_log:add': return `MPAT practice logged: ${v.date}${v.area ? ' · ' + v.area : ''}${v.score ? ' · score ' + v.score : ''}${v.time ? ' · ' + v.time : ''}`;
      case 'studies:done': return `MMPA subject ${e.val ? '✅ reviewed' : '↩︎ not reviewed'}: ${q(e.label)}`;
      case 'progress:set': return e.key === 'finance.savingsTotal' ? `Savings total set: ${e.val == null ? 'cleared' : php(e.val)}` : `WD1 ${e.key.slice(4).replace(/_/g, ' ')} set: ${e.val == null ? 'cleared' : e.val}`;
      case 'va.daily:log': return `VA outreach ${v.date}: ${v.sent} email${v.sent === 1 ? '' : 's'} sent · ${v.replies} repl${v.replies === 1 ? 'y' : 'ies'}`;
      case 'va.leads:add': return `New VA lead: ${q(v.name)}${v.role ? ' · ' + str(v.role) : ''} [${str(v.status) || 'Interested'}]`;
      case 'va.leads:set': return `VA lead updated: ${q(e.label)} → ${q(v.name)}${v.role ? ' · ' + str(v.role) : ''} [${str(v.status)}]`;
      case 'links:add': return `New link: ${q(v.title)}${v.category ? ` [${str(v.category)}]` : ''} → ${str(v.url)}`;
      case 'links:set': return `Link edited: ${q(e.label)} → ${q(v.title)}${v.category ? ` [${str(v.category)}]` : ''} ${str(v.url)}`;
      case 'links:del': return `Link deleted: ${q(e.label)}`;
      case 'transactions:add': return `Money logged: ${v.date} · ${TX_WORD[norm(v.type)] || v.type} ${php(v.amount)} · ${str(v.category)} · ${str(v.account)}${v.bill ? ` (bill ${q(v.bill)})` : ''}${v.note ? ' · ' + str(v.note) : ''}`;
      case 'transactions:set': return `Money entry edited: ${q(e.label)} → ${v.date} · ${TX_WORD[norm(v.type)] || v.type} ${php(v.amount)} · ${str(v.category)} · ${str(v.account)}`;
      case 'transactions:del': return `Money entry deleted: ${q(e.label)}`;
      default: return `${e.sec} ${e.op}: ${q(e.label)}`;
    }
  }
  // Sync merge (phone ⇄ Sheet ⇄ other phone): union of edits by eid (newest `at` wins); a tombstone {eid: iso} records a
  // removal (undo / discard / now in notes.json) and beats any copy of that edit that is not newer. Old tombstones expire.
  const TOMB_DAYS = 60;
  function mergeSync(a, b, nowIso) {
    const tomb = {}, by = {};
    for (const x of [a, b]) {
      const t = x && x.tomb && typeof x.tomb === 'object' ? x.tomb : {};
      for (const [eid, at] of Object.entries(t)) if (typeof at === 'string' && (!tomb[eid] || at > tomb[eid])) tomb[eid] = at;
      for (const e of (x && Array.isArray(x.edits) ? x.edits : [])) if (validEdit(e) && (!by[e.eid] || str(e.at) > str(by[e.eid].at))) by[e.eid] = e;
    }
    const cutoff = new Date(Date.parse(nowIso || new Date().toISOString()) - TOMB_DAYS * 86400000).toISOString();
    for (const eid of Object.keys(tomb)) if (tomb[eid] < cutoff) delete tomb[eid];
    const edits = Object.values(by).filter((e) => !(tomb[e.eid] && tomb[e.eid] >= str(e.at))).sort((x, y) => str(x.at).localeCompare(str(y.at)) || x.eid.localeCompare(y.eid));
    return { edits, tomb };
  }
  function syncSig(x) {
    const es = (x && Array.isArray(x.edits) ? x.edits : []).map((e) => JSON.stringify([e.eid, e.at, e.val])).sort();
    const ts = Object.entries((x && x.tomb) || {}).map(([k, v]) => k + '@' + v).sort();
    return JSON.stringify([es, ts]);
  }
  function validEdit(e) {
    if (!(e && typeof e === 'object' && SECS.includes(e.sec) && OPS.includes(e.op) && str(e.eid))) return false;
    if (OLD.includes(e.sec)) return ['done', 'status', 'add', 'log'].includes(e.op);
    if (!OPS_BY[e.sec].includes(e.op)) return false;
    if (REC[e.sec]) return e.op === 'del' ? !!str(e.key) : !!REC[e.sec](e.val) && (e.op === 'add' || !!str(e.key));
    switch (e.sec) {
      case 'health.exercise': return !!exVal(e.val);
      case 'mpat_log': return !!mpatVal(e.val);
      case 'studies': return typeof e.val === 'boolean' && !!str(e.key);
      case 'progress': return PROGRESS_KEY.test(str(e.key)) && progVal(e.val) !== undefined && (e.val === null || progVal(e.val) === e.val);
      case 'va.daily': { const v = dailyVal(e.val); return !!v && v.sent === e.val.sent && v.replies === e.val.replies; }
    }
    return false;
  }

  /* ================= view normaliser: what the site is allowed to show =================
     Pure functions, applied to the merged notes right before rendering (Features.merge / app.js render), so Today, Week, badges,
     search, pings and the weekly review all agree. They never touch notes.json or the stored edits.
     1. stripAlarms – phone alarms are not Daily Notes content (the event itself is). Dropped: any entry whose text starts with
        "Alarm:" / "0530 Alarm: …" / "⏰ Alarm …", entries typed/kind "alarm", and a top-level `alarms` section. A reminder/to-do that is
        just the event again with an "(alarm 0530 …)" note is dropped when an event exists on the same date (shown once, as the event).
     2. autoDone – standing rule: a to-do / reminder / tasking whose date (or date+time today) has passed counts as DONE unless it was
        cancelled (cancelled ones are simply hidden). Items due today stay until their day (or stated time) is over. Bills are money
        status and are never auto-flipped. */
  const dayOf = (s) => { const m = /^(\d{4}-\d{2}-\d{2})/.exec(str(s)); return m && isoOk(m[1]) ? m[1] : null; };
  const timeOf = (s) => { const m = /^\d{4}-\d{2}-\d{2}[T ](\d{2}):(\d{2})/.exec(str(s)); return m ? m[1] + ':' + m[2] : null; };
  const TEXT_KEYS = ['item', 'event', 'title', 'text', 'task', 'name'];
  const ALARM_START = /^(?:[⏰🔔]\uFE0F?\s*)?(?:\d{1,2}[:.]?\d{2}\s*(?:h|hrs?)?\s*[-–—:]?\s*)?(?:(?:wake[- ]?up|morning)\s+)?alarm(?:\s+clock)?\s*(?:[:\-–—~@]|\b(?:at|for|to|set|on)\b|\d)/i;
  const ALARM_PAREN = /\(\s*(?:set\s+)?alarm\b[^)]*\)/i;
  // A to-do whose text IS a reminder ("Remind me to…", "Reminder: …", 🔔 …) is a reminder: the UI shows it in Reminders, never as a tick-off task.
  const REMINDER_TEXT_RE = /^\s*(?:🔔|remind\s+me\b|reminders?\s*[:\-–—]|reminder\s+to\b)/i;
  const entryText = (it) => (typeof it === 'string' ? str(it) : isObj(it) ? pick(it, ...TEXT_KEYS) : '');
  const isAlarm = (it) => {
    if (isObj(it) && /^alarms?$/i.test(pick(it, 'type', 'kind', 'category'))) return true;
    return ALARM_START.test(entryText(it));
  };
  const SEC_DATE = { today: ['date'], schedule: ['date'], reminders: ['due', 'date'], todo: ['due', 'deadline'], todos: ['due', 'deadline'], taskings: ['deadline', 'due'], tasks: ['deadline', 'due'] };
  // The free-text note lists (and weekly_review's lists) get the same standing rules as the dated lists. Money / health RECORDS
  // (bills, transactions, health, finance…) are data, never filtered by topic or text.
  const NOTE_LISTS = ['ideas', 'quick_notes', 'decisions', 'wins', 'finance_tips'];
  function mapNoteLists(notes, fn, extra) {
    const out = Object.assign({}, notes);
    for (const sec of NOTE_LISTS.concat(extra || [])) if (Array.isArray(out[sec])) out[sec] = fn(out[sec]);
    if (isObj(out.weekly_review)) { const w = Object.assign({}, out.weekly_review); for (const k of Object.keys(w)) if (Array.isArray(w[k])) w[k] = fn(w[k]); out.weekly_review = w; }
    return out;
  }
  function stripAlarms(notes0) {
    if (!isObj(notes0)) return notes0;
    const notes = mapNoteLists(notes0, (xs) => xs.filter((it) => !isAlarm(it)));
    const out = Object.assign({}, notes);
    for (const k of Object.keys(out)) if (/^alarms?$/i.test(k)) delete out[k];
    const eventDates = new Set();
    for (const sec of ['today', 'schedule']) if (Array.isArray(out[sec])) out[sec].forEach((e) => { if (isObj(e) && !isAlarm(e)) { const d = dayOf(e.date); if (d) eventDates.add(d); } });
    for (const sec of Object.keys(SEC_DATE)) {
      if (!Array.isArray(out[sec])) continue;
      const isEvents = sec === 'today' || sec === 'schedule';
      out[sec] = out[sec].filter((it) => {
        if (isAlarm(it)) return false;
        if (!isEvents && ALARM_PAREN.test(entryText(it)) && isObj(it)) { const d = dayOf(pick(it, ...SEC_DATE[sec])); if (d && eventDates.has(d)) return false; }
        return true;
      });
    }
    return out;
  }
  const isCancelled = (it) => it.cancelled === true || /^cancell?ed$/i.test(str(it.status)) || /^cancell?ed$/i.test(str(it.state));
  function autoDone(notes, todayISO, nowHM) {
    if (!isObj(notes) || !dayOf(todayISO)) return notes;
    const out = Object.assign({}, notes);
    const over = (raw) => { const d = dayOf(raw); if (!d) return null; if (d < todayISO) return d; const t = timeOf(raw); return d === todayISO && t && nowHM && t < nowHM ? d : null; };
    const DONE_ST = /done|complete|closed|✅|🟢/i;
    for (const [sec, st] of [['todo', 0], ['todos', 0], ['reminders', 0], ['taskings', 1], ['tasks', 1]]) {
      if (!Array.isArray(out[sec])) continue;
      out[sec] = out[sec].map((it) => {
        if (!isObj(it)) return it;
        const isDone = st ? DONE_ST.test(str(it.status)) : !!it.done;
        if (isDone) return it;
        const cancelled = isCancelled(it);
        const d = cancelled ? null : over(pick(it, ...SEC_DATE[sec]));
        if (!cancelled && !d) return it;
        const o = Object.assign({}, it, { _autodone: cancelled ? 'cancelled' : 'past' });
        if (st) o.status = 'Done'; else o.done = true;
        o.done_on = str(it.done_on) || d || todayISO;
        return o;
      });
    }
    return out;
  }
  /* ---------- removed topics (Oct 2026): the MMPA and Law-school topics are gone for good ----------
     Hidden here – the one choke point every card, search and nudge reads through – even if notes.json still carries them. */
  const REMOVED_RE = /\bmmpa\b|\blaw[\s-]*school\b|\bg-law\b|\bcomprehensive[\s-]*exam/i;
  const REMOVED_KEYS = ['studies', 'mmpa', 'mmpa_exam_date'];
  const hasRemoved = (it) => {
    if (typeof it === 'string') return REMOVED_RE.test(it);
    if (!isObj(it)) return false;
    return REMOVED_RE.test([it.id, ...TEXT_KEYS.map((k) => it[k]), it.next_step, it.next, it.area, it.category].map((x) => (typeof x === 'string' ? x : '')).join(' | '));
  };
  function dropRemoved(notes) {
    if (!isObj(notes)) return notes;
    const out = Object.assign({}, notes);
    for (const k of REMOVED_KEYS) delete out[k];
    for (const sec of ['goals', 'today', 'schedule', 'todo', 'todos', 'taskings', 'tasks', 'reminders', 'ideas', 'habits']) {
      if (Array.isArray(out[sec])) out[sec] = out[sec].filter((it) => !hasRemoved(it));
    }
    return mapNoteLists(out, (xs) => xs.filter((it) => !hasRemoved(it)), ['links']);
  }
  /* ---------- one activity shows exactly once ----------
     Same calendar day, an event / tasking / to-do / reminder that says (substantially) the same thing as a higher-priority entry is
     hidden: the calendar line wins over the tasking, then the to-do, then the reminder. Local (✎) entries are never hidden. */
  const STOP = new Set('the and for with from that this your you are was has have not but all any can will due day pay get set got new one two out off per via into onto over under about after before then than also just very more some such only still need needs to-do todo task reminder remind reminders'.split(' '));
  const stem = (w) => w.replace(/(?:ations?|ition|ings?|ied|ies|ed|es|s)$/, (m) => (m === 'ied' || m === 'ies' ? 'y' : ''));
  const toks = (t) => { const set = new Set(); String(t || '').toLowerCase().replace(/[₱$€£]\s?[\d.,]+/g, ' ').split(/[^a-z0-9]+/).forEach((w) => { if (w.length < 3 || /^\d+$/.test(w) || STOP.has(w)) return; set.add(stem(w)); }); return set; };
  const shared = (a, b) => { let n = 0; for (const x of a) if (b.has(x)) n++; return n; };
  const RANK = { today: 0, schedule: 0, taskings: 1, tasks: 1, todo: 2, todos: 2, reminders: 3 };
  function sameThing(hi, lo) { // hi: higher-priority entry, lo: candidate duplicate
    if (hi.rank === lo.rank || lo.rank === 0) { // peers: only near-identical text counts
      const n = shared(hi.all, lo.all), m = Math.min(hi.all.size, lo.all.size);
      return m > 0 && (n >= 2 || (n === hi.all.size && n === lo.all.size)) && n / m >= 0.8;
    }
    for (const part of hi.parts) { // an event line may bundle several things ("Payday …; Paramount … decision due"): compare each clause too
      const n = shared(part, lo.all), m = Math.min(part.size, lo.all.size);
      if (m > 0 && (n >= 2 || (n === part.size && n === lo.all.size)) && n / m >= 0.5) return true;
    }
    return false;
  }
  function dedupe(notes) {
    if (!isObj(notes)) return notes;
    const all = [];
    for (const sec of Object.keys(RANK)) {
      if (!Array.isArray(notes[sec])) continue;
      notes[sec].forEach((it, idx) => {
        if (!isObj(it)) return;
        const day = dayOf(pick(it, ...SEC_DATE[sec])), text = entryText(it);
        if (!day || !text) return;
        all.push({ sec, idx, day, rank: RANK[sec], local: !!it._local, all: toks(text), parts: String(text).split(/\s*[;|•]\s*|\s+[–—]\s+/).map(toks).filter((x) => x.size) });
      });
    }
    all.sort((a, b) => a.rank - b.rank || (a.sec === b.sec ? a.idx - b.idx : 0));
    const hide = {}; const kept = [];
    for (const x of all) {
      if (!x.all.size) { kept.push(x); continue; }
      const dup = !x.local && kept.some((k) => k.day === x.day && sameThing(k, x));
      if (dup) (hide[x.sec] || (hide[x.sec] = new Set())).add(x.idx); else kept.push(x);
    }
    const secs = Object.keys(hide);
    if (!secs.length) return notes;
    const out = Object.assign({}, notes);
    for (const sec of secs) out[sec] = notes[sec].filter((_, i) => !hide[sec].has(i));
    return out;
  }
  /* ================= 💪 Fitness tab (read-only plan; Denx keeps the `fitness` section in notes.json) =================
     The plan text (weight, body fat, food, training) is private, so it lives ONLY in the encrypted notes.json – never in this public file.
     fitnessModel(raw)  → a clean, display-ready model (or null): strings trimmed, duplicates removed, anything that would break a standing
                          rule dropped (tick-boxes / "x/8" counters / "Reset checklist" / "Copy monthly records" / alarm lines), tracker blanks = "—".
     fitnessToday(m,iso)→ today's (Asia/Manila date passed in by the caller) training day + lunch viand, picked from the weekday.
     fitnessCheck(raw)  → {errors, warnings} for tools/validate.mjs. */
  const FIT_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const FIT_OFFENCE = /^\s*(?:\[\s*[xX✓✔]?\s*\]|[☐☑☒✓✔])|[☐☑☒]|\b\d+\s*\/\s*\d+\b|reset\s+checklist|copy\s+monthly\s+records/i;
  const fitOffence = (t) => FIT_OFFENCE.test(t) || ALARM_START.test(str(t)) || ALARM_PAREN.test(str(t));
  const fitText = (v) => { const t = str(v).replace(/\s+/g, ' ').trim(); return t && !fitOffence(t) ? t : ''; };
  const fitKey = (v) => String(v).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const fitUniq = (xs, keyOf) => { const seen = new Set(); return xs.filter((x) => { const k = keyOf(x); if (!k || seen.has(k)) return false; seen.add(k); return true; }); };
  const fitStrs = (v) => fitUniq((Array.isArray(v) ? v : []).map(fitText).filter(Boolean), fitKey);
  const fitObjs = (v, make, keyOf) => fitUniq((Array.isArray(v) ? v : []).map((x) => (isObj(x) ? make(x) : null)).filter(Boolean), keyOf);
  const fitDayIdx = (s) => { const k = str(s).slice(0, 3).toLowerCase(); return FIT_DAYS.findIndex((d) => d.toLowerCase() === k); };
  /* physique goals (optional fitness.physique): targets summary, V-taper ratio COMPUTED from shoulders ÷ waist (never read from the data),
     measurement rows with current / target / gap. Pure display model – no text of Daniel's is in this file. */
  const fitNum = (v) => { const n = typeof v === 'number' ? v : /^-?\d+(?:\.\d+)?$/.test(str(v)) ? parseFloat(str(v)) : NaN; return Number.isFinite(n) ? n : NaN; };
  const fitRange = (v) => { const n = fitNum(v); if (!Number.isNaN(n)) return [n, n]; const m = /^(-?\d+(?:\.\d+)?)\s*[–—-]\s*(-?\d+(?:\.\d+)?)$/.exec(str(v)); return m ? [parseFloat(m[1]), parseFloat(m[2])].sort((a, b) => a - b) : null; };
  const fitFmt = (n, d = 1) => String(parseFloat(n.toFixed(d))).replace('-', '−');
  const fitSigned = (n) => (Math.abs(n) < 0.05 ? '0' : (n > 0 ? '+' : '') + fitFmt(n));
  function fitGap(cur, tgt) {
    const c = fitRange(cur), t = fitRange(tgt); if (!c || !t) return '';
    const lo = t[0] - c[1], hi = t[1] - c[0];
    if (lo < -0.05 && hi > 0.05) return 'on target';
    return Math.abs(lo - hi) < 0.05 ? fitSigned(lo) : `${fitSigned(lo)} to ${fitSigned(hi)}`;
  }
  const FIT_TG = [['weight_kg', 'Target weight', ' kg'], ['body_fat_pct', 'Target body fat', '%'], ['height_cm', 'Height', ' cm'], ['vtaper_ratio', 'V-taper ratio', '']];
  function fitPhysique(raw) {
    if (!isObj(raw)) return null;
    const tg = isObj(raw.targets) ? raw.targets : {};
    const targets = FIT_TG.map(([k, label, unit]) => { const n = fitNum(tg[k]); return n > 0 ? { label, value: fitFmt(n, 3) + unit } : null; }).filter(Boolean);
    const rawRows = Array.isArray(raw.measurements) ? raw.measurements.filter(isObj) : [];
    const rows = fitUniq(rawRows.map((x) => { const label = fitText(x.label), current = fitText(x.current), target = fitText(x.target); return label && (current || target) ? { label, unit: fitText(x.unit), current, target, gap: fitGap(current, target) } : null; }).filter(Boolean), (x) => fitKey(x.label));
    const pick = (id, re) => { const x = rawRows.find((r) => str(r.id).toLowerCase() === id) || rawRows.find((r) => re.test(str(r.label))); return x ? fitNum(x.current) : NaN; };
    const sh = pick('shoulders', /^shoulders?$/i), wa = pick('waist', /^waist\b/i), want = fitNum(tg.vtaper_ratio);
    const unitOf = (id) => { const x = rawRows.find((r) => str(r.id).toLowerCase() === id); return x ? fitText(x.unit) : ''; };
    const cur = sh > 0 && wa > 0 ? sh / wa : NaN, ok2 = want > 0;
    const ratio = !(cur > 0) && !ok2 ? null : { cur: cur > 0 ? cur.toFixed(2) : '', target: ok2 ? fitFmt(want, 3) : '', gap: cur > 0 && ok2 ? Math.abs(want - cur).toFixed(2) : '', pct: cur > 0 && ok2 ? Math.max(0, Math.min(100, Math.round((cur / want) * 100))) : 0,
      needShoulders: cur > 0 && ok2 ? fitFmt(want * wa, 1) : '', unit: unitOf('shoulders') };
    const p = { updated: dayOf(raw.updated) || '', targets, ratio, rows, emphasis: fitStrs(raw.emphasis), notes: fitStrs(raw.notes) };
    return targets.length || ratio || rows.length || p.emphasis.length || p.notes.length ? p : null;
  }
  function fitnessModel(raw) {
    if (!isObj(raw)) return null;
    const T = (k) => fitText(raw[k]);
    const start = isObj(raw.start) ? { line: fitText(raw.start.line), recommendation: fitText(raw.start.recommendation) } : { line: '', recommendation: '' };
    const trk = isObj(raw.tracker) ? raw.tracker : null;
    const columns = trk ? fitStrs(trk.columns) : [];
    const m = {
      updated: dayOf(raw.updated) || '',
      start,
      targets: fitObjs(raw.targets, (x) => { const label = fitText(x.label), value = fitText(x.value); return label && value ? { label, value, unit: fitText(x.unit), note: fitText(x.note) } : null; }, (x) => fitKey(x.label)),
      targetsNote: T('targets_note'), dietNote: T('diet_note'),
      meals: fitObjs(raw.meals, (x) => { const name = fitText(x.name), items = fitStrs(x.items); return name && items.length ? { name, items } : null; }, (x) => fitKey(x.name)),
      riceNote: T('rice_note'),
      viands: fitObjs(raw.viands, (x) => { const di = fitDayIdx(x.day), lunch = fitText(x.lunch); return di >= 0 && lunch ? { di, day: FIT_DAYS[di], lunch } : null; }, (x) => String(x.di)),
      viandAlts: fitStrs(raw.viand_alternatives), viandNote: T('viand_note'),
      habits: fitStrs(raw.habits), habitsNote: T('habits_note'),
      trainingIntro: T('training_intro'),
      training: fitObjs(raw.training, (x) => { const di = fitDayIdx(x.day), name = fitText(x.name); return di >= 0 && name ? { di, day: FIT_DAYS[di], name, focus: fitText(x.focus), items: fitStrs(x.items) } : null; }, (x) => String(x.di)),
      trainingRules: fitStrs(raw.training_rules),
      months: fitObjs(raw.months, (x) => { const n = parseInt(x.n, 10), title = fitText(x.title); return title ? { n: n > 0 ? n : 0, title, subtitle: fitText(x.subtitle), items: fitStrs(x.items), goal: fitText(x.goal) } : null; }, (x) => 'n' + (x.n || fitKey(x.title))),
      milestones: fitObjs(raw.milestones, (x) => { const stage = fitText(x.stage); return stage ? { stage, weight: fitText(x.weight), objective: fitText(x.objective) } : null; }, (x) => fitKey(x.stage)),
      milestonesNote: T('milestones_note'),
      tracker: trk && columns.length ? {
        columns,
        rows: fitObjs(trk.rows, (x) => { const label = fitText(x.label); if (!label) return null; const vs = Array.isArray(x.values) ? x.values : []; return { label, cells: columns.map((_, i) => fitText(vs[i]) || '—') }; }, (x) => fitKey(x.label)),
        note: fitText(trk.note) } : null,
      priorities: fitObjs(raw.priorities, (x) => { const title = fitText(x.title); return title ? { title, detail: fitText(x.detail) } : null; }, (x) => fitKey(x.title)),
      prioritiesNote: T('priorities_note'), mission: T('mission'),
      physique: fitPhysique(raw.physique),
    };
    m.months.sort((a, b) => (a.n || 99) - (b.n || 99));
    m.viands.sort((a, b) => a.di - b.di); m.training.sort((a, b) => a.di - b.di);
    const has = m.start.line || m.start.recommendation || m.targets.length || m.meals.length || m.viands.length || m.habits.length || m.training.length || m.months.length || m.milestones.length || (m.tracker && m.tracker.rows.length) || m.priorities.length || m.mission || m.physique;
    return has ? m : null;
  }
  function fitnessToday(m, iso) {
    if (!m || !isoOk(iso)) return null;
    const [y, mo, d] = iso.split('-').map(Number);
    const di = (new Date(Date.UTC(y, mo - 1, d)).getUTCDay() + 6) % 7;
    return { iso, di, day: FIT_DAYS[di], training: m.training.find((x) => x.di === di) || null, viand: (m.viands.find((x) => x.di === di) || {}).lunch || '' };
  }
  function fitnessCheck(raw) {
    const errors = [], warnings = [];
    if (raw == null) { warnings.push('no "fitness" section – the 💪 Fitness tab shows "Nothing here yet" (publish keeps the last published one; README → For Denx: keep "fitness")'); return { errors, warnings }; }
    if (!isObj(raw)) { errors.push('"fitness" must be an object (README → For Denx → Fitness tab)'); return { errors, warnings }; }
    const LISTS = ['targets', 'meals', 'viands', 'viand_alternatives', 'habits', 'training', 'training_rules', 'months', 'milestones', 'priorities'];
    for (const k of LISTS) if (raw[k] != null && !Array.isArray(raw[k])) errors.push(`fitness.${k} must be an array`);
    if (raw.start != null && !isObj(raw.start)) errors.push('fitness.start must be an object {line, recommendation}');
    if (raw.tracker != null && !isObj(raw.tracker)) errors.push('fitness.tracker must be an object {columns, rows:[{label, values}], note}');
    const objs = (k) => (Array.isArray(raw[k]) ? raw[k] : []);
    const ph = raw.physique;
    if (ph != null) {
      if (!isObj(ph)) errors.push('fitness.physique must be an object {targets, measurements[], emphasis[], notes[]}');
      else {
        for (const k of ['measurements', 'emphasis', 'notes']) if (ph[k] != null && !Array.isArray(ph[k])) errors.push(`fitness.physique.${k} must be an array`);
        if (ph.targets != null && !isObj(ph.targets)) errors.push('fitness.physique.targets must be an object {weight_kg, body_fat_pct, height_cm, vtaper_ratio}');
        if (Array.isArray(ph.measurements)) ph.measurements.forEach((x, i) => { if (!isObj(x)) return errors.push(`fitness.physique.measurements[${i}] must be an object {label, unit, current, target}`);
          for (const k of ['current', 'target']) if (x[k] != null && !['string', 'number'].includes(typeof x[k])) errors.push(`fitness.physique.measurements[${i}].${k} must be a number or text`); });
      }
    }
    const strsOf = (k) => (Array.isArray(raw[k]) ? raw[k] : []);
    const scan = (where, v) => { if (typeof v === 'string' && fitOffence(v)) warnings.push(`fitness.${where} looks like a tick-box / counter / alarm line – the site drops it (standing rules)`); if (typeof v === 'string' && longDigits(v)) warnings.push(`fitness.${where} has a long digit run – no account / ID numbers please`); };
    objs('targets').forEach((x, i) => { if (!isObj(x)) return errors.push(`fitness.targets[${i}] must be an object {label, value, unit, note}`); if (!str(x.label) || !str(x.value)) warnings.push(`fitness.targets[${i}] needs "label" and "value" – skipped otherwise`); });
    objs('meals').forEach((x, i) => { if (!isObj(x)) return errors.push(`fitness.meals[${i}] must be an object {name, items[]}`); if (!Array.isArray(x.items)) errors.push(`fitness.meals[${i}].items must be an array`); });
    for (const k of ['viands', 'training']) objs(k).forEach((x, i) => { if (!isObj(x)) return errors.push(`fitness.${k}[${i}] must be an object`); if (fitDayIdx(x.day) < 0) warnings.push(`fitness.${k}[${i}].day "${str(x.day)}" should be Mon…Sun – skipped otherwise`); });
    objs('training').forEach((x, i) => { if (isObj(x) && x.items != null && !Array.isArray(x.items)) errors.push(`fitness.training[${i}].items must be an array`); });
    objs('months').forEach((x, i) => { if (!isObj(x)) return errors.push(`fitness.months[${i}] must be an object {n, title, subtitle, items[], goal}`); if (x.items != null && !Array.isArray(x.items)) errors.push(`fitness.months[${i}].items must be an array`); });
    for (const k of ['milestones', 'priorities']) objs(k).forEach((x, i) => { if (!isObj(x)) errors.push(`fitness.${k}[${i}] must be an object`); });
    if (isObj(raw.tracker)) {
      const t = raw.tracker;
      if (!Array.isArray(t.columns) || !t.columns.length) errors.push('fitness.tracker.columns must be a non-empty array (e.g. ["Month 1","Month 2","Month 3"])');
      if (!Array.isArray(t.rows)) errors.push('fitness.tracker.rows must be an array of {label, values[]}');
      else t.rows.forEach((r, i) => {
        if (!isObj(r)) return errors.push(`fitness.tracker.rows[${i}] must be an object {label, values[]}`);
        if (!Array.isArray(r.values)) errors.push(`fitness.tracker.rows[${i}].values must be an array (null = not measured yet)`);
        else if (Array.isArray(t.columns) && r.values.length !== t.columns.length) errors.push(`fitness.tracker.rows[${i}].values has ${r.values.length} cell(s) but there are ${t.columns.length} column(s)`);
        else r.values.forEach((v, j) => { if (v != null && !['string', 'number'].includes(typeof v)) errors.push(`fitness.tracker.rows[${i}].values[${j}] must be a string, number or null`); else scan(`tracker.rows[${i}].values[${j}]`, v); });
      });
    }
    if (!errors.length) {
      if (isObj(ph)) {
        (ph.measurements || []).forEach((x, i) => { scan(`physique.measurements[${i}].label`, x.label); scan(`physique.measurements[${i}].current`, x.current); scan(`physique.measurements[${i}].target`, x.target); });
        for (const k of ['emphasis', 'notes']) (ph[k] || []).forEach((x, i) => scan(`physique.${k}[${i}]`, x));
        const pm = fitPhysique(ph);
        if (!pm) warnings.push('fitness.physique has no usable content – the Physique goals section is not shown');
        else {
          if (!pm.ratio || !pm.ratio.cur) warnings.push('fitness.physique has no numeric shoulders and waist (measurements with id "shoulders" and "waist", current as a number) – the current V-taper ratio is not shown');
          if (!pm.ratio || !pm.ratio.target) warnings.push('fitness.physique.targets.vtaper_ratio is missing – the target ratio is not shown');
          if (!pm.updated) warnings.push('fitness.physique.updated should be YYYY-MM-DD');
        }
      }
      for (const k of ['viand_alternatives', 'habits', 'training_rules']) strsOf(k).forEach((x, i) => { if (typeof x !== 'string') warnings.push(`fitness.${k}[${i}] should be a plain string`); else scan(`${k}[${i}]`, x); });
      for (const k of ['targets_note', 'diet_note', 'rice_note', 'viand_note', 'habits_note', 'training_intro', 'milestones_note', 'priorities_note', 'mission']) scan(k, raw[k]);
      objs('meals').forEach((x, i) => (x.items || []).forEach((v, j) => scan(`meals[${i}].items[${j}]`, v)));
      objs('training').forEach((x, i) => (x.items || []).forEach((v, j) => scan(`training[${i}].items[${j}]`, v)));
      objs('months').forEach((x, i) => (x.items || []).forEach((v, j) => scan(`months[${i}].items[${j}]`, v)));
      const m = fitnessModel(raw);
      if (!m) warnings.push('fitness has no usable content – the tab shows "Nothing here yet"');
      else {
        const miss = [['targets', m.targets.length], ['viands', m.viands.length], ['training', m.training.length], ['months', m.months.length], ['milestones', m.milestones.length], ['tracker', m.tracker && m.tracker.rows.length], ['habits', m.habits.length]].filter((x) => !x[1]).map((x) => x[0]);
        if (miss.length) warnings.push(`fitness is missing / empty: ${miss.join(', ')} (those sections are not shown)`);
        for (const k of ['viands', 'training']) if (m[k].length && m[k].length < 7) warnings.push(`fitness.${k} covers ${m[k].length} of 7 days – the "Today" card shows nothing on the others`);
        if (!m.updated) warnings.push('fitness.updated should be YYYY-MM-DD (the day Denx last refreshed the plan)');
      }
    }
    return { errors, warnings };
  }
  const view = (notes, todayISO, nowHM) => autoDone(dedupe(dropRemoved(stripAlarms(notes))), todayISO, nowHM);
  const isReminderText = (it) => REMINDER_TEXT_RE.test(entryText(it));
  const api = { fitnessModel, fitnessToday, fitnessCheck, FIT_DAYS, isReminderText, stripAlarms, dropRemoved, dedupe, autoDone, view, isAlarm, safeUrl, linkVal, txVal, leadVal, exVal, mpatVal, dailyVal, progVal, longDigits, isoOk, getProg, listOf, mergeSync, syncSig, hid, keyOf, hashKey, textOf, findIndex, isReflected, apply, describe, validEdit,
    SECS, TX_TYPES, TX_OUT, TX_IN, TX_ACCOUNTS, LEAD_STATUS, EX_TYPES, KIND: 'dn-edits-v1', OVERLAY_KIND: 'dn-overlay-v1' };
  root.EditsCore = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
