/**
 * POST /api/complete-login
 *
 * Aktivasi akun saat login pertama kali / login ulang setelah logout manual,
 * dijalankan sepenuhnya di server (Vercel Serverless Function) lewat
 * Firebase Admin SDK.
 *
 * Kenapa ini penting: sebelumnya, _completeLogin() di hidzproject.html
 * menjalankan firebase.database().ref('hidz_access_db').transaction(...)
 * langsung dari browser. Supaya bisa menjalankan transaction, SDK client
 * Firebase perlu membaca dulu SELURUH isi hidz_access_db (termasuk password
 * semua user lain) ke memori browser — sekejap saja, tapi tetap sempat lewat
 * ke perangkat orang yang baru login itu sebelum ditulis ulang. Endpoint ini
 * memindahkan transaction itu ke server — browser cuma kirim id akun
 * miliknya sendiri, dan cuma menerima balik data akun itu saja setelah
 * diaktifkan.
 *
 * PENTING: id SAJA tidak cukup untuk membuktikan kepemilikan akun (id bukan
 * rahasia — bisa saja pernah bocor lewat log, network tab, dsb). Makanya
 * endpoint ini juga mewajibkan password akun tersebut ikut dikirim & dicocokkan
 * di server sebelum mengaktifkan ATAU mengembalikan data akun manapun —
 * persis seperti syarat yang sudah dipakai /api/login.js.
 *
 * Body: { id: string, password: string }
 * Response sukses: { ok: true, user: {...} }
 *   `user` sengaja dibuat identik dengan objek akun yang dulu dipakai
 *   _finishCompleteLogin() — termasuk field `password` milik akun ini
 *   sendiri — supaya sesi & fitur "Lihat Password" tetap jalan seperti biasa.
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

        var activated = null;
        var wrongPassword = false;

        const txResult = await dbRef.transaction(function (currentData) {
            if (currentData === null || currentData === undefined) return currentData;
            var list = Array.isArray(currentData) ? currentData : Object.keys(currentData).map(function (k) { return currentData[k]; });

            for (var i = 0; i < list.length; i++) {
                if (list[i] && list[i].id === id) {
                    if (list[i].password !== password) {
                        wrongPassword = true;
                        break;
                    }
                    if (list[i].activated === false) {
                        var hasLimitedDur = typeof list[i].durationMs === 'number' && list[i].durationMs > 0;
                        list[i].activated = true;
                        list[i].expiresAt = hasLimitedDur ? (now + list[i].durationMs) : null;
                        list[i].loginAt = now;
                        list[i].loggedOut = false;
                    }
                    activated = list[i];
                    break;
                }
            }

            return Array.isArray(currentData) ? list : currentData;
        });

        if (wrongPassword) {
            return res.status(401).json({ ok: false, message: 'Password tidak cocok.' });
        }

        if (!txResult.committed) {
            return res.status(503).json({ ok: false, message: 'Gagal memperbarui status login. Coba lagi.' });
        }

        /* Tidak ketemu match di transaction (mis. sudah keburu aktif dari tab
           lain, atau akun baru saja dihapus admin) — ambil data terkininya
           langsung, TETAP dengan verifikasi password, supaya sesi bisa
           dibangun tanpa memaksa user login ulang. */
        if (!activated) {
            var snap = await dbRef.once('value');
            var val = snap.val();
            var list2 = Array.isArray(val) ? val : (val && typeof val === 'object' ? Object.values(val) : []);
            var found = list2.find(function (u) { return u && u.id === id; }) || null;
            if (found && found.password === password) {
                activated = found;
            } else if (found) {
                return res.status(401).json({ ok: false, message: 'Password tidak cocok.' });
            }
        }

        if (!activated) {
            return res.status(404).json({ ok: false, message: 'Akun tidak ditemukan.' });
        }

        return res.status(200).json({ ok: true, user: activated });

    } catch (err) {
        console.error('[api/complete-login] gagal aktivasi akun:', err);
        return res.status(500).json({ ok: false, message: 'Terjadi kesalahan di server.' });
    }
};

