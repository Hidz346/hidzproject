/* Helper bersama buat semua endpoint di /api yang perlu baca/tulis
   database akun (hidz_access_db). Satu tempat saja yang tahu cara ngomong
   ke Firebase pakai Database Secret, biar gak ditulis ulang di tiap file.
   Nama folder diawali underscore supaya Vercel gak menganggapnya sebagai
   endpoint sendiri — ini murni file bantu. */

var DB_URL = 'https://hidzproject-8f335-default-rtdb.asia-southeast1.firebasedatabase.app';

function authQS() {
    var secret = process.env.FIREBASE_DB_SECRET || '';
    return secret ? ('?auth=' + secret) : null;
}

/* Ambil nilai mentah dari path mana pun di database. null = secret belum
   diset / gagal konek. */
async function fetchPath(path) {
    var qs = authQS();
    if (!qs) return null;
    try {
        var r = await fetch(DB_URL + '/' + path + '.json' + qs);
        return await r.json();
    } catch (e) {
        return null;
    }
}

/* Timpa nilai di path mana pun. */
async function setPath(path, value) {
    var qs = authQS();
    if (!qs) return false;
    try {
        var r = await fetch(DB_URL + '/' + path + '.json' + qs, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(value)
        });
        return r.ok;
    } catch (e) {
        return false;
    }
}

/* Hapus path mana pun. */
async function deletePath(path) {
    var qs = authQS();
    if (!qs) return false;
    try {
        var r = await fetch(DB_URL + '/' + path + '.json' + qs, { method: 'DELETE' });
        return r.ok;
    } catch (e) {
        return false;
    }
}

/* Ambil seluruh daftar akun (VIP/USER/admin lama). null = secret belum
   diset / gagal konek, [] = memang kosong. */
async function fetchAllAccounts() {
    var data = await fetchPath('hidz_access_db');
    if (data === null) return null;
    return cleanAccounts(data);
}

/* Daftar akun versi "bersih": entri kosong / tanpa username dibuang. Dipakai
   bareng oleh fetchAllAccounts() dan mutateAccounts() supaya hasilnya sama. */
function cleanAccounts(data) {
    if (Array.isArray(data)) return data.filter(function (u) { return u && u.username; });
    if (data && typeof data === 'object') return Object.values(data).filter(function (u) { return u && u.username; });
    return [];
}

var MUTATE_MAX_ATTEMPTS = 10;

