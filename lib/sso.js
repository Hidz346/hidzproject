'use strict';
/* Daftar, masuk ulang, dan pulihkan akun HIDZPROJECT lewat Google / GitHub.

   Google dan GitHub hanya MEMBUKTIKAN siapa orangnya. Akun HIDZPROJECT tetap punya username & password
   yang dibuat sendiri oleh pemiliknya, jadi plan, masa aktif, batas perangkat, chat, notifikasi, dan rules
   Firebase tidak berubah: setelah masuk, semuanya sama persis dengan akun biasa.

   Alurnya:
   1. sso-begin     bukti identitas diperiksa. Belum punya akun -> status "new" + token setup (berlaku 15 menit).
                    Sudah punya akun -> status "registered": harus masuk dengan username & password.
   2. sso-register  token setup + username + password -> akun dibuat DI SINI (bukan saat langkah 1), jadi
                    akun yang masuk ke HIDZADMIN selalu sudah punya username & password.
   3. cred-request  lupa username/password: identitas yang sudah terdaftar boleh mengajukan data baru. Tidak ada
                    yang berubah sampai admin menyetujuinya di HIDZADMIN (status pending / approved / rejected).
   4. sso-status    browser pemohon memantau statusnya; begitu disetujui, server menjawab dengan token Firebase
                    sehingga pemohon langsung masuk sendiri tanpa mengetik apa-apa.
   5. sso-link      akun lama (buatan admin / hasil beli VIP) bisa menghubungkan Google/GitHub dari halaman Profil
                    supaya punya jalur pemulihan.

   Pintu masuk (tanpa menambah Serverless Function):
   - sso-begin, sso-register, cred-request  lewat /api/login (kena gerbang Turnstile + rate limit)
   - sso-status, sso-link                   lewat /api/check-session?vipAction=... */
var crypto = require('crypto');
var db = require('./db');
var pw = require('./password');
var googleAuth = require('./google-auth');
var githubAuth = require('./github-auth');
var firebaseAuth = require('./firebase-auth');
var notifSeed = require('./notif-seed');
var ssoToken = require('./sso-token');

var RATE_PATH     = 'hidz_sso_rate_limit';
var CREATE_PATH   = 'hidz_sso_create_limit';
var REQUESTS_PATH = 'hidz_credential_requests';
var ADMIN_ID      = 'admin_hidz_protected';

/* Akun baru dibuka untuk siapa saja, jadi dua perangkat (HP + laptop) dibolehkan: batas 1 perangkat langsung
   memblokir akun yang dipakai di dua tempat. Upgrade VIP tidak mengubah angka ini. */
var FREE_DEVICE_LIMIT = 2;
/* Durasi dan batas perangkat ditentukan pendaftar sendiri (pilihannya sama dengan form buat akun di HIDZADMIN,
   tanpa DETIK dan tanpa pilihan role: akun baru selalu 'user'). Batas perangkat 0 = tanpa batas. */
var DEVICE_CHOICES  = [0, 1, 2];
var DURATION_UNITS  = { menit: 60000, jam: 3600000, hari: 86400000, minggu: 7 * 86400000, bulan: 30 * 86400000, tahun: 365 * 86400000 };
var DURATION_LABELS = { menit: 'MENIT', jam: 'JAM', hari: 'HARI', minggu: 'MINGGU', bulan: 'BULAN', tahun: 'TAHUN' };
var DURATION_MIN_MS = 60000;
var DURATION_MAX_MS = 100 * 365 * 86400000;
var SETUP_TTL_SEC     = 15 * 60;
var RECOVER_TTL_SEC   = 30 * 60;
/* Setelah admin menyetujui, browser pemohon punya waktu segini untuk masuk otomatis. Lewat dari itu cukup
   masuk manual dengan username & password yang baru. */
var CLAIM_WINDOW_MS   = 15 * 60 * 1000;
var DECIDED_KEEP_MS   = 30 * 24 * 60 * 60 * 1000;
var CREATE_WINDOW_MS  = 60 * 60 * 1000;
var CREATE_MAX        = { register: 6, request: 6 };

