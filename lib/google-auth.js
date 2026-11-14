'use strict';
/* Verifikasi ID token "Masuk dengan Google" di server.

   Browser cuma mengirim credential (JWT bertanda tangan Google) yang didapat dari tombol Google. Server
   tidak pernah percaya isinya begitu saja: tanda tangan dicek ke kunci publik Google, lalu penerbit, client
   id (aud), masa berlaku, dan status email diperiksa. Akun dicocokkan lewat `sub` (id Google yang tidak
   berubah), bukan email, karena email bisa diganti pemiliknya.

   Client ID Google itu publik (tampil di tombol), jadi disisipkan ke HTML seperti site key Turnstile. File
   ini hanya bantu (bukan endpoint), jadi tidak menambah jumlah Serverless Function. */
const crypto = require('crypto');

const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
/* ID token Google berlaku 1 jam. Dipersempit supaya token yang sempat bocor tidak bisa dipakai ulang lama. */
const MAX_TOKEN_AGE_SEC = 10 * 60;

let jwksCache = { keys: [], expiresAt: 0 };

function getClientId() { return String(process.env.GOOGLE_CLIENT_ID || '').trim(); }

/* Kalau GOOGLE_CLIENT_ID belum diatur, atribut dibiarkan kosong dan tombol Google tidak ditampilkan —
   login username & password tetap jalan seperti biasa. */
function injectClientId(html) {
    const id = getClientId().replace(/[^A-Za-z0-9._-]/g, '');
    return id ? String(html).replace('data-google-client=""', 'data-google-client="' + id + '"') : String(html);
}

async function getJwks() {
    const now = Date.now();
    if (jwksCache.keys.length && jwksCache.expiresAt > now) return jwksCache.keys;
    const r = await fetch(JWKS_URL, { headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error('GOOGLE_CERT_FETCH_FAILED');
    const data = await r.json();
    const m = /max-age=(\d+)/i.exec(String(r.headers.get('cache-control') || ''));
    const ttl = m ? Number(m[1]) * 1000 : 3600000;
    jwksCache = { keys: Array.isArray(data && data.keys) ? data.keys : [], expiresAt: now + Math.max(60000, Math.min(ttl, 86400000)) };
    return jwksCache.keys;
}

function decodePart(part) {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

/* Mengembalikan { sub, email, name, givenName, picture } atau melempar Error:
   GOOGLE_NOT_CONFIGURED / GOOGLE_CERT_FETCH_FAILED (masalah di sisi kita) atau INVALID_GOOGLE_TOKEN. */
async function verifyIdToken(credential) {
    const clientId = getClientId();
    if (!clientId) throw new Error('GOOGLE_NOT_CONFIGURED');
    if (typeof credential !== 'string' || credential.length > 4096) throw new Error('INVALID_GOOGLE_TOKEN');
    const parts = credential.split('.');
    if (parts.length !== 3) throw new Error('INVALID_GOOGLE_TOKEN');

    let header, payload;
    try { header = decodePart(parts[0]); payload = decodePart(parts[1]); }
    catch (e) { throw new Error('INVALID_GOOGLE_TOKEN'); }
    if (!header || header.alg !== 'RS256' || !header.kid || !payload) throw new Error('INVALID_GOOGLE_TOKEN');

    const now = Math.floor(Date.now() / 1000);
    const iat = Number(payload.iat), exp = Number(payload.exp);
    const emailVerified = payload.email_verified === true || payload.email_verified === 'true';
    if (ISSUERS.indexOf(payload.iss) === -1 || payload.aud !== clientId) throw new Error('INVALID_GOOGLE_TOKEN');
    if (!payload.sub || typeof payload.sub !== 'string' || !payload.email || !emailVerified) throw new Error('INVALID_GOOGLE_TOKEN');
    if (!(exp > now) || !(iat <= now + 300) || now - iat > MAX_TOKEN_AGE_SEC) throw new Error('INVALID_GOOGLE_TOKEN');

    let jwk = (await getJwks()).filter(function (k) { return k.kid === header.kid; })[0];
    if (!jwk) {
        jwksCache.expiresAt = 0;
        jwk = (await getJwks()).filter(function (k) { return k.kid === header.kid; })[0];
    }
    if (!jwk) throw new Error('INVALID_GOOGLE_TOKEN');

    let ok = false;
    try {
        const verifier = crypto.createVerify('RSA-SHA256');
        verifier.update(parts[0] + '.' + parts[1]);
        verifier.end();
        ok = verifier.verify(crypto.createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(parts[2], 'base64url'));
    } catch (e) { ok = false; }
    if (!ok) throw new Error('INVALID_GOOGLE_TOKEN');

    return {
        sub: payload.sub,
        email: String(payload.email).toLowerCase(),
        name: typeof payload.name === 'string' ? payload.name : '',
        givenName: typeof payload.given_name === 'string' ? payload.given_name : '',
        picture: typeof payload.picture === 'string' ? payload.picture : ''
    };
}

module.exports = { getClientId, injectClientId, verifyIdToken };