function pause(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

/* Baca-ubah-tulis daftar akun SECARA ATOMIK. Semua endpoint yang mengubah
   hidz_access_db harus lewat sini, bukan fetchAllAccounts() + saveAllAccounts()
   terpisah — kalau dua request jalan bersamaan (mis. admin membuat akun saat
   user lain login pertama kali), yang menulis belakangan akan menimpa
   perubahan yang menulis duluan, dan akun bisa hilang atau aktivasi
   login-nya terbuang.

   Caranya pakai conditional request bawaan Firebase REST: GET dengan header
   X-Firebase-ETag mengembalikan ETag data saat dibaca, lalu PUT dengan
   if-match hanya diterima kalau data belum berubah sejak itu. Kalau sudah
   berubah, Firebase menjawab 412 dan kita ulangi dari baca. Hasilnya sama
   dengan transaction() yang dulu dipakai langsung dari browser.

   mutator(list) menerima daftar akun terbaru dan mengubahnya di tempat
   (atau mengembalikan `list` baru), lalu mengembalikan:
     { save: true,  result: ... }  -> daftar ditulis
     { save: false, result: ... }  -> tidak ada yang ditulis (validasi gagal, dll)
   mutator bisa terpanggil lebih dari sekali kalau terjadi bentrok, jadi
   jangan taruh efek samping (tulis ke tempat lain, hitung hash mahal) di
   dalamnya — kerjakan dulu di luar.

   Balikan: { ok: true, result } kalau selesai, { ok: false } kalau secret
   belum diset / gagal konek / bentrok terus sampai kehabisan percobaan. */
async function mutateAccounts(mutator) {
    var qs = authQS();
    if (!qs) return { ok: false };
    var url = DB_URL + '/hidz_access_db.json' + qs;

    for (var attempt = 0; attempt < MUTATE_MAX_ATTEMPTS; attempt++) {
        var etag = null;
        var data = null;
        try {
            var r = await fetch(url, { headers: { 'X-Firebase-ETag': 'true' } });
            if (!r.ok) return { ok: false };
            etag = r.headers.get('etag');
            data = await r.json();
        } catch (e) {
            return { ok: false };
        }

        var list = cleanAccounts(data);
        var out = mutator(list);
        if (!out || !out.save) return { ok: true, result: out ? out.result : undefined };

        var headers = { 'Content-Type': 'application/json' };
        if (etag) headers['if-match'] = etag;
        try {
            var w = await fetch(url, { method: 'PUT', headers: headers, body: JSON.stringify(out.list || list) });
            if (w.ok) return { ok: true, result: out.result };
            if (w.status !== 412) return { ok: false };
        } catch (e) {
            return { ok: false };
        }

        /* Bentrok dengan penulis lain — jeda acak yang makin lebar tiap
           percobaan, supaya request yang bentrok bersamaan tidak mengulang
           di saat yang sama lagi dan semuanya akhirnya kebagian giliran. */
        await pause(Math.floor(Math.random() * Math.min(600, 40 * Math.pow(2, attempt))));
    }
    return { ok: false };
}

/* Timpa seluruh daftar akun dengan array baru, TANPA cek bentrok. Untuk
   mengubah akun pakai mutateAccounts() di atas — fungsi ini bisa menimpa
   perubahan lain yang masuk di saat yang sama. */
async function saveAllAccounts(list) {
    return setPath('hidz_access_db', list);
}

/* Bersihkan jejak akun yang sudah dihapus di node-node lain (sesi aktif,
   status banned, device yang diblokir) — sama seperti yang dilakukan
   Panel VIP & admin.html sebelumnya. */
async function removeAccountTraces(id) {
    await Promise.all([
        deletePath('hidz_sessions/' + id),
        deletePath('hidz_banned/' + id),
        deletePath('hidz_blocked_devices/' + id)
    ]);
}

var pw = require('./password');

/* Cek apakah {id, username, password} yang dikirim benar-benar akun VIP
   yang valid di dalam daftar. Dipakai tiap endpoint Panel VIP sebelum
   ngizinin baca/tulis apa pun. */
function findValidVip(list, vipId, vipUsername, vipPassword) {
    var me = list.filter(function (u) { return u.id === vipId; })[0];
    if (!me) return null;
    if (me.role !== 'vip') return null;
    if ((me.username || '').toLowerCase() !== (vipUsername || '').toLowerCase()) return null;
    if (!pw.verifyPassword(vipPassword, me.password)) return null;
    return me;
}

/* ===== RATE LIMIT LOGIN — dicatat di server, bukan cuma di browser =====
   Cooldown yang sebelumnya cuma ada di sisi client (localStorage) gampang
   dilewati siapa pun yang langsung nembak endpoint ini pakai script, tanpa
   pernah buka form login di browser sama sekali. Ini dicatat di Firebase
   berdasarkan IP pemanggil, jadi tetap kena kunci walau localStorage-nya
   dikosongin/incognito. Pola makin lama tiap terulang, sama seperti
   cooldown di sisi client, cuma sekarang beneran gak bisa dilewati. */
var RATE_LIMIT_MAX_FAILS = 5;
var RATE_LIMIT_BASE_MS   = 30000;
var RATE_LIMIT_CAP_MS    = 300000;

function callerKey(req) {
    var fwd = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    var ip  = fwd || (req.socket && req.socket.remoteAddress) || 'unknown';
    return ip.replace(/[.#$\[\]/:]/g, '_');
}

function sanitizeRateLimitKey(key) {
    return String(key).replace(/[.#$\[\]/:]/g, '_');
}

/* Versi generic — dikunci pakai key apa pun (bukan cuma IP), dipakai ulang
   sama fungsi IP-based di bawah maupun langsung buat lockout per-akun
   (mis. Panel VIP, yang diverifikasi ulang pakai vipId+password tiap
   request, jadi butuh lockout sendiri di luar cuma rate limit IP umum). */
async function checkRateLimitByKey(path, key) {
    var rec = await fetchPath(path + '/' + sanitizeRateLimitKey(key));
    if (rec && rec.lockedUntil && Date.now() < rec.lockedUntil) {
        return { blocked: true, retryAfterSec: Math.ceil((rec.lockedUntil - Date.now()) / 1000) };
    }
    return { blocked: false };
}

async function registerRateLimitFailByKey(path, key) {
    var k = sanitizeRateLimitKey(key);
    var rec = (await fetchPath(path + '/' + k)) || { fails: 0, tier: 0 };
    var fails = (rec.fails || 0) + 1;
    if (fails >= RATE_LIMIT_MAX_FAILS) {
        var tier   = rec.tier || 0;
        var lockMs = Math.min(RATE_LIMIT_BASE_MS * Math.pow(2, tier), RATE_LIMIT_CAP_MS);
        await setPath(path + '/' + k, { fails: 0, tier: tier + 1, lockedUntil: Date.now() + lockMs });
    } else {
        await setPath(path + '/' + k, { fails: fails, tier: rec.tier || 0 });
    }
}

async function clearRateLimitByKey(path, key) {
    await deletePath(path + '/' + sanitizeRateLimitKey(key));
}

/* { blocked: true, retryAfterSec } kalau IP ini lagi kena kunci,
   { blocked: false } kalau boleh lanjut cek kredensial. */
async function checkLoginRateLimit(path, req) {
    return checkRateLimitByKey(path, callerKey(req));
}

/* Panggil tiap kredensial yang dikirim TERNYATA salah. */
async function registerLoginFail(path, req) {
    return registerRateLimitFailByKey(path, callerKey(req));
}

/* Panggil tiap kredensial yang dikirim TERNYATA benar — reset hitungan
   gagal beruntun punya IP itu. */
async function clearLoginRateLimit(path, req) {
    return clearRateLimitByKey(path, callerKey(req));
}

module.exports = {
    DB_URL: DB_URL,
    fetchPath: fetchPath,
    setPath: setPath,
    deletePath: deletePath,
    fetchAllAccounts: fetchAllAccounts,
    mutateAccounts: mutateAccounts,
    saveAllAccounts: saveAllAccounts,
    removeAccountTraces: removeAccountTraces,
    findValidVip: findValidVip,
    checkLoginRateLimit: checkLoginRateLimit,
    registerLoginFail: registerLoginFail,
    clearLoginRateLimit: clearLoginRateLimit,
    checkRateLimitByKey: checkRateLimitByKey,
    registerRateLimitFailByKey: registerRateLimitFailByKey,
    clearRateLimitByKey: clearRateLimitByKey
};
