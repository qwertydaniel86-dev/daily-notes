/* Daily Notes – in-browser decryption (WebCrypto). Format v1:
   { v:1, alg:"AES-GCM", kdf:"PBKDF2", hash:"SHA-256", iter:N, salt:b64, iv:b64, ct:b64 } */
(function () {
  'use strict';
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const b64d = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const b64e = (buf) => { const u = new Uint8Array(buf); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };

  function checkEnvelope(e) {
    if (!e || e.v !== 1 || e.alg !== 'AES-GCM' || e.kdf !== 'PBKDF2' || e.hash !== 'SHA-256')
      throw new Error('Unsupported notes format');
    if (!(e.iter >= 200000)) throw new Error('KDF iterations too low');
  }

  async function deriveKey(pass, envelope, extractable) {
    checkEnvelope(envelope);
    const base = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt: b64d(envelope.salt), iterations: envelope.iter },
      base, { name: 'AES-GCM', length: 256 }, !!extractable, ['encrypt', 'decrypt']);
  }

  async function importRawKey(b64) {
    return crypto.subtle.importKey('raw', b64d(b64), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }

  async function exportRawKey(key) {
    return b64e(await crypto.subtle.exportKey('raw', key));
  }

  async function decryptWithKey(key, envelope) {
    checkEnvelope(envelope);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64d(envelope.iv), tagLength: 128 }, key, b64d(envelope.ct));
    return JSON.parse(dec.decode(pt));
  }

  // Local data (habit tracker) – same key & envelope format as notes.enc.json, plus a `kind` tag that is
  // bound to the ciphertext as AES-GCM additional data, so a habits blob can never be mistaken for notes.
  async function encryptJSON(key, obj, salt, iter, kind) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, tagLength: 128, additionalData: enc.encode(kind) }, key, enc.encode(JSON.stringify(obj)));
    return { v: 1, kind, alg: 'AES-GCM', kdf: 'PBKDF2', hash: 'SHA-256', iter, salt, iv: b64e(iv), ct: b64e(ct) };
  }
  async function decryptJSON(key, envelope, kind) {
    checkEnvelope(envelope);
    if (envelope.kind !== kind) throw new Error('Wrong file type');
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64d(envelope.iv), tagLength: 128, additionalData: enc.encode(kind) }, key, b64d(envelope.ct));
    return JSON.parse(dec.decode(pt));
  }

  // Sync-server login: a separate value derived from the passphrase with a DIFFERENT salt, so it can never be used as
  // (or turned into) the encryption key. The server stores only a salted hash of it. Same recipe in tools/sync-lib.mjs.
  const AUTH_SALT = 'daily-notes/auth/v1', AUTH_ITER = 600000;
  async function authVerifier(pass) {
    const base = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(AUTH_SALT), iterations: AUTH_ITER }, base, 256);
    return Array.from(new Uint8Array(bits), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  window.NotesCrypto = { deriveKey, importRawKey, exportRawKey, decryptWithKey, encryptJSON, decryptJSON, authVerifier };
})();