var USERNAME_RE = /^[A-Za-z0-9_.-]{3,20}$/;
var RESERVED    = ['admin', 'administrator', 'root', 'system', 'hidzproject', 'hidzadmin', 'moderator'];
var PASSWORD_MIN = 6;
var PASSWORD_MAX = 64;

var PROVIDERS = {
    google: { idField: 'googleSub', labelField: 'googleEmail' },
    github: { idField: 'githubId',  labelField: 'githubLogin' }
};

/* ---------- bentuk data ---------- */

/* Bentuknya sama dengan respons /api/login untuk akun biasa, ditambah identitas yang terhubung supaya halaman
   profil bisa menampilkannya. Id Google/GitHub tidak pernah dikirim ke browser. */
function publicAccount(u) {
    return Object.assign({
        id:            u.id,
        username:      u.username,
        role:          u.role || 'user',
        createdAt:     u.createdAt || Date.now(),
        createdBy:     u.createdBy || null,
        expiresAt:     u.expiresAt || null,
        durationMs:    (typeof u.durationMs === 'number') ? u.durationMs : null,
        durationLabel: u.durationLabel || 'UNLIMITED',
        deviceLimit:   typeof u.deviceLimit === 'number' ? u.deviceLimit : 1,
        activated:     u.activated,
        logoutAt:      u.logoutAt || null
    }, db.identityInfo(u));
}

function publicRequest(r) {
    return {
        id:          r.id,
        status:      r.status,
        username:    r.username,
        newUsername: r.newUsername,
        createdAt:   r.createdAt,
        decidedAt:   r.decidedAt || null,
        reason:      r.reason || null
    };
}

function findByIdentity(list, provider, id) {
    var field = PROVIDERS[provider].idField;
    return list.filter(function (u) { return u[field] && String(u[field]) === String(id) && u.role !== 'admin'; })[0] || null;
}

function usernameTaken(list, name, exceptId) {
    var lower = String(name).toLowerCase();
    var adminName = String(process.env.ADMIN_USERNAME || '').toLowerCase();
    if (RESERVED.indexOf(lower) !== -1 || (adminName && lower === adminName)) return true;
    return list.some(function (u) { return u.id !== exceptId && String(u.username || '').toLowerCase() === lower; });
}

function validateCredentials(username, password) {
    if (!USERNAME_RE.test(username)) return 'username_invalid';
    if (typeof password !== 'string' || password.length < PASSWORD_MIN || password.length > PASSWORD_MAX || password !== password.trim()) {
        return 'password_invalid';
    }
    return '';
}

/* Durasi dan batas perangkat pilihan pendaftar. Tanpa isian: durasi tanpa batas dan FREE_DEVICE_LIMIT perangkat.
   Mengembalikan { deviceLimit, durationMs, durationLabel } atau { reason }. */
function readTerms(body) {
    var limit = FREE_DEVICE_LIMIT;
    if (body.deviceLimit !== undefined && body.deviceLimit !== null) {
        if (DEVICE_CHOICES.indexOf(body.deviceLimit) === -1) return { reason: 'device_invalid' };
        limit = body.deviceLimit;
    }

    var unit = typeof body.durationUnit === 'string' ? body.durationUnit : 'unlimited';
    if (unit === 'unlimited') return { deviceLimit: limit, durationMs: null, durationLabel: 'UNLIMITED' };

    var value = body.durationValue;
    if (!Object.prototype.hasOwnProperty.call(DURATION_UNITS, unit) || !Number.isInteger(value) || value < 1) return { reason: 'duration_invalid' };
    var ms = value * DURATION_UNITS[unit];
    if (ms < DURATION_MIN_MS || ms > DURATION_MAX_MS) return { reason: 'duration_invalid' };
    return { deviceLimit: limit, durationMs: ms, durationLabel: value + ' ' + DURATION_LABELS[unit] };
}

/* Usulan username dari nama depan (bukan email, supaya alamat email tidak bocor ke Chat Global): hanya huruf
   kecil & angka, lalu 4 angka acak sampai tidak bentrok. Pemilik akun bebas menggantinya. */
