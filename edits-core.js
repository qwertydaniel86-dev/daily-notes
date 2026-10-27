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
  const PROGRESS_KEY = /^(wd1\.[a-z][a-z0-9_]{0,19}|finance\.savingsTotal)$/;
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
  const entryText = (it) => (typeof it === 'string' ? str(it) : isObj(it) ? pick(it, ...TEXT_KEYS) : '');
  const isAlarm = (it) => {
    if (isObj(it) && /^alarms?$/i.test(pick(it, 'type', 'kind', 'category'))) return true;
    return ALARM_START.test(entryText(it));
  };
  const SEC_DATE = { today: ['date'], schedule: ['date'], reminders: ['due', 'date'], todo: ['due', 'deadline'], todos: ['due', 'deadline'], taskings: ['deadline', 'due'], tasks: ['deadline', 'due'] };
  function stripAlarms(notes) {
    if (!isObj(notes)) return notes;
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
  const view = (notes, todayISO, nowHM) => autoDone(stripAlarms(notes), todayISO, nowHM);
  const api = { stripAlarms, autoDone, view, isAlarm, safeUrl, linkVal, txVal, leadVal, exVal, mpatVal, dailyVal, progVal, longDigits, isoOk, getProg, listOf, mergeSync, syncSig, hid, keyOf, hashKey, textOf, findIndex, isReflected, apply, describe, validEdit,
    SECS, TX_TYPES, TX_OUT, TX_IN, TX_ACCOUNTS, LEAD_STATUS, EX_TYPES, KIND: 'dn-edits-v1', OVERLAY_KIND: 'dn-overlay-v1' };
  root.EditsCore = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
