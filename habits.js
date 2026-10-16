/* Daily Notes – Blossom-style habit tracker.
   All habit data lives in localStorage key `dn.habits.v1` as an AES-256-GCM envelope encrypted with the SAME key that
   unlocks notes.enc.json (AAD-tagged "dn-habits-v1"). Nothing about habits is ever stored in plaintext.
   Optional habit definitions can come from notes.json `habits[]` (see README); they are merged in once, never overwrite edits. */
(function () {
  'use strict';
  const TZ = 'Asia/Manila';
  const LS = 'dn.habits.v1', LS_BAK = 'dn.habits.v1.bak', KIND = 'dn-habits-v1';
  const COLORS = ['sun', 'sky', 'mint', 'lav', 'peach', 'rose', 'lemon', 'aqua', 'lilac', 'coral', 'mist'];
  const HEX = { sun: '#e9b500', sky: '#3f8fdc', mint: '#26a862', lav: '#7a68ee', peach: '#ec8236', rose: '#e85584', lemon: '#b9a600', aqua: '#17aaa2', lilac: '#a957d9', coral: '#e8604f', mist: '#71879a' };
  const EMOJIS = ['📖', '🙏', '🏃', '📚', '✈️', '💧', '😴', '🧘', '💪', '🚶', '🥗', '📝', '🧠', '💊', '🦷', '☀️', '🌙', '📵', '🚭', '💰', '🧹', '🎸', '❤️', '⭐'];
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const SEEDS = [
    { id: 'seed-bible', name: 'Bible reading / devotion', emoji: '📖', color: 'sun', reminder: '05:30' },
    { id: 'seed-prayer', name: 'Prayer', emoji: '🙏', color: 'lav', type: 'count', target: 3, unit: 'times' },
    { id: 'seed-exercise', name: 'Exercise', emoji: '🏃', color: 'mint', type: 'timer', target: 30, unit: 'min', frequency: { times_per_week: 4 } },
    { id: 'seed-mmpa', name: 'Study MMPA', emoji: '📚', color: 'lemon', type: 'timer', target: 45, unit: 'min', frequency: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] },
    { id: 'seed-mpat', name: 'MPAT practice', emoji: '✈️', color: 'sky', type: 'count', target: 10, unit: 'times' },
    { id: 'seed-water', name: 'Water', emoji: '💧', color: 'aqua', type: 'count', target: 8, unit: 'glasses' },
    { id: 'seed-sleep', name: 'Sleep by 2300', emoji: '😴', color: 'lilac', reminder: '22:30' },
  ];

  /* ---------- helpers ---------- */
  function h(tag, attrs, ...kids) {
    const svg = tag.startsWith('svg:');
    const n = svg ? document.createElementNS('http://www.w3.org/2000/svg', tag.slice(4)) : document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') n.setAttribute('class', v);
      else if (k === 'vars') for (const [a, b] of Object.entries(v)) n.style.setProperty(a, b); // CSSOM – CSP-safe
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids.flat(Infinity)) {
      if (k == null || k === false || k === '') continue;
      n.append(k instanceof Node ? k : document.createTextNode(String(k)));
    }
    return n;
  }
  const str = (v) => (v == null ? '' : typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && isFinite(+v) ? +v : null);
  const clampInt = (v, lo, hi, dflt) => { const n = num(v); return n == null ? dflt : Math.max(lo, Math.min(hi, Math.round(n))); };
  const rid = () => 'h' + Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, '0')).join('');
  const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'habit';
  const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const nowHM = () => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
  const isoDate = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(str(s)); return m ? m[0] : null; };
  const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
  const dow = (iso) => new Date(iso + 'T00:00:00Z').getUTCDay();
  const weekStart = (iso) => addDays(iso, -((dow(iso) + 6) % 7)); // Monday
  const fmt = (iso, o) => new Date(iso + 'T12:00:00Z').toLocaleDateString('en-GB', Object.assign({ timeZone: 'UTC' }, o));
  const pctTxt = (x) => Math.round(x * 100) + '%';
  function hm(s) { const m = /^(\d{1,2}):?(\d{2})$/.exec(str(s)); if (!m || +m[1] > 23 || +m[2] > 59) return ''; return m[1].padStart(2, '0') + ':' + m[2]; }

  /* ---------- normalisation (tolerant: storage, imports and notes.json) ---------- */
  function normFreq(v) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const t = num(v.times_per_week ?? v.per_week ?? v.times);
      if (t != null && (v.type == null || /week/.test(v.type) || v.times_per_week != null || v.per_week != null)) return { type: 'weekly', times: clampInt(t, 1, 7, 3) };
      if (v.days != null) return normFreq(v.days);
      return { type: 'daily' };
    }
    if (Array.isArray(v)) {
      const days = [...new Set(v.map((d) => (typeof d === 'number' ? d % 7 : DOW.findIndex((n) => n.toLowerCase() === str(d).slice(0, 3).toLowerCase()))).filter((d) => d >= 0))].sort();
      return days.length && days.length < 7 ? { type: 'days', days } : { type: 'daily' };
    }
    const s = str(v).toLowerCase();
    let m;
    if ((m = /(\d)\s*(x|times)?\s*(\/|per|a)\s*w/.exec(s))) return { type: 'weekly', times: clampInt(m[1], 1, 7, 3) };
    if (s === 'weekdays') return { type: 'days', days: [1, 2, 3, 4, 5] };
    if (s === 'weekends') return { type: 'days', days: [0, 6] };
    if (/[a-z]{3}/.test(s) && s !== 'daily' && s !== 'everyday' && s !== 'every day') return normFreq(s.split(/[\s,/]+/));
    return { type: 'daily' };
  }
  function normHabit(x, idOverride) {
    if (typeof x === 'string') x = { name: x };
    if (!x || typeof x !== 'object') return null;
    const name = str(x.name ?? x.title ?? x.habit).slice(0, 60);
    if (!name) return null;
    const t = str(x.type).toLowerCase();
    const unit = str(x.unit).slice(0, 16);
    let type = /count|measure|number|qty/.test(t) ? 'count' : /tim|minute|duration/.test(t) ? 'timer' : 'check';
    if (!t && /^min/i.test(unit)) type = 'timer';
    const target = clampInt(x.target ?? x.goal, 1, 9999, type === 'timer' ? 30 : 1);
    if (type === 'check' && target > 1) type = 'count';
    return {
      id: idOverride || str(x.id) || rid(), name, emoji: [...str(x.emoji ?? x.icon)].slice(0, 2).join('') || '⭐',
      color: COLORS.includes(x.color) ? x.color : 'mint', type, target: type === 'check' ? 1 : target,
      unit: unit || (type === 'timer' ? 'min' : ''), freq: normFreq(x.freq ?? x.frequency ?? x.days ?? x.schedule),
      reminder: hm(x.reminder ?? x.remind ?? x.time), archived: !!x.archived, created: isoDate(x.created) || today(),
    };
  }
  function normState(x) {
    x = x && typeof x === 'object' ? x : {};
    const habits = (Array.isArray(x.habits) ? x.habits : []).map((y) => normHabit(y, y && y.id)).filter(Boolean);
    const log = {};
    if (x.log && typeof x.log === 'object') for (const [d, row] of Object.entries(x.log)) {
      if (!isoDate(d) || !row || typeof row !== 'object') continue;
      for (const [id, v] of Object.entries(row)) if (typeof v === 'number' && isFinite(v) && v !== 0) (log[d] = log[d] || {})[id] = v;
    }
    const st = x.settings && typeof x.settings === 'object' ? x.settings : {};
    return {
      v: 1, habits, log, known: x.known && typeof x.known === 'object' ? x.known : {},
      settings: { notify: !!st.notify, checkin: hm(st.checkin) || '', discreet: !!st.discreet },
      running: x.running && typeof x.running === 'object' ? x.running : {}, notified: x.notified && typeof x.notified === 'object' ? x.notified : {},
    };
  }
  function notesDefs(notes) {
    const raw = notes && notes.habits;
    const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : [];
    return list.map((x) => { const n = normHabit(x); if (!n) return null; n.id = 'notes-' + slug(str(x && x.id) || n.name); return n; }).filter(Boolean);
  }
  function freshState(notes) {
    const s = normState({});
    const fromNotes = notesDefs(notes);
    s.habits = fromNotes.length ? fromNotes : SEEDS.map((x) => normHabit(x, x.id));
    fromNotes.forEach((n) => (s.known[n.id] = 1));
    s.known._seeded = 1; s.known._mig_targets_v2 = today();
    return s;
  }
  function mergeNotes(notes) {
    let changed = false;
    for (const n of notesDefs(notes)) {
      if (S.known[n.id]) continue;
      S.known[n.id] = 1; changed = true;
      if (S.habits.some((x) => x.id === n.id || x.name.toLowerCase() === n.name.toLowerCase())) continue;
      S.habits.push(n);
    }
    return changed;
  }

  /* ---------- target history + one-time migration (v2: Prayer 3×/day, MPAT 10×/day) ----------
     S.known._hist = { <habitId>: [{until: 'YYYY-MM-DD', type, target, freq}, …] } (ascending): days BEFORE `until` are judged
     by that older rule, so changing a goal never rewrites past streaks. Kept inside `known` so older app versions keep it. */
  function recordHist(hb, until) {
    const H0 = (S.known._hist = S.known._hist && typeof S.known._hist === 'object' ? S.known._hist : {});
    const hs = (H0[hb.id] = Array.isArray(H0[hb.id]) ? H0[hb.id] : []);
    if (hs.some((r) => r && r.until === until)) return;
    hs.push({ until, type: hb.type, target: hb.target, freq: JSON.parse(JSON.stringify(hb.freq)) });
    hs.sort((a, b) => str(a.until).localeCompare(str(b.until)));
    RC = {};
  }
  function migrate() {
    if (!S || S.known._mig_targets_v2) return false;
    const t = today();
    const find = (id, re) => S.habits.find((x) => x.id === id) || S.habits.find((x) => re.test(x.name));
    const fix = (hb, target) => {
      if (!hb || (hb.type === 'count' && hb.target === target && hb.freq.type === 'daily')) return;
      recordHist(hb, t);
      hb.type = 'count'; hb.target = target; hb.unit = 'times'; hb.freq = { type: 'daily' };
    };
    fix(find('seed-prayer', /^prayer\b/i), 3);
    fix(find('seed-mpat', /\bmpat\b/i), 10);
    S.known._mig_targets_v2 = t; RC = {};
    return true;
  }
  let RC = {}; // parsed rule history cache
  function ruleOf(hb, d) {
    let hs = RC[hb.id];
    if (!hs) {
      const raw0 = S.known && S.known._hist && Array.isArray(S.known._hist[hb.id]) ? S.known._hist[hb.id] : [];
      hs = RC[hb.id] = raw0.filter((r) => r && isoDate(r.until)).map((r) => ({ until: isoDate(r.until), target: r.type === 'check' ? 1 : clampInt(r.target, 1, 9999, 1), freq: normFreq(r.freq) }));
    }
    for (const r of hs) if (d < r.until) return r;
    return hb;
  }
  // Extra minutes from the encrypted notes / phone edits (Health → exercise log) that count toward the Exercise habit.
  let EXT = {}, EXT_SIG = '';
  const exHabit = () => (S ? S.habits.find((x) => !x.archived && x.id === 'seed-exercise') || S.habits.find((x) => !x.archived && /^exercise\b/i.test(x.name)) || null : null);

  /* ---------- state + encrypted persistence ---------- */
  let lastNotes = {};
  let S = null, key = null, salt = null, iter = null, lockedBlob = null;
  let ui = { view: 'today', date: null, detail: null, month: null };
  let saving = Promise.resolve(), ticker = null, timerTick = null, lastDay = null;
  const root = h('article', { class: 'card wide c-rose habits', id: 'habits', 'aria-label': 'Habit tracker' });

  // Sync (sync.js): signature of what is worth syncing (not per-device reminder bookkeeping).
  let syncSig = '';
  const sigOf = (x) => JSON.stringify([x.habits, x.log, x.known, x.settings, x.running]);
  function save(quiet) {
    if (!key || !S) return saving;
    const sg = sigOf(S);
    if (sg !== syncSig) { syncSig = sg; if (!quiet && window.Sync) window.Sync.changed('habits'); }
    const snap = JSON.parse(JSON.stringify(S));
    const k = key, sa = salt, it = iter;
    saving = saving.then(async () => {
      const env = await NotesCrypto.encryptJSON(k, snap, sa, it, KIND);
      localStorage.setItem(LS, JSON.stringify(env));
    }).catch((e) => { console.warn('habit save failed', e); toast('⚠️ Could not save habits on this device'); });
    return saving;
  }

  async function unlock(k, env, notes) {
    lastNotes = notes && typeof notes === 'object' ? notes : {};
    if (S && key === k && salt === env.salt) { const a = mergeNotes(notes), b = migrate(); if (a || b) { save(); paint(); } return; }
    key = k; salt = env.salt; iter = env.iter; S = null; lockedBlob = null;
    let blob = null;
    try { blob = JSON.parse(localStorage.getItem(LS)); } catch { /* corrupt → treat as none */ }
    if (blob && blob.ct) {
      if (blob.salt === salt) { try { S = normState(await NotesCrypto.decryptJSON(k, blob, KIND)); } catch { lockedBlob = blob; } }
      else lockedBlob = blob;
    }
    if (lockedBlob) { paint(); return; } // never overwrite data we cannot read – offer recovery instead
    if (!S) { S = freshState(notes); syncSig = sigOf(S); save(true); } else { syncSig = sigOf(S); const a = mergeNotes(notes), b = migrate(); if (a || b) save(); }
    RC = {};
    ui.date = today(); lastDay = ui.date;
    start(); paint();
  }
  function lock() {
    S = null; key = null; lockedBlob = null; stop();
    ui = { view: 'today', date: null, detail: null, month: null };
    root.replaceChildren(); closeSheet();
  }

  /* ---------- scoring ---------- */
  const H = (id) => S.habits.find((x) => x.id === id);
  const raw = (id, d) => (S.log[d] && S.log[d][id]) || 0;
  const extOf = (hb, d) => (EXT[d] && hb === exHabit() ? EXT[d] : 0);
  const manual = (hb, d) => Math.max(0, raw(hb.id, d));
  const val = (hb, d) => manual(hb, d) + extOf(hb, d);
  const isSkip = (hb, d) => raw(hb.id, d) < 0;
  const tgt = (hb, d) => ruleOf(hb, d).target;
  const done = (hb, d) => val(hb, d) >= tgt(hb, d);
  const frac = (hb, d) => Math.min(1, val(hb, d) / tgt(hb, d));
  const fq = (hb, d) => ruleOf(hb, d).freq;
  const scheduled = (hb, d) => { const f = fq(hb, d); return f.type !== 'days' || f.days.includes(dow(d)); };
  // a day judged by an older "X per week" rule only counts when done (never breaks a daily streak)
  const legacyWeekly = (hb, d) => hb.freq.type !== 'weekly' && fq(hb, d).type === 'weekly';
  function weekDone(hb, d) { const ws = weekStart(d); let n = 0; for (let i = 0; i < 7; i++) if (done(hb, addDays(ws, i))) n++; return n; }
  // Is the habit part of day d's "to do" (ring / perfect day)? Weekly goals only become required when the week would
  // otherwise be missed – rest days never count against you (Blossom's "on track").
  function required(hb, d) {
    if (hb.archived || d < hb.created || isSkip(hb, d)) return false;
    const f = fq(hb, d);
    if (f.type !== 'weekly') return scheduled(hb, d);
    if (done(hb, d)) return true;
    const ws = weekStart(d); let before = 0;
    for (let i = 0; i < 7; i++) { const x = addDays(ws, i); if (x < d && done(hb, x)) before++; }
    const left = 7 - ((dow(d) + 6) % 7); // days remaining incl. d
    return f.times - before >= left;
  }
  function dayScore(d) {
    const hs = S.habits.filter((hb) => required(hb, d));
    if (!hs.length) return { n: 0, done: 0, pct: null };
    const f = hs.reduce((a, hb) => a + frac(hb, d), 0);
    return { n: hs.length, done: hs.filter((hb) => done(hb, d)).length, pct: f / hs.length };
  }
  function streaks(hb) {
    const t = today();
    let start = hb.created < addDays(t, -730) ? addDays(t, -730) : hb.created;
    let run = 0, best = 0;
    if (hb.freq.type === 'weekly') {
      for (let ws = weekStart(start); ws <= t; ws = addDays(ws, 7)) {
        const met = weekDone(hb, ws) >= hb.freq.times;
        if (met) { run++; best = Math.max(best, run); } else if (ws !== weekStart(t)) run = 0;
      }
      return { cur: run, best, unit: 'wk' };
    }
    for (let d = start; d <= t; d = addDays(d, 1)) {
      if (!scheduled(hb, d) || isSkip(hb, d)) continue;
      if (done(hb, d)) { run++; best = Math.max(best, run); } else if (d !== t && !legacyWeekly(hb, d)) run = 0;
    }
    return { cur: run, best, unit: 'd' };
  }
  function rate(hb, days) { // completion rate over the last N days (scheduled days / weeks only)
    const t = today(); let due = 0, ok = 0;
    if (hb.freq.type === 'weekly') {
      let need = 0, got = 0;
      for (let ws = weekStart(addDays(t, -days + 1)); ws <= t; ws = addDays(ws, 7)) {
        if (addDays(ws, 6) < hb.created) continue;
        need += hb.freq.times; got += Math.min(hb.freq.times, weekDone(hb, ws));
      }
      return need ? got / need : null;
    }
    for (let i = 0; i < days; i++) {
      const d = addDays(t, -i);
      if (d < hb.created || !scheduled(hb, d) || isSkip(hb, d)) continue;
      if ((d === t || legacyWeekly(hb, d)) && !done(hb, d)) continue;
      due++; if (done(hb, d)) ok++;
    }
    return due ? ok / due : null;
  }
  const PLANT = (n, unit) => { const x = unit === 'wk' ? n * 4 : n; return x < 1 ? '🌱' : x < 3 ? '🌿' : x < 7 ? '🌷' : x < 14 ? '🌸' : x < 30 ? '🌺' : '💐'; };
  const BLOOM = (p) => (p == null ? '🌿' : p <= 0 ? '🌱' : p < 0.34 ? '🌿' : p < 0.67 ? '🌷' : p < 1 ? '🌼' : '🌸');
  function freqLabel(hb) {
    if (hb.freq.type === 'weekly') return `${hb.freq.times}× / week`;
    if (hb.freq.type === 'days') { const d = hb.freq.days; return d.join() === '1,2,3,4,5' ? 'Weekdays' : d.map((x) => DOW[x]).join(' '); }
    return 'Daily';
  }
  const goalLabel = (hb) => (hb.type === 'check' ? '' : `${hb.target} ${hb.unit || (hb.type === 'timer' ? 'min' : '')}`.trim());

  /* ---------- mutations ---------- */
  function setVal(hb, d, v) {
    v = Math.max(-1, Math.min(99999, Math.round(v)));
    const row = (S.log[d] = S.log[d] || {});
    if (v === 0) delete row[hb.id]; else row[hb.id] = v;
    if (!Object.keys(row).length) delete S.log[d];
    if (v > 0 && d < hb.created) hb.created = d;
    save(); paint();
    if (v >= hb.target && d === today()) { const sc = dayScore(d); if (sc.pct === 1) celebrate(); }
  }
  function toggle(hb, d) { setVal(hb, d, done(hb, d) ? 0 : Math.max(1, tgt(hb, d) - extOf(hb, d))); }
  const step = (hb) => (hb.type === 'timer' ? 5 : 1);
  function timerToggle(hb) {
    const r = S.running[hb.id];
    if (r) {
      delete S.running[hb.id];
      const mins = Math.max(1, Math.round((Date.now() - r.start) / 60000));
      setVal(hb, r.date || today(), manual(hb, r.date || today()) + mins);
      toast(`⏱️ +${mins} min ${hb.name}`);
    } else { S.running[hb.id] = { start: Date.now(), date: ui.date || today() }; save(); paint(); }
  }

  /* ---------- small UI pieces ---------- */
  function ring(p, size, sw, center, cls) {
    const r = (size - sw) / 2, c = 2 * Math.PI * r, f = Math.max(0, Math.min(1, p || 0));
    return h('span', { class: 'ring ' + (cls || ''), 'aria-hidden': 'true' },
      h('svg:svg', { viewBox: `0 0 ${size} ${size}`, width: size, height: size },
        h('svg:circle', { class: 'ring-bg', cx: size / 2, cy: size / 2, r, 'stroke-width': sw, fill: 'none' }),
        h('svg:circle', { class: 'ring-fg' + (f >= 1 ? ' full' : '') + (f <= 0 ? ' zero' : ''), cx: size / 2, cy: size / 2, r, 'stroke-width': sw, fill: 'none', 'stroke-linecap': 'round', 'stroke-dasharray': `${(c * f).toFixed(2)} ${c.toFixed(2)}`, transform: `rotate(-90 ${size / 2} ${size / 2})` })),
      center != null ? h('span', { class: 'ring-c' }, center) : null);
  }
  const btn = (label, onclick, cls, extra) => h('button', Object.assign({ type: 'button', class: cls || 'ghost', onclick }, extra || {}), label);
  let toastT = null;
  function toast(msg) {
    let t = document.getElementById('hb-toast');
    if (!t) { t = h('div', { id: 'hb-toast', class: 'hb-toast', role: 'status', 'aria-live': 'polite' }); document.body.append(t); }
    t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2600);
  }
  function celebrate() {
    toast('🌸 Perfect day — everything done! Your garden grew a blossom.');
    root.classList.remove('bloom'); void root.offsetWidth; root.classList.add('bloom');
  }

  /* ---------- views ---------- */
  function paint() {
    RC = {};
    const fk = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.fk : null;
    if (!key) { root.replaceChildren(); return; }
    if (lockedBlob) { root.replaceChildren(header(), recoverView()); return; }
    if (!S) return;
    const v = ui.view === 'stats' ? statsView() : ui.view === 'manage' ? manageView() : ui.view === 'detail' && H(ui.detail) ? detailView(H(ui.detail)) : todayView();
    root.replaceChildren(header(), v);
    if (fk) { const el = root.querySelector(`[data-fk="${CSS.escape(fk)}"]`); if (el) el.focus({ preventScroll: true }); }
  }
  function header() {
    const tab = (id, label) => h('button', { type: 'button', role: 'tab', class: 'tab' + (ui.view === id || (id === 'stats' && ui.view === 'detail') ? ' on' : ''), 'aria-selected': String(ui.view === id), 'data-fk': 'tab-' + id, onclick: () => { ui.view = id; paint(); } }, label);
    return h('div', { class: 'hb-head' },
      h('div', { class: 'hb-title' }, h('h2', null, h('span', { class: 'ico', 'aria-hidden': 'true' }, '🌸'), 'Habits'),
        lockedBlob ? null : btn('＋ New', () => openForm(null), 'add-btn', { title: 'Add habit', 'aria-label': 'Add habit', 'data-fk': 'add' })),
      lockedBlob ? null : h('div', { class: 'tabs', role: 'tablist' }, tab('today', '🌷 Today'), tab('stats', '📊 Stats'), tab('manage', '⚙️ Manage')));
  }

  function todayView() {
    const t = today(), d = ui.date && ui.date <= t ? ui.date : t;
    const sc = dayScore(d);
    const isToday = d === t;
    // week strip
    const ws = weekStart(d);
    const strip = h('div', { class: 'week' },
      btn('‹', () => { ui.date = addDays(ws, -1); paint(); }, 'wk-nav', { 'aria-label': 'Previous week', 'data-fk': 'wprev' }),
      Array.from({ length: 7 }, (_, i) => {
        const x = addDays(ws, i), s = x <= t ? dayScore(x) : null, fut = x > t;
        return h('button', { type: 'button', class: 'wd' + (x === d ? ' sel' : '') + (x === t ? ' now' : '') + (s && s.pct === 1 ? ' perfect' : ''), disabled: fut || null, 'data-fk': 'wd' + i,
          'aria-label': fmt(x, { weekday: 'long', day: 'numeric', month: 'short' }) + (s && s.pct != null ? ` – ${pctTxt(s.pct)}` : ''), onclick: () => { ui.date = x; paint(); } },
          h('span', { class: 'wd-n' }, DOW[dow(x)][0]), ring(s ? s.pct : 0, 34, 4, s && s.pct === 1 ? '🌸' : fmt(x, { day: 'numeric' }), 'mini'));
      }),
      btn('›', () => { ui.date = addDays(ws, 7) > t ? t : addDays(ws, 7); paint(); }, 'wk-nav', { 'aria-label': 'Next week', disabled: addDays(ws, 7) > t || null, 'data-fk': 'wnext' }));
    const summary = h('div', { class: 'hb-sum' },
      ring(sc.pct, 92, 9, h('span', { class: 'bloom-ico' }, BLOOM(sc.pct)), 'big'),
      h('div', null,
        h('p', { class: 'hb-day' }, isToday ? 'Today' : fmt(d, { weekday: 'long' }), h('span', { class: 'muted small' }, ' · ', fmt(d, { day: 'numeric', month: 'short' }))),
        h('p', { class: 'hb-pct' }, sc.pct == null ? 'Nothing due' : pctTxt(sc.pct)),
        h('p', { class: 'muted small' }, sc.n ? `${sc.done} of ${sc.n} done` + (sc.pct === 1 ? ' · perfect day 🌸' : '') : 'Rest day — enjoy it 🌿'),
        !isToday ? btn('↩ Back to today', () => { ui.date = t; paint(); }, 'ghost tiny', { 'data-fk': 'back' }) : null));
    const act = S.habits.filter((hb) => !hb.archived);
    if (!act.length) return h('div', null, summary, h('p', { class: 'empty' }, 'No habits yet — tap ＋ to plant one. 🌱'));
    const rows = act.map((hb, i) => ({ hb, i, req: required(hb, d) || done(hb, d), dn: done(hb, d) }));
    // Blossom-style ordering: to-do first, done at the bottom, rest-day items last
    const rank = (r) => (!r.req && !r.dn ? 3 : r.dn ? 2 : 0);
    rows.sort((a, b) => rank(a) - rank(b) || a.i - b.i);
    return h('div', null, summary, strip, h('ul', { class: 'hb-list' }, rows.map((r) => habitRow(r.hb, d, r.req))));
  }

  function habitRow(hb, d, req) {
    const st = streaks(hb), dn = done(hb, d), sk = isSkip(hb, d), v = val(hb, d), mv = manual(hb, d), t = today(), isEx = hb === exHabit();
    const run = S.running[hb.id];
    const ws = weekStart(d);
    const dots = h('span', { class: 'dots', 'aria-hidden': 'true' }, Array.from({ length: 7 }, (_, i) => {
      const x = addDays(ws, i);
      return h('i', { class: (done(hb, x) ? 'on' : val(hb, x) > 0 ? 'part' : isSkip(hb, x) ? 'skip' : '') + (x === d ? ' cur' : '') + (scheduled(hb, x) ? '' : ' off') });
    }));
    const meta = [];
    if (hb.freq.type === 'weekly') meta.push(`${weekDone(hb, d)}/${hb.freq.times} this week` + (!req && !dn ? (weekDone(hb, d) >= hb.freq.times ? ' ✓' : ' · on track') : ''));
    else if (!scheduled(hb, d)) meta.push('Rest day');
    if (hb.type !== 'check') meta.push(goalLabel(hb));
    if (isEx) { let wm = 0; for (let i = 0; i < 7; i++) wm += val(hb, addDays(ws, i)); meta.push(`${wm} min this wk`); }
    if (sk) meta.push('Skipped ⏭');
    let ctl;
    if (hb.type === 'check') {
      ctl = h('button', { type: 'button', class: 'chk' + (dn ? ' on' : ''), 'aria-pressed': String(dn), 'aria-label': (dn ? 'Undo ' : 'Check off ') + hb.name, 'data-fk': 'c-' + hb.id, onclick: () => toggle(hb, d) }, dn ? '✓' : '');
    } else {
      const shown = run ? v + Math.floor((Date.now() - run.start) / 60000) : v;
      ctl = h('span', { class: 'stepper' },
        btn('−', () => setVal(hb, d, Math.max(0, mv - step(hb))), 'st-btn', { 'aria-label': `Less ${hb.name}`, disabled: mv <= 0 || null, 'data-fk': 'm-' + hb.id }),
        h('button', { type: 'button', class: 'st-val' + (dn ? ' on' : ''), 'aria-label': `${hb.name}: ${v} of ${hb.target} ${hb.unit}. Tap to add ${step(hb)}`, 'data-fk': 'v-' + hb.id, onclick: () => setVal(hb, d, mv + step(hb)) },
          ring(Math.min(1, shown / hb.target), 40, 4, hb.type === 'count' && hb.target > 1 ? `${shown}/${hb.target}` : dn ? '✓' : String(shown), 'tiny' + (hb.type === 'count' && hb.target > 1 ? ' frac' : '')), null),
        btn('+', () => setVal(hb, d, mv + step(hb)), 'st-btn', { 'aria-label': `More ${hb.name}`, 'data-fk': 'p-' + hb.id }),
        hb.type === 'timer' && d === t ? btn(run ? '⏸' : '▶', () => timerToggle(hb), 'st-btn play' + (run ? ' live' : ''), { 'aria-label': (run ? 'Stop timer for ' : 'Start timer for ') + hb.name, 'data-fk': 't-' + hb.id }) : null);
    }
    if (isEx && window.Features && window.Features.openExerciseLog) ctl = h('span', { class: 'hb-ctls' }, btn('📝', () => window.Features.openExerciseLog(d), 'st-btn ex-log', { 'aria-label': 'Log an exercise session (type + minutes)', title: 'Log a session (Gym, Run, Walk…)', 'data-fk': 'x-' + hb.id }), ctl);
    return h('li', { class: `hb-row c-${hb.color}` + (dn ? ' done' : '') + (!req && !dn ? ' rest' : ''), vars: { '--hc': HEX[hb.color] } },
      h('button', { type: 'button', class: 'hb-emoji', 'aria-label': `${hb.name} details`, 'data-fk': 'e-' + hb.id, onclick: () => { ui.view = 'detail'; ui.detail = hb.id; ui.month = null; paint(); } }, hb.emoji),
      h('div', { class: 'hb-main' },
        h('button', { type: 'button', class: 'hb-name', onclick: () => { ui.view = 'detail'; ui.detail = hb.id; ui.month = null; paint(); } }, hb.name),
        h('div', { class: 'hb-meta' },
          h('span', { class: 'streak' + (st.cur ? ' hot' : ''), title: `Current streak ${st.cur}, best ${st.best}` }, st.cur ? '🔥' : '·', ' ', String(st.cur), st.unit === 'wk' ? 'wk' : 'd'),
          h('span', { class: 'plant', title: 'Grows with your streak' }, PLANT(st.cur, st.unit)),
          meta.length ? h('span', { class: 'muted' }, meta.join(' · ')) : null),
        dots),
      ctl);
  }

  function heatLevel(p) { return p == null ? 'n' : p <= 0 ? 'l0' : p < 0.34 ? 'l1' : p < 0.67 ? 'l2' : p < 1 ? 'l3' : 'l4'; }

  function statsView() {
    const t = today();
    const scores = Array.from({ length: 126 }, (_, i) => { const d = addDays(t, -i); return [d, dayScore(d)]; });
    const avg = (n) => { const xs = scores.slice(0, n).map(([, s]) => s.pct).filter((p) => p != null); return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; };
    const perfect30 = scores.slice(0, 30).filter(([, s]) => s.pct === 1).length;
    let pRun = 0, pBest = 0, cur = 0;
    for (let i = scores.length - 1; i >= 0; i--) { const [d, s] = scores[i]; if (s.pct === 1) { cur++; pBest = Math.max(pBest, cur); } else if (s.pct != null && d !== t) cur = 0; }
    pRun = cur;
    const chip = (ico, label, v) => h('div', { class: 'stat' }, h('span', { class: 'stat-v' }, v), h('span', { class: 'stat-l' }, ico, ' ', label));
    // garden: one plant per day for the last 28 days
    const garden = h('div', { class: 'garden', 'aria-label': `Garden: ${perfect30} perfect days in the last 30` }, scores.slice(0, 28).reverse().map(([d, s]) =>
      h('span', { class: 'plot ' + heatLevel(s.pct), title: `${fmt(d, { weekday: 'short', day: 'numeric', month: 'short' })}: ${s.pct == null ? 'nothing due' : pctTxt(s.pct)}` }, s.pct === 1 ? '🌸' : s.pct >= 0.67 ? '🌷' : s.pct >= 0.34 ? '🌿' : s.pct > 0 ? '🌱' : '')));
    // 18-week heatmap (Mon-first rows)
    const endW = weekStart(t), startW = addDays(endW, -17 * 7);
    const cols = [];
    for (let w = startW; w <= endW; w = addDays(w, 7)) cols.push(h('div', { class: 'hm-col' }, Array.from({ length: 7 }, (_, i) => { const d = addDays(w, i); const s = d <= t ? dayScore(d) : null; return h('i', { class: 'hm ' + (s ? heatLevel(s.pct) : 'fut'), title: d <= t ? `${d}: ${s.pct == null ? '—' : pctTxt(s.pct)}` : '' }); })));
    const heat = h('div', { class: 'hm-wrap' }, h('div', { class: 'hm-days', 'aria-hidden': 'true' }, ['M', '', 'W', '', 'F', '', ''].map((x) => h('span', null, x))), h('div', { class: 'hm-grid', role: 'img', 'aria-label': 'Overall completion, last 18 weeks' }, cols));
    const act = S.habits.filter((x) => !x.archived);
    const table = h('ul', { class: 'hb-stats' }, act.map((hb) => {
      const st = streaks(hb), r = rate(hb, 30);
      return h('li', { vars: { '--hc': HEX[hb.color] } },
        h('button', { type: 'button', class: 'hs-btn', 'data-fk': 's-' + hb.id, onclick: () => { ui.view = 'detail'; ui.detail = hb.id; ui.month = null; paint(); } },
          h('span', { class: `hs-emoji c-${hb.color}` }, hb.emoji),
          h('span', { class: 'hs-name' }, hb.name, h('span', { class: 'muted small' }, ` · ${freqLabel(hb)}`)),
          h('span', { class: 'hs-nums' }, h('span', null, '🔥 ', st.cur, st.unit), h('span', { class: 'muted' }, '🏆 ', st.best, st.unit)),
          h('span', { class: 'hs-bar', 'aria-hidden': 'true' }, h('span', { vars: { '--w': pctTxt(r || 0) } })),
          h('em', { class: 'hs-pct', title: '30-day completion rate' }, r == null ? '—' : pctTxt(r) + ' 30d')));
    }));
    return h('div', { class: 'stats' },
      h('div', { class: 'stat-grid' }, chip('📅', 'Today', avg(1) == null ? '—' : pctTxt(avg(1))), chip('7️⃣', '7-day avg', avg(7) == null ? '—' : pctTxt(avg(7))),
        chip('🗓️', '30-day avg', avg(30) == null ? '—' : pctTxt(avg(30))), chip('🌸', 'Perfect days (30d)', perfect30),
        chip('🔥', 'Perfect-day streak', pRun), chip('🏆', 'Best perfect streak', pBest)),
      h('h3', null, '🌷 Your garden · last 4 weeks'), garden,
      h('h3', null, '🟩 Consistency · 18 weeks'), heat,
      h('p', { class: 'legend muted small' }, 'Less ', ['l0', 'l1', 'l2', 'l3', 'l4'].map((l) => h('i', { class: 'hm ' + l })), ' More'),
      h('h3', null, '📊 Per habit · tap for calendar'), table);
  }

  function detailView(hb) {
    const t = today(), st = streaks(hb);
    const m = ui.month || t.slice(0, 7);
    const first = m + '-01', gridStart = weekStart(first);
    const nextM = addDays(first, 32).slice(0, 7), prevM = addDays(first, -1).slice(0, 7);
    const cells = [];
    for (let d = gridStart; d.slice(0, 7) <= m || (cells.length % 7); d = addDays(d, 1)) {
      const inM = d.slice(0, 7) === m, fut = d > t;
      const p = frac(hb, d), sk = isSkip(hb, d);
      cells.push(h('button', { type: 'button', class: 'cal ' + (inM ? '' : 'out ') + (fut ? 'fut ' : '') + (sk ? 'skip ' : '') + (scheduled(hb, d) ? '' : 'rest ') + (d === t ? 'now ' : '') + (p >= 1 ? 'l4' : p > 0 ? 'l2' : 'l0'),
        disabled: fut || !inM || null, 'aria-label': `${fmt(d, { day: 'numeric', month: 'short' })}: ${sk ? 'skipped' : p >= 1 ? 'done' : val(hb, d) ? val(hb, d) + ' ' + hb.unit : 'not done'}`, 'data-fk': 'cal' + d,
        onclick: () => toggle(hb, d) }, sk ? '⏭' : fmt(d, { day: 'numeric' })));
      if (cells.length > 42) break;
    }
    const r30 = rate(hb, 30), r90 = rate(hb, 90);
    const total = Object.keys(S.log).filter((d) => done(hb, d)).length;
    return h('div', { class: 'detail', vars: { '--hc': HEX[hb.color] } },
      btn('‹ Back', () => { ui.view = 'stats'; paint(); }, 'ghost tiny', { 'data-fk': 'dback' }),
      h('div', { class: `det-head c-${hb.color}` }, h('span', { class: 'det-emoji' }, hb.emoji),
        h('div', null, h('p', { class: 'det-name' }, hb.name), h('p', { class: 'muted small' }, [freqLabel(hb), goalLabel(hb), hb.reminder ? '⏰ ' + hb.reminder : ''].filter(Boolean).join(' · '))),
        h('span', { class: 'det-plant', title: 'Blossoms as your streak grows' }, PLANT(st.cur, st.unit))),
      h('div', { class: 'stat-grid' },
        h('div', { class: 'stat' }, h('span', { class: 'stat-v' }, `🔥 ${st.cur}${st.unit}`), h('span', { class: 'stat-l' }, 'Current streak')),
        h('div', { class: 'stat' }, h('span', { class: 'stat-v' }, `🏆 ${st.best}${st.unit}`), h('span', { class: 'stat-l' }, 'Best streak')),
        h('div', { class: 'stat' }, h('span', { class: 'stat-v' }, r30 == null ? '—' : pctTxt(r30)), h('span', { class: 'stat-l' }, '30-day rate')),
        h('div', { class: 'stat' }, h('span', { class: 'stat-v' }, r90 == null ? '—' : pctTxt(r90)), h('span', { class: 'stat-l' }, '90-day rate')),
        h('div', { class: 'stat' }, h('span', { class: 'stat-v' }, total), h('span', { class: 'stat-l' }, 'Days completed'))),
      h('div', { class: 'cal-head' }, btn('‹', () => { ui.month = prevM; paint(); }, 'wk-nav', { 'aria-label': 'Previous month', 'data-fk': 'mprev' }),
        h('strong', null, fmt(first, { month: 'long', year: 'numeric' })),
        btn('›', () => { ui.month = nextM; paint(); }, 'wk-nav', { 'aria-label': 'Next month', disabled: nextM > t.slice(0, 7) || null, 'data-fk': 'mnext' })),
      h('div', { class: 'cal-grid' }, ['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((x) => h('span', { class: 'cal-dow' }, x)), cells),
      h('p', { class: 'muted small' }, 'Tap a past day to fix it. Skipped days (⏭) keep your streak alive.'),
      h('div', { class: 'row-btns' },
        isSkip(hb, t) ? btn('↺ Un-skip today', () => setVal(hb, t, 0), 'ghost', { 'data-fk': 'skip' }) : btn('⏭ Skip today', () => { setVal(hb, t, -1); toast('Skipped today — streak preserved 🌿'); }, 'ghost', { 'data-fk': 'skip' }),
        btn('✏️ Edit', () => openForm(hb), 'ghost', { 'data-fk': 'edit' }),
        btn(hb.archived ? '📤 Restore' : '🗄️ Archive', () => { hb.archived = !hb.archived; save(); toast(hb.archived ? 'Archived — history kept' : 'Restored'); ui.view = hb.archived ? 'manage' : 'detail'; paint(); }, 'ghost', { 'data-fk': 'arch' })));
  }

  function manageView() {
    const move = (i, dir) => { const j = i + dir; if (j < 0 || j >= S.habits.length) return; [S.habits[i], S.habits[j]] = [S.habits[j], S.habits[i]]; save(); paint(); };
    const list = h('ul', { class: 'mg-list' }, S.habits.map((hb, i) => h('li', { class: hb.archived ? 'archived' : '' },
      h('span', { class: `hs-emoji c-${hb.color}` }, hb.emoji),
      h('span', { class: 'mg-name' }, hb.name, h('span', { class: 'muted small' }, ` · ${freqLabel(hb)}${hb.type !== 'check' ? ' · ' + goalLabel(hb) : ''}${hb.archived ? ' · archived' : ''}`)),
      h('span', { class: 'mg-btns' },
        btn('↑', () => move(i, -1), 'icon', { 'aria-label': `Move ${hb.name} up`, disabled: i === 0 || null, 'data-fk': 'up' + hb.id }),
        btn('↓', () => move(i, 1), 'icon', { 'aria-label': `Move ${hb.name} down`, disabled: i === S.habits.length - 1 || null, 'data-fk': 'dn' + hb.id }),
        btn('✏️', () => openForm(hb), 'icon', { 'aria-label': `Edit ${hb.name}`, 'data-fk': 'ed' + hb.id }),
        btn(hb.archived ? '📤' : '🗄️', () => { hb.archived = !hb.archived; save(); paint(); }, 'icon', { 'aria-label': (hb.archived ? 'Restore ' : 'Archive ') + hb.name, 'data-fk': 'ar' + hb.id })))));
    const perm = typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
    const notif = h('div', { class: 'mg-sec' },
      h('h3', null, '⏰ Reminders'),
      h('p', { class: 'muted small' }, 'Browser notifications fire at each habit’s reminder time (set it in Edit) — only while this page is open in a tab (it can be in the background). Not a push service: a closed tab or a sleeping phone gets nothing.'),
      perm === 'unsupported' ? h('p', { class: 'empty' }, 'Notifications are not supported in this browser (on iPhone: add to Home Screen first).')
        : h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: (S.settings.notify && perm === 'granted') || null, 'data-fk': 'notif', onchange: async (e) => {
          if (e.target.checked) {
            const p = perm === 'granted' ? 'granted' : await Notification.requestPermission();
            S.settings.notify = p === 'granted';
            if (p !== 'granted') toast('Notifications blocked — allow them in browser site settings');
          } else S.settings.notify = false;
          save(); paint();
        } }), ' Enable reminder notifications', perm === 'denied' ? h('span', { class: 'chip due-over' }, 'blocked') : null),
      h('label', { class: 'field inline' }, 'Evening check-in nudge (any habit left) ', h('input', { type: 'time', value: S.settings.checkin || '', 'data-fk': 'checkin', onchange: (e) => { S.settings.checkin = hm(e.target.value); save(); } })),
      h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: S.settings.discreet || null, onchange: (e) => { S.settings.discreet = e.target.checked; save(); } }), ' Discreet notifications (hide habit names on the lock screen)'),
      perm === 'granted' ? btn('🔔 Test notification', () => notify('🌸 Daily Notes', 'Reminders are working.', 'test'), 'ghost tiny') : null);
    const fileIn = h('input', { type: 'file', accept: '.json,application/json', class: 'sr', id: 'hb-import', onchange: (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importFile(f); } });
    const data = h('div', { class: 'mg-sec' },
      h('h3', null, '🔐 Data & backup'),
      h('p', { class: 'muted small' }, 'Habits are saved only in this browser, encrypted with your notes key. Export an encrypted backup to move to another device; importing merges it in. A backup opens with the passphrase that was current when you exported it.'),
      h('div', { class: 'row-btns' }, btn('⬇️ Export (encrypted)', exportFile, 'ghost', { 'data-fk': 'exp' }), h('label', { class: 'ghost btnlike', for: 'hb-import', tabindex: '0', onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileIn.click(); } } }, '⬆️ Import'), fileIn),
      localStorage.getItem(LS_BAK) ? h('p', { class: 'small' }, '🗃️ An older encrypted habit backup exists on this device. ', btn('Recover it', () => { try { lockedBlob = JSON.parse(localStorage.getItem(LS_BAK)); lockedBlob._bak = 1; paint(); } catch { toast('Backup unreadable'); } }, 'ghost tiny')) : null);
    return h('div', { class: 'manage' }, h('p', { class: 'muted small' }, 'Reorder with ↑ ↓ · archive keeps history · tap ＋ to add.'), list, notif, data);
  }

  function recoverView() {
    const inp = h('input', { type: 'password', placeholder: 'Previous passphrase', autocomplete: 'off', 'aria-label': 'Previous passphrase' });
    const msg = h('p', { class: 'gate-msg', role: 'alert' });
    const go = async () => {
      if (!inp.value) return; msg.textContent = 'Unlocking…';
      try {
        const k = await NotesCrypto.deriveKey(inp.value, lockedBlob, false);
        const data = normState(await NotesCrypto.decryptJSON(k, lockedBlob, KIND));
        const wasBak = lockedBlob._bak; lockedBlob = null;
        if (S && wasBak) mergeState(data); else S = data;
        migrate(); RC = {};
        if (wasBak) localStorage.removeItem(LS_BAK);
        await save(); ui.date = today(); start(); toast('🌸 Habit history recovered'); paint();
      } catch { msg.textContent = 'That passphrase did not open the habit data.'; }
    };
    return h('div', { class: 'recover' },
      h('p', null, '🔐 ', lockedBlob._bak ? 'Recover the older habit backup.' : 'Your saved habit history was encrypted with a previous passphrase (the notes passphrase changed).'),
      h('p', { class: 'muted small' }, 'Enter the old passphrase to re-encrypt it with the current one. Nothing is overwritten until you choose.'),
      h('form', { class: 'row-btns', onsubmit: (e) => { e.preventDefault(); go(); } }, inp, h('button', { type: 'submit' }, 'Recover')), msg,
      btn(lockedBlob._bak ? 'Cancel' : 'Start fresh (keep old data as backup)', () => {
        if (!lockedBlob._bak) { localStorage.setItem(LS_BAK, JSON.stringify(lockedBlob)); localStorage.removeItem(LS); S = freshState(lastNotes); save(); }
        lockedBlob = null; ui.date = today(); start(); paint();
      }, 'ghost tiny'));
  }

  /* ---------- add / edit sheet ---------- */
  let sheetEl = null, lastFocus = null;
  function closeSheet() { if (sheetEl) { sheetEl.remove(); sheetEl = null; document.body.classList.remove('sheet-open'); if (lastFocus && lastFocus.focus) lastFocus.focus(); } }
  function openSheet(title, body) {
    closeSheet(); lastFocus = document.activeElement;
    sheetEl = h('div', { class: 'sheet-bg', onclick: (e) => { if (e.target === sheetEl) closeSheet(); } },
      h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, h('div', { class: 'sheet-grab', 'aria-hidden': 'true' }), body));
    sheetEl.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });
    document.body.append(sheetEl); document.body.classList.add('sheet-open');
    const f = sheetEl.querySelector('input,button'); if (f) f.focus();
  }
  function openForm(hb) {
    const isNew = !hb;
    const f = hb ? JSON.parse(JSON.stringify(hb)) : { name: '', emoji: '⭐', color: COLORS[S.habits.length % COLORS.length], type: 'check', target: 1, unit: '', freq: { type: 'daily' }, reminder: '' };
    const preview = h('span', { class: `form-prev c-${f.color}` }, f.emoji);
    const name = h('input', { id: 'hf-name', required: true, maxlength: 60, value: f.name, placeholder: 'e.g. Read 10 pages', autocomplete: 'off' });
    const emoji = h('input', { id: 'hf-emoji', class: 'emoji-in', maxlength: 8, value: f.emoji, 'aria-label': 'Emoji (type any)', oninput: () => { f.emoji = [...emoji.value.trim()].slice(0, 2).join('') || '⭐'; preview.textContent = f.emoji; } });
    const emojiGrid = h('div', { class: 'emoji-grid' }, EMOJIS.map((e) => h('button', { type: 'button', class: 'em' + (e === f.emoji ? ' on' : ''), 'aria-label': 'Use ' + e, onclick: (ev) => { f.emoji = e; emoji.value = e; preview.textContent = e; emojiGrid.querySelectorAll('.em').forEach((b) => b.classList.toggle('on', b === ev.currentTarget)); } }, e)));
    const colors = h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': 'Colour' }, COLORS.map((c) => h('button', { type: 'button', role: 'radio', 'aria-checked': String(c === f.color), 'aria-label': c, class: `sw c-${c}` + (c === f.color ? ' on' : ''), vars: { '--hc': HEX[c] },
      onclick: (ev) => { f.color = c; preview.className = `form-prev c-${c}`; colors.querySelectorAll('.sw').forEach((b) => { b.classList.toggle('on', b === ev.currentTarget); b.setAttribute('aria-checked', String(b === ev.currentTarget)); }); } })));
    const seg = (opts, cur, onpick) => { const g = h('div', { class: 'seg', role: 'radiogroup' }); opts.forEach(([v, l]) => g.append(h('button', { type: 'button', role: 'radio', 'aria-checked': String(v === cur), class: v === cur ? 'on' : '', 'data-v': v, onclick: (e) => { g.querySelectorAll('button').forEach((b) => { b.classList.toggle('on', b === e.currentTarget); b.setAttribute('aria-checked', String(b === e.currentTarget)); }); onpick(v); } }, l))); return g; };
    const target = h('input', { id: 'hf-target', type: 'number', min: 1, max: 9999, inputmode: 'numeric', value: f.target });
    const unit = h('input', { id: 'hf-unit', maxlength: 16, value: f.unit, placeholder: 'glasses, pages…' });
    const goalRow = h('div', { class: 'field-row' }, h('label', { class: 'field' }, 'Daily goal', target), h('label', { class: 'field' }, 'Unit', unit));
    const syncGoal = () => { goalRow.hidden = f.type === 'check'; if (f.type === 'timer') { unit.value = 'min'; unit.disabled = true; if (+target.value < 5) target.value = 30; } else { unit.disabled = false; if (unit.value === 'min' && f.type === 'count') unit.value = ''; } };
    const types = seg([['check', '✓ Yes / no'], ['count', '🔢 Count'], ['timer', '⏱️ Timer']], f.type, (v) => { f.type = v; syncGoal(); });
    const days = h('div', { class: 'days' }, [1, 2, 3, 4, 5, 6, 0].map((d) => h('button', { type: 'button', class: 'dy' + ((f.freq.days || [1, 2, 3, 4, 5]).includes(d) ? ' on' : ''), 'aria-pressed': String((f.freq.days || [1, 2, 3, 4, 5]).includes(d)), 'data-d': d, onclick: (e) => { e.currentTarget.classList.toggle('on'); e.currentTarget.setAttribute('aria-pressed', String(e.currentTarget.classList.contains('on'))); } }, DOW[d].slice(0, 2))));
    const times = h('input', { id: 'hf-times', type: 'number', min: 1, max: 7, value: f.freq.times || 3, inputmode: 'numeric' });
    const timesRow = h('label', { class: 'field inline' }, times, ' times per week');
    const syncFreq = () => { days.hidden = f.freq.type !== 'days'; timesRow.hidden = f.freq.type !== 'weekly'; };
    const freqs = seg([['daily', 'Every day'], ['days', 'Specific days'], ['weekly', 'X per week']], f.freq.type, (v) => { f.freq.type = v; syncFreq(); });
    const rem = h('input', { id: 'hf-rem', type: 'time', value: f.reminder || '' });
    const err = h('p', { class: 'gate-msg', role: 'alert' });
    const form = h('form', { class: 'hb-form', novalidate: true, onsubmit: (e) => {
      e.preventDefault();
      const nm = name.value.trim(); if (!nm) { err.textContent = 'Give the habit a name.'; name.focus(); return; }
      const fr = f.freq.type === 'days' ? { type: 'days', days: [...days.querySelectorAll('.dy.on')].map((b) => +b.dataset.d).sort() } : f.freq.type === 'weekly' ? { type: 'weekly', times: clampInt(times.value, 1, 7, 3) } : { type: 'daily' };
      if (fr.type === 'days' && !fr.days.length) { err.textContent = 'Pick at least one day.'; return; }
      if (fr.type === 'days' && fr.days.length === 7) { fr.type = 'daily'; delete fr.days; }
      const out = { name: nm.slice(0, 60), emoji: f.emoji, color: f.color, type: f.type, target: f.type === 'check' ? 1 : clampInt(target.value, 1, 9999, 1), unit: f.type === 'timer' ? 'min' : f.type === 'count' ? unit.value.trim().slice(0, 16) : '', freq: fr, reminder: hm(rem.value) };
      if (isNew) S.habits.push(Object.assign({ id: rid(), archived: false, created: today() }, out));
      else {
        const changed = hb.type !== out.type || hb.target !== out.target || JSON.stringify(hb.freq) !== JSON.stringify(out.freq);
        if (changed && Object.keys(S.log).some((x) => x < today() && S.log[x][hb.id])) recordHist(hb, today());
        Object.assign(hb, out); RC = {};
      }
      save(); closeSheet(); toast(isNew ? `🌱 Planted “${out.name}”` : 'Saved'); if (isNew) ui.view = 'today'; paint();
      if (out.reminder && !S.settings.notify) toast('Tip: enable notifications in Manage → Reminders');
    } },
      h('div', { class: 'form-top' }, preview, h('h3', null, isNew ? 'New habit' : 'Edit habit'), btn('✕', closeSheet, 'icon', { 'aria-label': 'Close' })),
      h('label', { class: 'field' }, 'Name', name),
      h('div', { class: 'field' }, h('span', null, 'Icon'), h('div', { class: 'emoji-row' }, emoji, h('span', { class: 'muted small' }, 'type any emoji or pick:')), emojiGrid),
      h('div', { class: 'field' }, h('span', null, 'Colour'), colors),
      h('div', { class: 'field' }, h('span', null, 'Goal type'), types), goalRow,
      h('div', { class: 'field' }, h('span', null, 'Frequency'), freqs, days, timesRow),
      h('label', { class: 'field inline' }, '⏰ Reminder (optional) ', rem),
      err,
      h('div', { class: 'row-btns end' }, !isNew ? btn('🗑️ Delete', () => {
        if (!confirm(`Delete “${hb.name}” and all its history? (Archive keeps history.)`)) return;
        S.habits = S.habits.filter((x) => x !== hb); for (const d of Object.keys(S.log)) { delete S.log[d][hb.id]; if (!Object.keys(S.log[d]).length) delete S.log[d]; }
        save(); closeSheet(); ui.view = 'manage'; paint(); toast('Deleted');
      }, 'ghost danger') : null, btn('Cancel', closeSheet, 'ghost'), h('button', { type: 'submit' }, isNew ? 'Add habit' : 'Save')));
    syncGoal(); syncFreq();
    openSheet(isNew ? 'New habit' : 'Edit habit', form);
  }

  /* ---------- export / import (encrypted files) ---------- */
  async function exportFile() {
    try {
      const env = await NotesCrypto.encryptJSON(key, Object.assign({}, S, { exported: new Date().toISOString() }), salt, iter, KIND);
      const url = URL.createObjectURL(new Blob([JSON.stringify(env)], { type: 'application/json' }));
      const a = h('a', { href: url, download: `daily-habits-${today()}.enc.json` });
      document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000);
      toast('⬇️ Encrypted backup downloaded');
    } catch (e) { console.warn(e); toast('Export failed'); }
  }
  function mergeState(x) {
    const idMap = {};
    for (const hb of x.habits) {
      const same = S.habits.find((y) => y.id === hb.id) || S.habits.find((y) => y.name.toLowerCase() === hb.name.toLowerCase());
      if (same) { idMap[hb.id] = same.id; if (hb.created < same.created) same.created = hb.created; } else { S.habits.push(hb); idMap[hb.id] = hb.id; }
    }
    for (const [d, row] of Object.entries(x.log)) for (const [id, v] of Object.entries(row)) {
      const tid = idMap[id] || id; const r = (S.log[d] = S.log[d] || {}); const cur = r[tid] || 0;
      r[tid] = v < 0 && cur <= 0 ? -1 : Math.max(cur, v);
    }
    Object.assign(S.known, x.known);
  }
  async function importFile(file) {
    let env;
    try { env = JSON.parse(await file.text()); } catch { toast('Not a valid backup file'); return; }
    if (!env || env.kind !== KIND) { toast('That file is not a Daily Notes habit backup'); return; }
    const apply = (data) => { mergeState(normState(data)); migrate(); RC = {}; save(); paint(); toast(`⬆️ Imported ${data.habits ? data.habits.length : 0} habits`); };
    if (env.salt === salt) { try { apply(await NotesCrypto.decryptJSON(key, env, KIND)); return; } catch { /* fall through to passphrase */ } }
    const inp = h('input', { type: 'password', placeholder: 'Passphrase used when exported', 'aria-label': 'Passphrase used when exported' });
    const msg = h('p', { class: 'gate-msg', role: 'alert' });
    openSheet('Unlock backup', h('form', { class: 'hb-form', onsubmit: async (e) => {
      e.preventDefault(); msg.textContent = 'Unlocking…';
      try { const k = await NotesCrypto.deriveKey(inp.value, env, false); const data = await NotesCrypto.decryptJSON(k, env, KIND); closeSheet(); apply(data); }
      catch { msg.textContent = 'Wrong passphrase for this backup.'; }
    } }, h('h3', null, '🔐 Unlock backup'), h('p', { class: 'muted small' }, 'This backup was made under a different passphrase.'), inp, msg,
      h('div', { class: 'row-btns end' }, btn('Cancel', closeSheet, 'ghost'), h('button', { type: 'submit' }, 'Import'))));
  }

  /* ---------- reminders + day rollover ---------- */
  async function notify(title, body, tag) {
    try {
      const reg = navigator.serviceWorker && (await navigator.serviceWorker.getRegistration());
      if (reg && reg.showNotification) await reg.showNotification(title, { body, tag, renotify: false });
      else new Notification(title, { body, tag });
    } catch (e) { console.warn('notification failed', e); }
  }
  function tick() {
    if (!S || lockedBlob) return;
    const t = today();
    if (t !== lastDay) { if (ui.date === lastDay) ui.date = t; lastDay = t; S.notified = {}; paint(); }
    if (!S.settings.notify || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    const now = nowHM(), sent = (S.notified[t] = S.notified[t] || []);
    for (const k of Object.keys(S.notified)) if (k !== t) delete S.notified[k];
    const inWindow = (hhmm) => hhmm && now >= hhmm && now < String(Math.min(23, +hhmm.slice(0, 2) + 2)).padStart(2, '0') + hhmm.slice(2);
    let changed = false;
    for (const hb of S.habits) {
      if (!hb.reminder || sent.includes(hb.id) || !inWindow(hb.reminder) || !required(hb, t) || done(hb, t)) continue;
      sent.push(hb.id); changed = true;
      notify(S.settings.discreet ? '🌸 Habit reminder' : `${hb.emoji} ${hb.name}`, S.settings.discreet ? 'A habit is waiting for you today.' : `Time for this one${hb.type !== 'check' ? ` — ${val(hb, t)}/${hb.target} ${hb.unit}` : ''}. Tap to check it off.`, 'hb-' + hb.id);
    }
    if (S.settings.checkin && !sent.includes('_checkin') && inWindow(S.settings.checkin)) {
      const sc = dayScore(t); sent.push('_checkin'); changed = true;
      if (sc.n && sc.pct < 1) notify('🌷 Evening check-in', `${sc.done} of ${sc.n} habits done today — finish strong!`, 'hb-checkin');
    }
    if (changed) save();
  }
  function start() {
    stop(); ticker = setInterval(tick, 30000); setTimeout(tick, 1500);
    timerTick = setInterval(() => { if (S && Object.keys(S.running).length && ui.view === 'today' && !sheetEl) paint(); }, 20000);
  }
  function stop() { clearInterval(ticker); clearInterval(timerTick); ticker = timerTick = null; }

  /* ---------- read-only API for the week view / review / search / due pings (features.js) ---------- */
  const ready = () => !!(S && !lockedBlob);
  function dueOn(d) { return ready() ? S.habits.filter((hb) => required(hb, d) && !done(hb, d)).map((hb) => ({ id: hb.id, name: hb.name, emoji: hb.emoji })) : null; }
  function weekStats(ws) {
    if (!ready()) return null;
    const t = today(); let sum = 0, n = 0, perfect = 0;
    for (let i = 0; i < 7; i++) { const d = addDays(ws, i); if (d > t) break; const sc = dayScore(d); if (sc.pct != null) { sum += sc.pct; n++; if (sc.pct >= 1) perfect++; } }
    return { pct: n ? sum / n : null, perfect, days: n };
  }
  const names = () => (ready() ? S.habits.filter((hb) => !hb.archived).map((hb) => ({ id: hb.id, name: hb.name, emoji: hb.emoji })) : []);
  const notifyOn = () => !!(ready() && S.settings.notify && typeof Notification !== 'undefined' && Notification.permission === 'granted');
  const discreet = () => !!(ready() && S.settings.discreet);
  /* ---------- sync hooks (sync.js): last-write-wins on the whole tracker; first sync on a device merges ---------- */
  function syncExport() { if (!ready()) return null; const x = JSON.parse(JSON.stringify(S)); x.notified = {}; return x; }
  // Replace local state with the server copy (mergeLocal: also fold in what this device had). Returns true when the
  // result differs from the server copy (so sync.js should push it back).
  function syncAdopt(data, mergeLocal) {
    if (!ready()) return false;
    const local = S, remote = normState(data);
    S = normState(data); S.notified = local.notified || {};
    if (mergeLocal) mergeState(normState(local));
    mergeNotes(lastNotes); migrate(); RC = {};
    const differs = sigOf(S) !== sigOf(remote);
    syncSig = sigOf(S); save(true);
    if (!sheetEl) paint();
    return differs;
  }
  // Exercise minutes per day from the exercise log ({ 'YYYY-MM-DD': minutes }); repaints only when it changed.
  function setExternal(map) { const m = map && typeof map === 'object' ? map : {}; const sg = JSON.stringify(m); if (sg === EXT_SIG) return; EXT = m; EXT_SIG = sg; if (S && !sheetEl) paint(); }
  // Read-only per-habit summary for the Goals tab.
  function summary() {
    if (!ready()) return [];
    const t = today(), ws = weekStart(t);
    return S.habits.filter((hb) => !hb.archived).map((hb) => {
      let weekVal = 0, weekDays = 0, monthVal = 0;
      for (let i = 0; i < 7; i++) { const x = addDays(ws, i); if (x > t) break; weekVal += val(hb, x); if (done(hb, x)) weekDays++; }
      for (let i = 0; i < 30; i++) monthVal += val(hb, addDays(t, -i));
      const st = streaks(hb);
      return { id: hb.id, name: hb.name, emoji: hb.emoji, type: hb.type, target: hb.target, unit: hb.unit, freq: freqLabel(hb), weekly: hb.freq.type === 'weekly' ? hb.freq.times : null,
        today: val(hb, t), doneToday: done(hb, t), weekVal, weekDays, monthVal, rate7: rate(hb, 7), rate30: rate(hb, 30), streak: st.cur, best: st.best, unit2: st.unit,
        exercise: hb === exHabit(), seed: hb.id.startsWith('seed-') ? hb.id.slice(5) : null };
    });
  }
  window.Habits = { syncReady: ready, syncExport, syncAdopt, setExternal, summary, el: () => root, unlock, lock, _flush: () => saving, dueOn, weekStats, names, notifyOn, discreet, notify };
})();