function suggestUsername(list, identity) {
    var raw = String(identity.name || identity.label || '').split(/[\s@]/)[0].toLowerCase()
        .normalize('NFKD').replace(/[^a-z0-9]/g, '').slice(0, 12);
    var base = raw.length >= 3 ? raw : 'user';
    for (var i = 0; i < 50; i++) {
        var cand = base + String(1000 + Math.floor(Math.random() * 9000));
        if (!usernameTaken(list, cand)) return cand;
    }
    return base + Date.now().toString(36);
}

/* ---------- bukti identitas ---------- */

function errorCode(e) {
    var m = String((e && e.message) || '');
    return /^(GOOGLE_NOT_CONFIGURED|GOOGLE_CERT_FETCH_FAILED|GITHUB_NOT_CONFIGURED|GITHUB_FETCH_FAILED)$/.test(m) ? m : 'INVALID_IDENTITY';
}

/* Mengembalikan { provider, id, label, email, name } atau melempar Error (lihat errorCode). */
async function resolveIdentity(req, body) {
    if (body.provider === 'google') {
        var g = await googleAuth.verifyIdToken(body.credential);
        return { provider: 'google', id: g.sub, label: g.email, email: g.email, name: g.givenName || g.name };
    }
    if (body.provider === 'github') {
        var host = req.headers && (req.headers['x-forwarded-host'] || req.headers.host);
        if (!githubAuth.redirectUriAllowed(body.redirectUri, String(host || '').split(',')[0].trim())) throw new Error('INVALID_IDENTITY');
        var h = await githubAuth.exchangeCode(body.code, String(body.redirectUri));
        return { provider: 'github', id: h.id, label: h.login, email: h.email, name: h.name || h.login };
    }
    throw new Error('INVALID_IDENTITY');
}

/* Balasan standar kalau bukti identitas gagal. Salah bukti dihitung sebagai percobaan gagal (rate limit). */
async function identityFailed(req, res, e) {
    var code = errorCode(e);
    if (code === 'INVALID_IDENTITY') {
        await db.registerLoginFail(RATE_PATH, req);
        res.status(200).json({ ok: false, reason: 'identity_invalid' });
    } else {
        res.status(200).json({ ok: false, error: true, code: code });
    }
}

/* Batasi pembuatan akun / permintaan per IP supaya tidak bisa dipakai membanjiri HIDZADMIN. */
async function createSlotFree(req, kind) {
    var key = CREATE_PATH + '/' + kind + '_' + db.callerKey(req);
    var rec = await db.fetchPath(key);
    var now = Date.now();
    if (rec && typeof rec.start === 'number' && now - rec.start < CREATE_WINDOW_MS && rec.count >= CREATE_MAX[kind]) {
        return { blocked: true, retryAfterSec: Math.ceil((rec.start + CREATE_WINDOW_MS - now) / 1000) };
    }
    return { blocked: false, key: key, rec: rec };
}

async function createSlotTake(slot) {
    var now = Date.now();
    var rec = slot.rec;
    var fresh = !rec || typeof rec.start !== 'number' || now - rec.start >= CREATE_WINDOW_MS;
    await db.setPath(slot.key, { start: fresh ? now : rec.start, count: fresh ? 1 : (rec.count || 0) + 1 });
}

async function tokenFor(account) {
    return firebaseAuth.createCustomToken(account.id, { role: account.role || 'user' });
}

/* ---------- 1. sso-begin ---------- */

