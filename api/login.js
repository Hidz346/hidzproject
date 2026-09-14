/* Login terpusat untuk hidzproject.html — menggantikan cara lama yang
   nyocokin username/password ke daftar akun yang di-download penuh ke
   browser (itu sebabnya seluruh isi hidz_access_db, termasuk password
   semua akun VIP/USER, ikut kebaca siapa pun yang buka DevTools begitu
   halaman login dibuka — bahkan sebelum sempat login sama sekali).

   Sekarang:
   - Kredensial ADMIN dicek dari Environment Variable (gak pernah di Firebase).
   - Kredensial VIP/USER dicek di sini, di server, pakai Firebase Database
     Secret (FIREBASE_DB_SECRET) — browser cuma dikirimin HASIL cocok/tidak
     plus data akun yang berhasil login, bukan seluruh daftarnya.
   - Percobaan gagal beruntun dicatat per-IP di server (bukan cuma di
     localStorage browser), jadi script yang nembak endpoint ini langsung
     tanpa lewat form login sama sekali tetap kena kunci. */

var db = require('./_lib/db');
var RATE_PATH = 'hidz_login_rate_limit';

module.exports = async function (req, res) {
    if (req.method !== 'POST') {
        res.status(200).json({ ok: false });
        return;
    }

    var limit = await db.checkLoginRateLimit(RATE_PATH, req);
    if (limit.blocked) {
        res.status(200).json({ ok: false, locked: true, retryAfterSec: limit.retryAfterSec });
        return;
    }

    var body     = req.body || {};
    var username = typeof body.username === 'string' ? body.username.trim() : '';
    var password = typeof body.password === 'string' ? body.password : '';

    if (!username || !password) {
        res.status(200).json({ ok: false });
        return;
    }

    /* -- Cek admin dulu, gak perlu nyentuh Firebase sama sekali -- */
    var adminUser = process.env.ADMIN_USERNAME || '';
    var adminPass = process.env.ADMIN_PASSWORD || '';
    if (adminUser && adminPass &&
        username.toLowerCase() === adminUser.toLowerCase() &&
        password === adminPass) {
        await db.clearLoginRateLimit(RATE_PATH, req);
        res.status(200).json({
            ok: true,
            account: {
                id:            'admin_hidz_protected',
                username:      username,
                role:          'admin',
                createdAt:     Date.now(),
                expiresAt:     null,
                durationMs:    null,
                durationLabel: 'UNLIMITED',
                deviceLimit:   1,
                logoutAt:      null
            }
        });
        return;
    }

    /* -- Bukan admin -> cek akun VIP/USER lewat Database Secret -- */
    var list = await db.fetchAllAccounts();
    if (list === null) {
        res.status(200).json({ ok: false, error: true });
        return;
    }

    var found = null;
    for (var i = 0; i < list.length; i++) {
        /* Admin CUMA boleh lolos lewat env var di atas — sengaja dilewati di
           sini walau kebetulan masih ada record lama berrole admin nyangkut
           di database (mis. sisa sebelum dipindah ke env var), supaya
           password lama yang mungkin masih nempel di situ gak pernah lagi
           bisa dipakai buat masuk. */
        if (list[i].role === 'admin') continue;
        if (list[i].username.toLowerCase() === username.toLowerCase() && list[i].password === password) {
            found = list[i];
            break;
        }
    }

    if (!found) {
        await db.registerLoginFail(RATE_PATH, req);
        res.status(200).json({ ok: false });
        return;
    }
    await db.clearLoginRateLimit(RATE_PATH, req);

    /* Password TIDAK ikut dikirim balik — browser yang minta login sudah
       tahu password itu sendiri (baru saja diketik), jadi gak perlu
       dikirim ulang lewat jaringan. durationMs WAJIB ikut dikirim karena
       dipakai buat hitung expiresAt begitu akun ini pertama kali login
       (lihat _completeLogin di hidzproject.html). */
    res.status(200).json({
        ok: true,
        account: {
            id:            found.id,
            username:      found.username,
            role:          found.role || 'user',
            createdAt:     found.createdAt || Date.now(),
            createdBy:     found.createdBy || null,
            expiresAt:     found.expiresAt || null,
            durationMs:    (typeof found.durationMs === 'number') ? found.durationMs : null,
            durationLabel: found.durationLabel || 'UNLIMITED',
            deviceLimit:   found.deviceLimit || 1,
            activated:     found.activated,
            logoutAt:      found.logoutAt || null
        }
    });
};
