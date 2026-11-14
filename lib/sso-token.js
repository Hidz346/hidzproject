'use strict';
/* Token bertanda tangan untuk alur daftar / pulihkan akun lewat Google atau GitHub.

   Server tidak menyimpan apa pun saat orang baru membuktikan identitasnya: hasil verifikasi dibungkus jadi
   token HMAC yang berlaku singkat, lalu dikembalikan lewat form username & password. Dua jenis:
   - "setup"   -> identitas ini belum punya akun; boleh dipakai SEKALI untuk membuat akun
   - "recover" -> identitas ini sudah punya akun; boleh dipakai untuk mengajukan perubahan username/password

   Kunci HMAC diturunkan dari rahasia server yang sudah ada (FIREBASE_DB_SECRET), jadi tidak ada variabel
   lingkungan baru. File ini hanya bantu (bukan endpoint), jadi tidak menambah jumlah Serverless Function. */
const crypto = require('crypto');

function secret() {
    const base = String(process.env.FIREBASE_DB_SECRET || process.env.TURNSTILE_SECRET_KEY || '');
    if (!base) return null;
    return crypto.createHash('sha256').update('hidz-sso-token|' + base).digest();
}

/* purpose + payload + masa berlaku (detik). Mengembalikan '' kalau server belum punya rahasia. */
function sign(purpose, payload, ttlSec) {
    const key = secret();
    if (!key) return '';
    const body = Object.assign({}, payload, { p: purpose, exp: Date.now() + ttlSec * 1000 });
    const part = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
    const sig = crypto.createHmac('sha256', key).update(part).digest('base64url');
    return part + '.' + sig;
}

/* Isi token kalau tanda tangannya cocok, jenisnya sesuai, dan belum kedaluwarsa; selain itu null. */
function verify(token, purpose) {
    const key = secret();
    if (!key || typeof token !== 'string' || token.length > 2048) return null;
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const expected = crypto.createHmac('sha256', key).update(parts[0]).digest();
    let given;
    try { given = Buffer.from(parts[1], 'base64url'); } catch (e) { return null; }
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
    let body;
    try { body = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); } catch (e) { return null; }
    if (!body || body.p !== purpose || !(Number(body.exp) > Date.now())) return null;
    return body;
}

function randomSecret() { return crypto.randomBytes(32).toString('base64url'); }
function digest(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }

module.exports = { sign, verify, randomSecret, digest };