async function handleBegin(req, res) {
    var body = req.body || {};
    var limit = await db.checkLoginRateLimit(RATE_PATH, req);
    if (limit.blocked) { res.status(200).json({ ok: false, locked: true, retryAfterSec: limit.retryAfterSec }); return; }

    var identity;
    try { identity = await resolveIdentity(req, body); }
    catch (e) { await identityFailed(req, res, e); return; }

    var list = await db.fetchAllAccounts();
    if (list === null) { res.status(200).json({ ok: false, error: true }); return; }
    await db.clearLoginRateLimit(RATE_PATH, req);

    var found = findByIdentity(list, identity.provider, identity.id);
    if (found) {
        var token = ssoToken.sign('recover', { acc: found.id, prov: identity.provider, id: identity.id }, RECOVER_TTL_SEC);
        if (!token) { res.status(200).json({ ok: false, error: true }); return; }
        var requests = await db.fetchPath(REQUESTS_PATH);
        var latest = null;
        Object.keys(requests && typeof requests === 'object' ? requests : {}).forEach(function (k) {
            var r = requests[k];
            if (r && r.accountId === found.id && (!latest || (r.createdAt || 0) > (latest.createdAt || 0))) latest = r;
        });
        res.status(200).json({
            ok: true,
            status: 'registered',
            provider: identity.provider,
            label: identity.label,
            username: found.username,
            recoverToken: token,
            request: latest ? publicRequest(latest) : null
        });
        return;
    }

    var setup = ssoToken.sign('setup', { prov: identity.provider, id: identity.id, label: identity.label, email: identity.email || '' }, SETUP_TTL_SEC);
    if (!setup) { res.status(200).json({ ok: false, error: true }); return; }
    res.status(200).json({
        ok: true,
        status: 'new',
        provider: identity.provider,
        label: identity.label,
        suggestedUsername: suggestUsername(list, identity),
        setupToken: setup
    });
}

/* ---------- 2. sso-register ---------- */

async function handleRegister(req, res) {
    var body = req.body || {};
    var setup = ssoToken.verify(body.setupToken, 'setup');
    if (!setup || !PROVIDERS[setup.prov]) { res.status(200).json({ ok: false, reason: 'setup_expired' }); return; }

    var username = typeof body.username === 'string' ? body.username.trim() : '';
    var password = typeof body.password === 'string' ? body.password : '';
    var invalid = validateCredentials(username, password);
    if (invalid) { res.status(200).json({ ok: false, reason: invalid }); return; }
    var terms = readTerms(body);
    if (terms.reason) { res.status(200).json({ ok: false, reason: terms.reason }); return; }

    var slot = await createSlotFree(req, 'register');
    if (slot.blocked) { res.status(200).json({ ok: false, locked: true, retryAfterSec: slot.retryAfterSec }); return; }

    /* Hash dihitung di luar mutator (scrypt mahal, mutator bisa terpanggil ulang kalau ada bentrok). */
    var hashed = pw.hashPassword(password);
    var fields = PROVIDERS[setup.prov];

    var out = await db.mutateAccounts(function (list) {
        var existing = findByIdentity(list, setup.prov, setup.id);
        if (existing) return { save: false, result: { ok: false, reason: 'identity_taken', username: existing.username } };
        if (usernameTaken(list, username)) return { save: false, result: { ok: false, reason: 'username_taken' } };

        var now = Date.now();
        while (list.some(function (u) { return u.id === 'u_' + now; })) now++;
        var fresh = {
            id:            'u_' + now,
            username:      username,
            password:      hashed,
            role:          'user',
            createdAt:     now,
            createdBy:     null,
            expiresAt:     null,
            durationMs:    terms.durationMs,
            durationLabel: terms.durationLabel,
            deviceLimit:   terms.deviceLimit,
            /* Durasi terbatas mulai dihitung saat login pertama (complete-login), sama seperti akun buatan admin. */
            activated:     terms.durationMs === null,
            logoutAt:      null,
            loginAt:       null,
            loggedOut:     false,
            authProvider:  setup.prov
        };
        fresh[fields.idField] = String(setup.id);
        fresh[fields.labelField] = String(setup.label || '');
        if (setup.prov === 'github' && setup.email) fresh.githubEmail = String(setup.email);
        list.push(fresh);
        return { save: true, result: { ok: true, account: fresh } };
    });

    if (!out.ok || !out.result) { res.status(200).json({ ok: false, error: true }); return; }
    if (!out.result.ok) { res.status(200).json(out.result); return; }

    await createSlotTake(slot);
    var account = out.result.account;
    await notifSeed.seedNewAccount(account.id);

    var token;
    try { token = await tokenFor(account); }
    catch (e) { res.status(503).json({ ok: false, error: true, code: 'FIREBASE_AUTH_CONFIG' }); return; }
    res.status(200).json({ ok: true, firebaseToken: token, account: publicAccount(account), created: true });
}

