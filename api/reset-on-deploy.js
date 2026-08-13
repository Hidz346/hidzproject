/**
 * POST /api/reset-on-deploy
 *
 * Menggantikan _checkFileVersionFirebase() versi lama di hidzproject.html.
 * Dulu, setiap kali ada browser yang membuka halaman TEPAT setelah deploy
 * baru (FILE_VERSION berubah), browser itu sendiri yang: baca hidz_file_ver,
 * download SELURUH hidz_access_db (termasuk password semua user), reset
 * status login tiap akun, tulis balik seluruh array-nya, lalu bersihkan
 * sesi/banned/blocked-device tiap user satu per satu — semua dari sisi
 * client. Sekarang browser cuma kirim FILE_VERSION-nya sendiri ke sini;
 * semua langkah di atas dikerjakan di server lewat Firebase Admin SDK.
 *
 * Body: { fileVersion: string }
 * Response: { ok: boolean, reset: boolean }
 *   reset:false → versi sama seperti sebelumnya (belum ada deploy baru),
 *                 atau ini deploy pertama kali (belum ada riwayat versi),
 *                 jadi tidak ada akun yang direset.
 *   reset:true  → versi berubah dari yang tersimpan, reset benar-benar
 *                 dijalankan.
 *
 * Dijaga pakai Firebase transaction di hidz_file_ver supaya kalau beberapa
 * browser mengirim request ini nyaris bersamaan tepat setelah deploy,
 * reset cuma benar-benar dijalankan SEKALI — bukan berkali-kali seperti
 * potensi race condition di versi client-side yang lama.
 *
 * Pakai env var yang sama dengan /api/login.js & /api/session-status.js.
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
    const fileVersion = typeof body.fileVersion === 'string' ? body.fileVersion.trim() : '';

    if (!fileVersion || fileVersion.length > 128) {
        return res.status(400).json({ ok: false, message: 'fileVersion tidak valid.' });
    }

    try {
        getAdminApp();

        var previousVersion = null;
        const verRef = admin.database().ref('hidz_file_ver');
        const txResult = await verRef.transaction(function (current) {
            previousVersion = current;
            /* Versi sama persis → batalkan transaksi, tidak ada yang perlu ditulis */
            if (current === fileVersion) return;
            return fileVersion;
        });

        /* Transaksi batal (aborted) → versi memang sudah sama, tidak ada deploy baru */
        if (!txResult.committed) {
            return res.status(200).json({ ok: true, reset: false });
        }

        /* Belum pernah ada versi tersimpan sebelumnya (deploy pertama kali)
           → cukup simpan versinya, jangan reset siapa-siapa */
        if (!previousVersion) {
            return res.status(200).json({ ok: true, reset: false });
        }

        /* Versi benar-benar berubah → reset status login SEMUA akun,
           TERMASUK ADMIN, sama seperti logic lama */
        const dbRef = admin.database().ref(DB_KEY);
        const snap = await dbRef.once('value');
        const val = snap.val();

        var users = [];
        if (Array.isArray(val)) {
            users = val.filter(function (u) { return u && u.username; });
        } else if (val && typeof val === 'object') {
            users = Object.values(val).filter(function (u) { return u && u.username; });
        }

        const now = Date.now();
        var changed = false;
        users.forEach(function (u) {
            if (!u) return;
            const isUnlimitedDur = !(typeof u.durationMs === 'number' && u.durationMs > 0);
            if (isUnlimitedDur) {
                u.activated = false;
            } else if (u.activated === true && u.expiresAt && (now <= u.expiresAt)) {
                u.durationMs = Math.max(0, u.expiresAt - now);
                u.expiresAt = null;
                u.activated = false;
            }
            u.logoutAt = now;
            u.loggedOut = false;
            changed = true;
        });

        if (changed) {
            await dbRef.set(users);
        }

        const cleanupJobs = [];
        users.forEach(function (u) {
            if (!u) return;
            cleanupJobs.push(admin.database().ref('hidz_sessions/' + u.id).remove());
            cleanupJobs.push(admin.database().ref('hidz_banned/' + u.id).remove());
            cleanupJobs.push(admin.database().ref('hidz_blocked_devices/' + u.id).remove());
        });
        await Promise.all(cleanupJobs);

        await admin.database().ref('hidz_force_relogin').set(Date.now());

        return res.status(200).json({ ok: true, reset: true });

    } catch (err) {
        console.error('[api/reset-on-deploy] gagal proses reset:', err);
        return res.status(500).json({ ok: false, message: 'Terjadi kesalahan di server.' });
    }
};
