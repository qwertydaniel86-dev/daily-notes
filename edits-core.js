/* Daily Notes – edits core (shared by the browser overlay and tools/apply-edits.mjs). No data lives here.
   An edit: { eid, sec, op, key, label, val, at }
     sec: todo | taskings | bills | reminders | quick_notes | health.sleep | health.weight
     op : done (todo, val true/false) · status (taskings 'Open'|'In progress'|'Done'; bills 'paid') · add (val = new item, with id) · log (val {date, hours|kg})
     key: "id:<item.id>" when the item has an id, else "h:<hash of section|text>" (see keyOf).
   A sync state (Sheet blob / pull-edits): { dn_edits:1, device, exported, edits:[…], tomb:{eid: iso} } – see mergeSync. */
(function (root) {
  'use strict';
  const str = (v) => (v == null ? '' : typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
  const pick = (o, ...ks) => { if (o && typeof o === 'object') for (const k of ks) { const s = str(o[k]); if (s) return s; } return ''; };
  const norm = (s) => str(s).toLowerCase().replace(/\s+/g, ' ');
  function hid(s) { let x = 5381; for (let i = 0; i < s.length; i++) x = ((x << 5) + x + s.charCodeAt(i)) >>> 0; return x.toString(36); }
  const SECS = ['todo', 'taskings', 'bills', 'reminders', 'quick_notes', 'health.sleep', 'health.weight'];
  // Human text of an item, per section (what the hash is built from when there is no id).
  function textOf(sec, it) {
    if (typeof it === 'string') return it.trim();
    if (!it || typeof it !== 'object') return '';
    if (sec === 'bills') return [pick(it, 'name', 'title', 'item'), str(it.due ?? it.due_date ?? it.date)].filter(Boolean).join(' | ');
    if (sec === 'taskings') return pick(it, 'task', 'title', 'item');
    if (sec === 'quick_notes') return pick(it, 'text', 'note', 'item');
    return pick(it, 'item', 'task', 'text', 'title');
  }
  const hashKey = (sec, it) => 'h:' + hid(sec + '|' + norm(textOf(sec, it)));
  function keyOf(sec, it) { return it && typeof it === 'object' && str(it.id) ? 'id:' + str(it.id) : hashKey(sec, it); }
  const listOf = (notes, sec) => {
    if (sec.startsWith('health.')) { const hh = notes.health; const v = hh && typeof hh === 'object' ? hh[sec.slice(7)] : null; return Array.isArray(v) ? v : []; }
    const v = notes[sec === 'todo' && notes.todo == null ? 'todos' : sec];
    return Array.isArray(v) ? v : [];
  };
  // Find the item an edit points at: id/hash key first, then hash of its text (item gained an id later), then label text.
  function findIndex(notes, e) {
    const xs = listOf(notes, e.sec);
    let i = xs.findIndex((x) => keyOf(e.sec, x) === e.key);
    if (i < 0) i = xs.findIndex((x) => hashKey(e.sec, x) === e.key);
    if (i < 0 && e.label) i = xs.findIndex((x) => norm(textOf(e.sec, x)) === norm(e.labelText || e.label));
    return i;
  }
  const taskKey = (s) => { const t = norm(s); return /done|complete|closed/.test(t) ? 'done' : /progress|ongoing|wip|started/.test(t) ? 'prog' : 'open'; };
  // Does notes.json already show this edit's result?
  function isReflected(notes, e) {
    if (!notes || typeof notes !== 'object' || !e) return false;
    if (e.op === 'add') {
      const xs = listOf(notes, e.sec), v = e.val || {};
      return xs.some((x) => (x && typeof x === 'object' && v.id && str(x.id) === v.id) || (norm(textOf(e.sec, x)) && norm(textOf(e.sec, x)) === norm(textOf(e.sec, v))));
    }
    if (e.op === 'log') {
      const f = e.sec === 'health.sleep' ? 'hours' : 'kg', v = e.val || {};
      return listOf(notes, e.sec).some((x) => x && str(x.date).slice(0, 10) === v.date && Math.abs(+x[f] - +v[f]) < 0.01);
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
    const out = clone(notes && typeof notes === 'object' && !Array.isArray(notes) ? notes : {});
    const res = { applied: [], reflected: [], missing: [] };
    const ensure = (sec) => {
      if (sec.startsWith('health.')) { if (!out.health || typeof out.health !== 'object' || Array.isArray(out.health)) out.health = {}; const f = sec.slice(7); if (!Array.isArray(out.health[f])) out.health[f] = []; return out.health[f]; }
      const k = sec === 'todo' && out.todo == null && Array.isArray(out.todos) ? 'todos' : sec;
      if (!Array.isArray(out[k])) out[k] = out[k] == null ? [] : [out[k]];
      return out[k];
    };
    const ordered = [...(edits || [])].sort((a, b) => (a.op === 'add' ? 0 : 1) - (b.op === 'add' ? 0 : 1) || str(a.at).localeCompare(str(b.at)));
    for (const e of ordered) {
      if (!e || !SECS.includes(e.sec)) continue;
      if (isReflected(out, e)) { res.reflected.push(e); continue; }
      const xs = ensure(e.sec);
      if (e.op === 'add') { const v = clone(e.val || {}); if (mark) v._local = 'added'; xs.push(v); res.applied.push(e); continue; }
      if (e.op === 'log') {
        const v = clone(e.val || {}), j = xs.findIndex((x) => x && str(x.date).slice(0, 10) === v.date);
        if (mark) v._local = 'logged';
        if (j >= 0) xs[j] = Object.assign({}, xs[j], v); else xs.push(v);
        xs.sort((a, b) => str(a && a.date).localeCompare(str(b && b.date)));
        res.applied.push(e); continue;
      }
      const i = findIndex(out, e);
      if (i < 0) { res.missing.push(e); continue; }
      let it = xs[i];
      if (typeof it !== 'object' || it == null) it = xs[i] = e.sec === 'taskings' ? { task: str(it) } : { item: str(it) };
      if (e.op === 'done') it.done = !!e.val;
      else if (e.op === 'status') it.status = e.val;
      if (e.op === 'status' && e.sec === 'bills' && e.val === 'paid' && !it.paid_on) it.paid_on = str(e.at).slice(0, 10);
      if (e.op === 'done' && e.val && !it.done_on) it.done_on = str(e.at).slice(0, 10);
      if (e.op === 'status' && e.sec === 'taskings' && taskKey(e.val) === 'done' && !it.done_on) it.done_on = str(e.at).slice(0, 10);
      if (mark) it._local = 'edited';
      res.applied.push(e);
    }
    return { notes: out, ...res };
  }
  function describe(e) {
    const q = (s) => `“${str(s)}”`, v = e.val || {};
    switch (e.sec + ':' + e.op) {
      case 'todo:done': return `To-do ${e.val ? '✅ done' : '↩︎ not done'}: ${q(e.label)}`;
      case 'taskings:status': return `Tasking → ${e.val}: ${q(e.label)}`;
      case 'bills:status': return `Bill marked ${e.val}: ${q(e.label)}`;
      case 'todo:add': return `New to-do: ${q(v.item)}${v.due ? ` (due ${v.due})` : ''}`;
      case 'reminders:add': return `New reminder: ${q(v.item)}${v.due ? ` (due ${v.due})` : ''}`;
      case 'quick_notes:add': return `Quick note: ${q(v.text)}`;
      case 'health.sleep:log': return `Sleep logged: ${v.date} · ${v.hours} h`;
      case 'health.weight:log': return `Weight logged: ${v.date} · ${v.kg} kg`;
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
  // Canonical signature of a sync state (to see whether anything changed).
  function syncSig(x) {
    const es = (x && Array.isArray(x.edits) ? x.edits : []).map((e) => JSON.stringify([e.eid, e.at, e.val])).sort();
    const ts = Object.entries((x && x.tomb) || {}).map(([k, v]) => k + '@' + v).sort();
    return JSON.stringify([es, ts]);
  }
  function validEdit(e) { return !!(e && typeof e === 'object' && SECS.includes(e.sec) && ['done', 'status', 'add', 'log'].includes(e.op) && str(e.eid)); }
  const api = { mergeSync, syncSig, hid, keyOf, hashKey, textOf, findIndex, isReflected, apply, describe, validEdit, SECS, KIND: 'dn-edits-v1', OVERLAY_KIND: 'dn-overlay-v1' };
  root.EditsCore = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