/* ---------- 3. cred-request ---------- */

async function handleCredRequest(req, res) {
    var body = req.body || {};
    var proof = ssoToken.verify(body.recoverToken, 'recover');
    if (!proof || !PROVIDERS[proof.prov]) { res.status(200).json({ ok: false, reason: 'proof_expired' }); return; }

    var username = typeof body.username === 'string' ? body.username.trim() : '';
    var password = typeof body.password === 'string' ? body.password : '';
    var invalid = validateCredentials(username, password);
    if (invalid) { res.status(200).json({ ok: false, reason: invalid }); return; }

    var slot = await createSlotFree(req, 'request');
    if (slot.blocked) { res.status(200).json({ ok: false, locked: true, retryAfterSec: slot.retryAfterSec }); return; }

    var list = await db.fetchAllAccounts();
    if (list === null) { res.status(200).json({ ok: false, error: true }); return; }
    var me = list.filter(function (u) { return u.id === proof.acc; })[0];
    /* Identitasnya harus masih dipegang akun ini (bukti lama tidak berlaku kalau akunnya sudah dihapus). */
    if (!me || me.role === 'admin' || String(me[PROVIDERS[proof.prov].idField] || '') !== String(proof.id)) {
        res.status(200).json({ ok: false, reason: 'proof_expired' });
        return;
    }
    if (usernameTaken(list, username, me.id)) { res.status(200).json({ ok: false, reason: 'username_taken' }); return; }

    var now = Date.now();
    var id = 'r_' + now + '_' + crypto.randomBytes(4).toString('hex');
    var secret = ssoToken.randomSecret();
    var record = {
        id:              id,
        accountId:       me.id,
        username:        me.username,
        newUsername:     username,
        newPasswordHash: pw.hashPassword(password),
        provider:        proof.prov,
        label:           String(me[PROVIDERS[proof.prov].labelField] || ''),
        status:          'pending',
        createdAt:       now,
        claimHash:       ssoToken.digest(secret)
    };

    /* Satu permintaan menunggu per akun: yang lama digantikan. Catatan yang sudah lama diputuskan dibuang. */
    var all = await db.fetchPath(REQUESTS_PATH);
    var writes = {};
    Object.keys(all && typeof all === 'object' ? all : {}).forEach(function (k) {
        var r = all[k];
        if (!r || typeof r !== 'object') return;
        if (r.accountId === me.id && r.status === 'pending') writes[k] = null;
        else if (r.status !== 'pending' && now - (r.decidedAt || r.createdAt || 0) > DECIDED_KEEP_MS) writes[k] = null;
    });
    writes[id] = record;
    if (!(await db.updatePath(REQUESTS_PATH, writes))) { res.status(200).json({ ok: false, error: true }); return; }

    await createSlotTake(slot);
    res.status(200).json({ ok: true, request: Object.assign(publicRequest(record), { secret: secret }) });
}

/* ---------- 4. sso-status ---------- */

