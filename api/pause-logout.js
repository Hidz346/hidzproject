/**
 * POST /api/pause-logout
 *
 * Logout manual (tombol LOGOUT di halaman profil) — pause durasi & tandai
 * akun logout, dijalankan sepenuhnya di server (Vercel Serverless Function)
 * lewat Firebase Admin SDK.
 *
 * Kenapa ini penting: sebelumnya, _pauseAndLogout() di hidzproject.html
 * menjalankan firebase.database().ref('hidz_access_db').transaction(...)
 * langsung dari browser. Supaya bisa menjalankan transaction, SDK client
 * Firebase perlu membaca dulu SELURUH isi hidz_access_db (termasuk password
 * semua user lain) ke memori browser — sekejap saja, tapi tetap sempat lewat
 * ke perangkat orang yang sedang logout itu sebelum ditulis ulang. Endpoint
 * ini memindahkan transaction itu ke server — browser cuma kirim id akun
 * miliknya sendiri, tanpa pernah menerima data user lain sama sekali.
 *
 * PENTING: id SAJA tidak cukup untuk membuktikan kepemilikan akun (id bukan
 * rahasia). Makanya endpoint ini juga mewajibkan password akun tersebut ikut
 * dikirim & dicocokkan di server dulu sebelum akun di-pause/logout-kan —
 * supaya orang lain yang kebetulan tahu id-nya saja tidak bisa memaksa
 * logout akun tersebut.
 *
 * Sama seperti versi lama: durasi TERBATAS disimpan sebagai SISA waktu
 * (durationMs, bukan durasi penuh semula) supaya saat login lagi nanti
 * melanjutkan dari sisa waktu ini — TIDAK mengulang dari awal. Akun
 * UNLIMITED cukup ditandai belum aktif tanpa hitungan durasi.
 *
 * Body: { id: string, password: string }
 * Response: { ok: boolean }
 *
 * Pakai env var yang sama dengan /api/login.js (FIREBASE_PROJECT_ID,
 * FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY) — tidak perlu setup tambahan
 * kalau /api/login.js sudah jalan.
 */

const admin = require('firebase-admin');

const DB_KEY = 'hidz_access_db';
const DATABASE_URL =
    process.env.FIREBASE_DATABASE_URL ||
    'https://hidzproject-8f335-default-rtdb.asia-southeast1.firebasedatabase.app';

function getAdminApp() {
    if (admin.apps.length) return admin.app();

    const privateKey = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

    return admin.initializeApp({
        credential: admin.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: privateKey
        }),
        databaseURL: DATABASE_URL
    });
}

/* ---- Terapkan perubahan "pause & logout" ke SATU array user, HANYA kalau
   password-nya cocok. Return 'ok' | 'wrong-password' | 'not-found'. ---- */
function applyPauseLogout(list, id, password, now) {
    for (var i = 0; i < list.length; i++) {
        var u = list[i];
        if (u && u.id === id) {
            if (u.password !== password) return 'wrong-password';
            if (u.activated === true) {
                if (u.expiresAt) {
                    /* Simpan SISA durasi (bukan durasi penuh semula) */
                    u.durationMs = Math.max(0, u.expiresAt - now);
                }
                u.expiresAt  = null;
                u.activated  = false;
                u.logoutAt   = now;
                u.loggedOut  = true;
            }
            return 'ok';
        }
    }
    return 'not-found';
}

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ ok: false, message: 'Method not allowed' });
    }

    const body = req.body || {};
    const id = typeof body.id === 'string' ? body.id : '';
    const password = typeof body.password === 'string' ? body.password : '';

    if (!id || !password) {
        return res.status(400).json({ ok: false, message: 'id & password wajib diisi.' });
    }

    try {
        getAdminApp();
        const dbRef = admin.database().ref(DB_KEY);
        const now = Date.now();

        var result = 'not-found';

        const txResult = await dbRef.transaction(function (currentData) {
            if (currentData === null || currentData === undefined) return currentData;
            var list = Array.isArray(currentData) ? currentData : Object.keys(currentData).map(function (k) { return currentData[k]; });
            result = applyPauseLogout(list, id, password, now);
            return Array.isArray(currentData) ? list : currentData;
        });

        if (result === 'wrong-password') {
            return res.status(401).json({ ok: false, message: 'Password tidak cocok.' });
        }

        if (!txResult.committed) {
            return res.status(503).json({ ok: false, message: 'Gagal menyimpan status logout.' });
        }

        return res.status(200).json({ ok: true });

    } catch (err) {
        console.error('[api/pause-logout] gagal proses logout:', err);
        return res.status(500).json({ ok: false, message: 'Terjadi kesalahan di server.' });
    }
};
