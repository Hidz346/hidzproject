'use strict';
/* Masuk dengan GitHub (OAuth web flow) untuk HIDZPROJECT.

   Alurnya: browser membuka halaman izin GitHub di jendela kecil, GitHub mengembalikan `code` sekali pakai ke
   /github-callback.html, halaman itu meneruskan `code` ke jendela utama, lalu server (di sini) menukarnya
   dengan token memakai GITHUB_CLIENT_SECRET dan membaca profil. Token GitHub tidak pernah dikirim ke browser
   dan tidak disimpan. Akun dicocokkan lewat id numerik GitHub (tidak berubah walau username diganti).

   Client ID itu publik (dipakai membangun URL izin), jadi disisipkan ke HTML seperti site key Turnstile.
   File ini hanya bantu (bukan endpoint), jadi tidak menambah jumlah Serverless Function. */

const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const API_USER = 'https://api.github.com/user';
const API_EMAILS = 'https://api.github.com/user/emails';
const CALLBACK_PATH = '/github-callback.html';

function getClientId() { return String(process.env.GITHUB_CLIENT_ID || '').trim(); }
function getClientSecret() { return String(process.env.GITHUB_CLIENT_SECRET || '').trim(); }

/* Tanpa GITHUB_CLIENT_ID dan GITHUB_CLIENT_SECRET tombol GitHub tampil nonaktif dan Google tetap berfungsi. */
function injectClientId(html) {
    const id = getClientId().replace(/[^A-Za-z0-9._-]/g, '');
    return (id && getClientSecret()) ? String(html).replace('data-github-client=""', 'data-github-client="' + id + '"') : String(html);
}

function ghHeaders(token) {
    return { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'User-Agent': 'hidzproject-login' };
}

/* redirectUri harus mengarah ke halaman callback kita sendiri (host sama dengan situs ini). */
function redirectUriAllowed(redirectUri, host) {
    let u;
    try { u = new URL(String(redirectUri)); } catch (e) { return false; }
    if (u.pathname !== CALLBACK_PATH || u.search || u.hash) return false;
    return !!host && u.host.toLowerCase() === String(host).toLowerCase();
}

/* Mengembalikan { id, login, name, email } atau melempar Error:
   GITHUB_NOT_CONFIGURED / GITHUB_FETCH_FAILED (masalah di sisi kita atau GitHub) atau INVALID_GITHUB_CODE. */
async function exchangeCode(code, redirectUri) {
    const clientId = getClientId(), clientSecret = getClientSecret();
    if (!clientId || !clientSecret) throw new Error('GITHUB_NOT_CONFIGURED');
    if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{8,120}$/.test(code)) throw new Error('INVALID_GITHUB_CODE');

    let tokenResp;
    try {
        const r = await fetch(TOKEN_URL, {
            method: 'POST',
            headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'hidzproject-login' },
            body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code: code, redirect_uri: redirectUri })
        });
        if (!r.ok) throw new Error('GITHUB_FETCH_FAILED');
        tokenResp = await r.json();
    } catch (e) {
        throw new Error('GITHUB_FETCH_FAILED');
    }
    /* GitHub menjawab 200 walau kodenya salah/kedaluwarsa; bedanya ada di field error. */
    if (!tokenResp || tokenResp.error || typeof tokenResp.access_token !== 'string' || !tokenResp.access_token) {
        throw new Error('INVALID_GITHUB_CODE');
    }
    const token = tokenResp.access_token;

    let user;
    try {
        const r = await fetch(API_USER, { headers: ghHeaders(token) });
        if (!r.ok) throw new Error('GITHUB_FETCH_FAILED');
        user = await r.json();
    } catch (e) {
        throw new Error('GITHUB_FETCH_FAILED');
    }
    if (!user || !Number.isFinite(Number(user.id)) || typeof user.login !== 'string' || !user.login) throw new Error('GITHUB_FETCH_FAILED');

    /* Email hanya pelengkap (tampil di profil & HIDZADMIN): id GitHub-lah yang menjadi kunci akun. */
    let email = '';
    try {
        const r = await fetch(API_EMAILS, { headers: ghHeaders(token) });
        if (r.ok) {
            const list = await r.json();
            if (Array.isArray(list)) {
                const pick = list.filter(function (e) { return e && e.verified === true && e.primary === true; })[0]
                    || list.filter(function (e) { return e && e.verified === true; })[0];
                if (pick && typeof pick.email === 'string') email = pick.email.toLowerCase();
            }
        }
    } catch (e) { email = ''; }

    return {
        id: String(user.id),
        login: String(user.login).slice(0, 39),
        name: typeof user.name === 'string' ? user.name : '',
        email: email
    };
}

module.exports = { getClientId, getClientSecret, injectClientId, redirectUriAllowed, exchangeCode, CALLBACK_PATH };