function sameDigest(secret, hash) {
    if (typeof secret !== 'string' || typeof hash !== 'string' || !secret || secret.length > 200) return false;
    var a = Buffer.from(ssoToken.digest(secret), 'hex'), b = Buffer.from(hash, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function statusOne(item, accounts) {
    var id = item && typeof item.id === 'string' && /^r_[0-9]{10,16}_[0-9a-f]{8}$/.test(item.id) ? item.id : '';
    if (!id) return { id: String((item && item.id) || ''), status: 'unknown' };
    var rec = await db.fetchPath(REQUESTS_PATH + '/' + id);
    if (!rec || !sameDigest(item.secret, rec.claimHash)) return { id: id, status: 'unknown' };

    var base = publicRequest(rec);
    if (rec.status !== 'approved') return base;

    var acc = accounts.filter(function (u) { return u.id === rec.accountId; })[0];
    var fresh = !!rec.decidedAt && Date.now() - rec.decidedAt <= CLAIM_WINDOW_MS;
    /* Masuk otomatis hanya kalau akunnya masih persis seperti yang disetujui (belum diubah lagi sesudahnya). */
    if (!acc || !fresh || acc.username !== rec.newUsername || acc.password !== rec.newPasswordHash) {
        return Object.assign(base, { claimExpired: true });
    }
    try {
        return Object.assign(base, { firebaseToken: await tokenFor(acc), account: publicAccount(acc) });
    } catch (e) {
        return Object.assign(base, { claimExpired: true });
    }
}

async function handleStatus(req, res) {
    var items = Array.isArray((req.body || {}).requests) ? req.body.requests.slice(0, 5) : [];
    var accounts = await db.fetchAllAccounts();
    if (accounts === null) { res.status(200).json({ ok: false, error: true }); return; }
    var results = [];
    for (var i = 0; i < items.length; i++) results.push(await statusOne(items[i], accounts));
    res.status(200).json({ ok: true, results: results });
}

/* ---------- 5. sso-link ---------- */

/* Hubungkan Google/GitHub ke akun yang sedang login. Dua bukti dibutuhkan sekaligus: token Firebase (dia
   memang pemilik akun HIDZPROJECT ini) dan bukti dari Google/GitHub (dia memang pemilik akun itu). */
async function handleLink(req, res) {
    var uid = await firebaseAuth.uidFromRequest(req);
    if (!uid || uid === ADMIN_ID) { res.status(200).json({ ok: false, reason: 'auth_required' }); return; }

    var body = req.body || {};
    var identity;
    try { identity = await resolveIdentity(req, body); }
    catch (e) {
        var code = errorCode(e);
        res.status(200).json(code === 'INVALID_IDENTITY' ? { ok: false, reason: 'identity_invalid' } : { ok: false, error: true, code: code });
        return;
    }
    var fields = PROVIDERS[identity.provider];

    var out = await db.mutateAccounts(function (list) {
        var me = list.filter(function (u) { return u.id === uid && u.role !== 'admin'; })[0];
        if (!me) return { save: false, result: { ok: false, reason: 'not_found' } };

        var owner = findByIdentity(list, identity.provider, identity.id);
        if (owner && owner.id !== me.id) return { save: false, result: { ok: false, reason: 'identity_taken' } };
        if (me[fields.idField] && String(me[fields.idField]) !== String(identity.id)) return { save: false, result: { ok: false, reason: 'already_linked' } };
        if (String(me[fields.idField] || '') === String(identity.id) && me[fields.labelField] === identity.label) {
            return { save: false, result: { ok: true, provider: identity.provider, label: identity.label } };
        }

        me[fields.idField] = String(identity.id);
        me[fields.labelField] = identity.label;
        if (identity.provider === 'github' && identity.email) me.githubEmail = identity.email;
        return { save: true, result: { ok: true, provider: identity.provider, label: identity.label } };
    });

    res.status(200).json(out.ok && out.result ? out.result : { ok: false, error: true });
}

/* ---------- pintu masuk ---------- */

/* Dipanggil dari /api/login (setelah gerbang Turnstile). Mengembalikan true kalau action-nya milik file ini. */
async function handleLogin(action, req, res) {
    if (action === 'sso-begin') { await handleBegin(req, res); return true; }
    if (action === 'sso-register') { await handleRegister(req, res); return true; }
    if (action === 'cred-request') { await handleCredRequest(req, res); return true; }
    return false;
}

/* Dipanggil dari /api/check-session?vipAction=... (sso-status, sso-link). */
async function handleAction(action, req, res) {
    if (req.method !== 'POST') { res.status(200).json({ ok: false }); return; }
    if (action === 'sso-status') { await handleStatus(req, res); return; }
    if (action === 'sso-link') { await handleLink(req, res); return; }
    res.status(200).json({ ok: false });
}

module.exports = {
    handleLogin: handleLogin,
    handleAction: handleAction,
    publicAccount: publicAccount,
    REQUESTS_PATH: REQUESTS_PATH
};
