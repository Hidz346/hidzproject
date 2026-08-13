/**
 * POST /api/session-status
 *
 * Mengembalikan status SATU akun saja (berdasarkan `id` yang dikirim), dipakai
 * hidzproject.html untuk 2 hal yang dulu bergantung pada listener realtime
 * `firebase.database().ref('hidz_access_db').on('value', ...)`:
 *
 *   1. Auto-logout kalau akun sudah dihapus admin atau sudah expired
 *      (_checkSessionValidity, dipanggil berkala oleh _startSessionWatch).
 *   2. Ambil deviceLimit akun ini saat sesi dipulihkan setelah tab dibuka lagi.
 *
 * Listener lama itu men-download SELURUH isi hidz_access_db — termasuk
 * password setiap user lain — ke browser siapa pun yang sedang membuka
 * halaman, bukan cuma yang sedang login. Endpoint ini menggantikannya:
 * pencarian tetap di server lewat Firebase Admin SDK, dan yang dikirim balik
 * ke browser cuma status akun yang diminta — tanpa password, tanpa data user
 * lain sama sekali.
 *
 * Body: { id: string }
 * Response sukses: { exists: boolean, expiresAt: number|null, deviceLimit: number }
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
        return res.status(405).json({ exists: false, message: 'Method not allowed' });
    }

    const body = req.body || {};
    const id = typeof body.id === 'string' ? body.id : '';

    if (!id) {
        return res.status(400).json({ exists: false, message: 'id wajib diisi.' });
    }

    try {
        getAdminApp();
        const snap = await admin.database().ref(DB_KEY).once('value');
        const val = snap.val();

        let users = [];
        if (Array.isArray(val)) {
            users = val.filter(function (u) { return u && u.username; });
        } else if (val && typeof val === 'object') {
            users = Object.values(val).filter(function (u) { return u && u.username; });
        }

        const match = users.find(function (u) { return u.id === id; });

        if (!match) {
            return res.status(200).json({ exists: false, expiresAt: null, deviceLimit: 0 });
        }

        return res.status(200).json({
            exists: true,
            expiresAt: match.expiresAt || null,
            deviceLimit: typeof match.deviceLimit === 'number' ? match.deviceLimit : 0
        });

    } catch (err) {
        console.error('[api/session-status] gagal cek status:', err);
        return res.status(500).json({ exists: true, expiresAt: null, deviceLimit: 0, message: 'Terjadi kesalahan di server.' });
    }
};
