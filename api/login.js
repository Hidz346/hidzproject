/* Login terpusat untuk hidzproject.html — menggantikan cara lama yang
   nyocokin username/password ke daftar akun yang di-download penuh ke
   browser (itu sebabnya seluruh isi hidz_access_db, termasuk password
   semua akun VIP/USER, ikut kebaca siapa pun yang buka DevTools begitu
   halaman login dibuka — bahkan sebelum sempat login sama sekali).

   Sekarang:
   - Kredensial ADMIN dicek dari Environment Variable (gak pernah di Firebase).
   - Kredensial VIP/USER dicek di sini, di server, pakai Firebase Database
     Secret (FIREBASE_DB_SECRET) — browser cuma dikirimin HASIL cocok/tidak
     plus data akun yang berhasil login, bukan seluruh daftarnya. */

var db = require('./_lib/db');

module.exports = async function (req, res) {
    if (req.method !== 'POST') {
        res.status(200).json({ ok: false });
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
        if (list[i].username.toLowerCase() === username.toLowerCase() && list[i].password === password) {
            found = list[i];
            break;
        }
    }

    if (!found) {
        res.status(200).json({ ok: false });
        return;
    }

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
