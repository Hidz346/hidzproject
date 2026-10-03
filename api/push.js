/* Langganan notifikasi Chrome (Web Push) milik device pengunjung.

   Satu endpoint untuk tiga aksi, supaya jumlah Serverless Function di paket
   Hobby cuma bertambah satu:

     { action: 'key' }
       -> kunci publik VAPID, dibutuhkan browser untuk membuat langganan.

     { action: 'subscribe', deviceId, subscription }   (wajib Firebase ID token)
       -> simpan langganan device ini di bawah akun yang sedang login.

     { action: 'unsubscribe', userId, deviceId, endpoint }
       -> hapus langganan device ini (dipanggil saat logout manual). Tidak
          butuh token karena sesinya sudah hampir ditutup; sebagai gantinya
          alamat endpoint-nya harus cocok dengan yang tersimpan — alamat itu
          panjang & acak, cuma diketahui browser pemiliknya.

   Datanya ada di hidz_push_subs/{userId}/{deviceId} dan HANYA bisa dibaca
   server (rules dikunci). Pengirimannya sendiri dilakukan HidzAdmin lewat
   api/_lib/push.js saat admin mereset password, menambah durasi,
   menyalakan maintenance, atau mengabari ada project baru. */

var db = require('./_lib/db');
var firebaseAuth = require('./_lib/firebase-auth');
var securityGuard = require('./_lib/security');

var SUBS_PATH = 'hidz_push_subs';

/* Cukup longgar untuk id akun & device yang dibuat aplikasi ini, tapi tidak
   mengizinkan karakter yang punya arti khusus di path Firebase (. # $ [ ] /). */
var ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/* Batas wajar jumlah device per akun — mencegah satu akun mengisi database
   dengan langganan palsu. */
var MAX_DEVICES_PER_USER = 10;

/* Hanya layanan push milik browser besar. Server HidzAdmin menembak alamat
   ini saat mengirim notifikasi, jadi alamat sembarang tidak boleh disimpan.
   Daftar yang sama dipakai ulang di HidzAdmin/api/_lib/push.js. */
var PUSH_HOST_SUFFIXES = [
    '.googleapis.com',
    '.push.services.mozilla.com',
    '.push.apple.com',
    '.notify.windows.com'
];

function isAllowedEndpoint(endpoint) {
    if (typeof endpoint !== 'string' || endpoint.length > 1000) return false;
    var url;
    try { url = new URL(endpoint); } catch (e) { return false; }
    if (url.protocol !== 'https:') return false;
    return PUSH_HOST_SUFFIXES.some(function (suffix) {
        return url.hostname.length > suffix.length && url.hostname.slice(-suffix.length) === suffix;
    });
}

/* Ambil hanya field yang dibutuhkan dari objek langganan kiriman browser. */
function cleanSubscription(raw) {
    if (!raw || typeof raw !== 'object' || !isAllowedEndpoint(raw.endpoint)) return null;
    var keys = raw.keys;
    if (!keys || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') return null;
    if (keys.p256dh.length > 200 || keys.auth.length > 100) return null;
    return { endpoint: raw.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } };
}

module.exports = async function (req, res) {
    if (!(await securityGuard.guard(req, res))) return;
    if (req.method !== 'POST') {
        res.status(200).json({ ok: false });
        return;
    }

    var body     = req.body || {};
    var action   = typeof body.action === 'string' ? body.action : '';
    var deviceId = typeof body.deviceId === 'string' ? body.deviceId : '';

    if (action === 'key') {
        var publicKey = process.env.VAPID_PUBLIC_KEY || '';
        res.status(200).json(publicKey ? { ok: true, publicKey: publicKey } : { ok: false, reason: 'not_configured' });
        return;
    }

    if (!ID_PATTERN.test(deviceId)) {
        res.status(200).json({ ok: false });
        return;
    }

    if (action === 'subscribe') {
        var claims;
        try {
            claims = await firebaseAuth.verifyIdToken(firebaseAuth.bearerToken(req));
        } catch (e) {
            res.status(401).json({ ok: false, error: 'AUTH_REQUIRED' });
            return;
        }

        var userId = claims.user_id || claims.sub;
        var sub    = cleanSubscription(body.subscription);
        if (!ID_PATTERN.test(String(userId || '')) || !sub) {
            res.status(200).json({ ok: false });
            return;
        }

        var existing = await db.fetchPath(SUBS_PATH + '/' + userId);
        if (existing && typeof existing === 'object' && !existing[deviceId] &&
            Object.keys(existing).length >= MAX_DEVICES_PER_USER) {
            res.status(200).json({ ok: false, reason: 'too_many_devices' });
            return;
        }

        var saved = await db.setPath(SUBS_PATH + '/' + userId + '/' + deviceId, {
            endpoint: sub.endpoint,
            keys:     sub.keys,
            savedAt:  Date.now()
        });
        res.status(200).json({ ok: saved });
        return;
    }

    if (action === 'unsubscribe') {
        var ownerId  = typeof body.userId === 'string' ? body.userId : '';
        var endpoint = typeof body.endpoint === 'string' ? body.endpoint : '';
        if (!ID_PATTERN.test(ownerId) || !endpoint) {
            res.status(200).json({ ok: false });
            return;
        }

        var path   = SUBS_PATH + '/' + ownerId + '/' + deviceId;
        var stored = await db.fetchPath(path);
        if (stored && stored.endpoint === endpoint) await db.deletePath(path);

        /* Sengaja selalu "ok": tidak membocorkan apakah langganan itu ada. */
        res.status(200).json({ ok: true });
        return;
    }

    res.status(200).json({ ok: false });
};
