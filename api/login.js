/**
 * POST /api/login
 *
 * Verifikasi username & password terhadap hidz_access_db di Firebase,
 * dijalankan sepenuhnya di server (Vercel Serverless Function) lewat
 * Firebase Admin SDK.
 *
 * Kenapa ini penting: sebelumnya, doLogin() di hidzproject.html mencocokkan
 * username/password dengan cara men-download SELURUH isi hidz_access_db
 * (termasuk password semua user lain) ke browser, lalu membandingkannya
 * dengan JavaScript di sana. Itu artinya siapa pun yang membuka DevTools
 * bisa melihat seluruh daftar username+password tanpa perlu login sama
 * sekali. Endpoint ini memindahkan langkah pencocokan itu ke server —
 * browser cuma mengirim username+password yang diketik user, dan cuma
 * menerima balik data akun miliknya sendiri kalau memang cocok.
 *
 * Field yang dikembalikan (`user`) sengaja dibuat identik dengan objek
 * `found` yang dulu dipakai di kode lama — termasuk field `password` —
 * supaya fitur "Lihat Password" di halaman profil tetap jalan seperti
 * biasa tanpa perlu ubah apa pun di tempat lain.
 *
 * Env var yang wajib diisi di Vercel (Project Settings > Environment Variables):
 *   FIREBASE_PROJECT_ID
 *   FIREBASE_CLIENT_EMAIL
 *   FIREBASE_PRIVATE_KEY     (paste apa adanya, termasuk baris BEGIN/END)
 * Ketiganya diambil dari Firebase Console > Project Settings > Service
 * Accounts > Generate new private key (bukan config `apiKey` yang di
 * hidzproject.html — itu dua hal yang beda, service account key ini
 * TIDAK BOLEH pernah ditaruh di file yang di-commit ke GitHub).
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
        return res.status(405).json({ success: false, message: 'Method not allowed' });
    }

    const body = req.body || {};
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';

    if (!username || !password) {
        return res.status(400).json({
            success: false,
            message: 'Username dan password tidak boleh kosong!'
        });
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

        if (users.length === 0) {
            return res.status(503).json({
                success: false,
                message: 'Gagal memuat data pengguna dari server. Periksa koneksi internet kamu, lalu muat ulang halaman.'
            });
        }

        const target = username.toLowerCase();
        const match = users.find(function (u) {
            return u.username.toLowerCase() === target && u.password === password;
        });

        if (!match) {
            return res.status(401).json({ success: false, message: 'Username atau password salah!' });
        }

        if (match.expiresAt && Date.now() > match.expiresAt) {
            return res.status(403).json({ success: false, message: 'Akses sudah berakhir! Hubungi admin.' });
        }

        return res.status(200).json({ success: true, user: match });

    } catch (err) {
        console.error('[api/login] gagal verifikasi:', err);
        return res.status(500).json({
            success: false,
            message: 'Terjadi kesalahan di server. Coba lagi sebentar lagi.'
        });
    }
};
