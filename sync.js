/* Daily Notes – optional sync with the "Daily Notes DB" Google Sheet (backend/Code.gs). Off unless config.js sets dbUrl.
   Everything sent is AES-256-GCM ciphertext made here with the notes key; the server never sees plaintext.
   Auth is password-only: an auth verifier derived from the passphrase (NotesCrypto.authVerifier, different salt from the
   encryption key) is sent with each call; the server keeps only a salted hash of it.
   Blobs: "edits" = { dn_edits:1, device, exported, edits, tomb } (merged by edit id, EditsCore.mergeSync)
          "habits" = the habit tracker state (last write wins; a device's first sync merges instead).
   When: on unlock, ~3 s after a change, every 3 min while open, when back online / the tab is shown again.
   Offline: changes stay on the device (marked dirty) and go up on the next successful sync. */
(function () {
  'use strict';
  const C = window.EditsCore;
  const cfg = window.DN_CONFIG && typeof window.DN_CONFIG === 'object' ? window.DN_CONFIG : {};
  const URL_ = typeof cfg.dbUrl === 'string' && /^(https:\/\/script\.google\.com\/(a\/macros\/[\w.-]+|macros)\/s\/[\w-]+\/exec|http:\/\/(127\.0\.0\.1|localhost):\d+\/[\w\/.-]*)$/.test(cfg.dbUrl) ? cfg.dbUrl : '';
  const LS_META = 'dn.sync.v1', EVERY_MS = 180000, DEBOUNCE_MS = 3000, TIMEOUT_MS = 25000;
  const HABITS_KIND = 'dn-habits-v1';
  let key = null, salt = null, iter = null, vf = null, state = 'off', detail = '', lastOk = 0;
  let busy = false, again = false, deb = null, every = null, lastVis = 0, meta = null;

  const freshMeta = (sa) => ({ salt: sa, edits: { ver: 0, dirty: false }, habits: { ver: null, dirty: false, updated: 0 } });
  function loadMeta(sa) {
    let m = null; try { m = JSON.parse(localStorage.getItem(LS_META)); } catch { /* ignore */ }
    return m && m.salt === sa && m.edits && m.habits ? m : freshMeta(sa);
  }
  const saveMeta = () => { if (meta) try { localStorage.setItem(LS_META, JSON.stringify(meta)); } catch { /* quota */ } };
  const dirty = () => !!(meta && (meta.edits.dirty || meta.habits.dirty));

  /* ---------- status chip ---------- */
  const chip = () => document.getElementById('sync-chip');
  const hm = (t) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Manila', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(t));
  function setState(s, d) {
    state = s; detail = d || '';
    const el = chip(); if (!el) return;
    el.hidden = !URL_ || !key;
    const q = dirty() ? ' · changes queued' : '';
    const txt = {
      busy: ['⏳ Syncing…', 'Syncing with your Sheet'],
      ok: [`☁️ ${hm(lastOk)}`, `Synced with your Sheet at ${hm(lastOk)} PHT. Tap to sync now.`],
      offline: ['📴 Offline', `Can’t reach the sync server – everything is saved on this device${q}. Tap to retry.`],
      nopass: ['☁️ Paused', 'Sync needs the passphrase: lock and unlock again (or tick “Remember” when you do).'],
      unclaimed: ['🔗 Link sync', 'Sync server not linked yet – tap and enter the setup code from the Apps Script log.'],
      auth: ['🔐 Sync', 'The sync server did not accept this passphrase. Tap to enter a new setup code.'],
      locked: ['⛔ Sync', detail || 'Too many failed attempts – try later.'],
      error: ['⚠️ Sync', (detail || 'Sync error') + '. Tap to retry.'],
    }[s] || ['☁️', ''];
    el.textContent = s === 'offline' && dirty() ? '📴 Queued' : txt[0];
    el.title = txt[1]; el.setAttribute('aria-label', txt[1]);
    el.dataset.state = s;
  }

  /* ---------- transport ---------- */
  class SyncError extends Error { constructor(code, msg) { super(msg || code); this.code = code; } }
  async function call(body) {
    const ac = new AbortController(), t = setTimeout(() => ac.abort(), TIMEOUT_MS);
    let r;
    try {
      // text/plain = CORS "simple request" (no preflight); Apps Script replies 302 → fetch follows as GET.
      r = await fetch(URL_, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body), redirect: 'follow', credentials: 'omit', cache: 'no-store', signal: ac.signal });
    } catch { throw new SyncError('net'); } finally { clearTimeout(t); }
    if (!r.ok) throw new SyncError('net', 'HTTP ' + r.status);
    let j; try { j = await r.json(); } catch { throw new SyncError('net', 'bad response'); }
    if (!j || typeof j !== 'object') throw new SyncError('net', 'bad response');
    return j;
  }
  async function req(body, okCodes) {
    const j = await call(Object.assign({ vf }, body));
    if (!j.ok && !(okCodes && okCodes.includes(j.code))) throw new SyncError(j.code || 'error', j.msg);
    return j;
  }
  async function decrypt(data, kind) {
    let env; try { env = JSON.parse(data); } catch { return { foreign: true }; }
    if (!env || env.salt !== salt) return { foreign: true }; // made under another passphrase/salt – keep it in History, don't read
    try { return { val: await NotesCrypto.decryptJSON(key, env, kind) }; } catch { return { foreign: true }; }
  }
  const seal = async (obj, kind) => JSON.stringify(await NotesCrypto.encryptJSON(key, obj, salt, iter, kind));

  /* ---------- per-blob sync ---------- */
  async function syncEdits() {
    const F = window.Features;
    if (!F || !F.ready()) return;
    for (let tries = 0; tries < 4; tries++) {
      const g = await req({ a: 'get', key: 'edits' });
      let remote = { edits: [], tomb: {} }, foreign = false;
      if (g.data) { const d = await decrypt(g.data, C.KIND); if (d.foreign) foreign = true; else remote = { edits: d.val.edits || [], tomb: d.val.tomb || {} }; }
      F.syncApply(C.mergeSync(F.syncPayload(), remote));
      const after = F.syncPayload();
      const empty = !after.edits.length && !Object.keys(after.tomb).length;
      if ((g.data && !foreign && C.syncSig(after) === C.syncSig(remote)) || (!g.data && empty)) { meta.edits = { ver: g.ver, dirty: false }; return; }
      const data = await seal({ dn_edits: 1, device: after.device, exported: new Date().toISOString(), edits: after.edits, tomb: after.tomb }, C.KIND);
      const p = await req({ a: 'put', key: 'edits', base: g.ver, updated: Date.now(), data }, ['conflict']);
      if (p.ok) { meta.edits = { ver: p.ver, dirty: false }; return; }
    }
    throw new SyncError('error', 'Edits kept changing on another device');
  }
  async function syncHabits() {
    const H = window.Habits;
    if (!H || !H.syncReady || !H.syncReady()) return;
    const m = meta.habits;
    for (let tries = 0; tries < 4; tries++) {
      const g = await req(Object.assign({ a: 'get', key: 'habits' }, m.ver != null ? { since: m.ver } : {}));
      let push = false;
      if (!g.ver) push = true;                                   // nothing on the server yet
      else if (g.same) push = m.dirty;                           // server unchanged since our last sync
      else {
        const d = await decrypt(g.data, HABITS_KIND);
        if (d.foreign) push = true;                              // older passphrase: overwrite (server keeps it in History)
        else if (m.ver == null) push = H.syncAdopt(d.val, true); // first sync on this device: merge both ways
        else if (!m.dirty || g.updated >= m.updated) { H.syncAdopt(d.val, false); push = false; } // last write wins
        else push = true;
      }
      if (!push) { meta.habits = { ver: g.ver, dirty: false, updated: m.updated }; return; }
      const p = await req({ a: 'put', key: 'habits', base: g.ver, updated: m.updated || Date.now(), data: await seal(H.syncExport(), HABITS_KIND) }, ['conflict']);
      if (p.ok) { meta.habits = { ver: p.ver, dirty: false, updated: p.updated }; return; }
      m.ver = m.ver == null ? null : -1; // conflict: re-read the server copy
    }
    throw new SyncError('error', 'Habits kept changing on another device');
  }

  async function syncNow() {
    if (!URL_ || !key) return;
    if (!vf) { setState('nopass'); return; }
    if (busy) { again = true; return; }
    busy = true; setState('busy');
    const k0 = key;
    try {
      await syncEdits();
      await syncHabits();
      if (key !== k0) return;
      lastOk = Date.now(); setState('ok');
    } catch (e) {
      if (key !== k0) return;
      const c = e && e.code;
      if (c === 'net' || c === 'busy') setState('offline');
      else if (c === 'unclaimed' || c === 'auth') setState(c);
      else if (c === 'locked') setState('locked', e.message);
      else { console.warn('sync failed', e); setState('error', e && e.message); }
    } finally {
      busy = false; saveMeta();
      if (again) { again = false; setTimeout(syncNow, 300); }
    }
  }

  async function claim() {
    let info = null; try { info = await call({ a: 'info' }); } catch { setState('offline'); return; }
    if (state === 'auth' && !info.claimable) { alert('The sync server is linked to a different passphrase. To re-link, run newSetupCode() in the Apps Script editor, then tap here and enter the new code.'); return; }
    const code = prompt('Setup code from the Apps Script log (like ABCD-EFGH-JKLM):');
    if (!code) return;
    try { const j = await call({ a: 'claim', code, vf }); if (!j.ok) { alert(j.msg || 'Could not link'); return; } } catch { setState('offline'); return; }
    syncNow();
  }
  function onChip() {
    if (state === 'unclaimed' || state === 'auth') return claim();
    if (state === 'nopass') return alert('Sync needs your passphrase on this device: tap 🔒 Lock, then unlock with the passphrase (tick “Remember” to keep sync on).');
    syncNow();
  }

  /* ---------- lifecycle (called by app.js) ---------- */
  let early = new Set(); // changes made while unlocking, before sync.js got the key
  function changed(kind) {
    if (!URL_) return;
    if (!meta) { early.add(kind); return; }
    if (!meta[kind]) return;
    meta[kind].dirty = true; if (kind === 'habits') meta.habits.updated = Date.now();
    saveMeta();
    clearTimeout(deb); deb = setTimeout(syncNow, DEBOUNCE_MS);
  }
  function setVf(v) { vf = typeof v === 'string' && /^[0-9a-f]{64}$/.test(v) ? v : null; }
  function unlock(k, env) {
    if (!URL_) return;
    if (key === k && salt === env.salt) return;
    key = k; salt = env.salt; iter = env.iter; meta = loadMeta(salt);
    for (const kd of early) { if (meta[kd]) { meta[kd].dirty = true; if (kd === 'habits') meta.habits.updated = Date.now(); } }
    early = new Set();
    const el = chip(); if (el && !el._wired) { el._wired = 1; el.addEventListener('click', onChip); }
    clearInterval(every); every = setInterval(() => { if (!document.hidden) syncNow(); }, EVERY_MS);
    setState(vf ? 'busy' : 'nopass');
    syncNow();
  }
  function lock() { key = null; vf = null; meta = null; clearInterval(every); clearTimeout(deb); every = null; const el = chip(); if (el) el.hidden = true; state = 'off'; }
  window.addEventListener('online', () => syncNow());
  document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - lastVis > 30000) { lastVis = Date.now(); syncNow(); } });

  window.Sync = { configured: () => !!URL_, setVf, unlock, lock, changed, now: syncNow, state: () => ({ state, detail, lastOk, dirty: dirty() }) };
})();
