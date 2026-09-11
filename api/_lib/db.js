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

/* Ambil seluruh daftar akun (VIP/USER/admin lama). null = secret belum
   diset / gagal konek, [] = memang kosong. */
async function fetchAllAccounts() {
    var qs = authQS();
    if (!qs) return null;
    try {
        var r = await fetch(DB_URL + '/hidz_access_db.json' + qs);
        var data = await r.json();
        if (Array.isArray(data)) return data.filter(function (u) { return u && u.username; });
        if (data && typeof data === 'object') return Object.values(data).filter(function (u) { return u && u.username; });
        return [];
    } catch (e) {
        return null;
    }
}

/* Timpa seluruh daftar akun dengan array baru (pola yang sama seperti
   admin.html/mutateUsersAtomic — baca semua, ubah di memori, tulis semua). */
async function saveAllAccounts(list) {
    var qs = authQS();
    if (!qs) return false;
    try {
        var r = await fetch(DB_URL + '/hidz_access_db.json' + qs, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(list)
        });
        return r.ok;
    } catch (e) {
        return false;
    }
}

/* Bersihkan jejak akun yang sudah dihapus di node-node lain (sesi aktif,
   status banned, device yang diblokir) — sama seperti yang dilakukan
   Panel VIP & admin.html sebelumnya. */
async function removeAccountTraces(id) {
    var qs = authQS();
    if (!qs) return;
    var paths = ['hidz_sessions/' + id, 'hidz_banned/' + id, 'hidz_blocked_devices/' + id];
    await Promise.all(paths.map(function (p) {
        return fetch(DB_URL + '/' + p + '.json' + qs, { method: 'DELETE' }).catch(function () {});
    }));
}

/* Cek apakah {id, username, password} yang dikirim benar-benar akun VIP
   yang valid di dalam daftar. Dipakai tiap endpoint Panel VIP sebelum
   ngizinin baca/tulis apa pun. */
function findValidVip(list, vipId, vipUsername, vipPassword) {
    var me = list.filter(function (u) { return u.id === vipId; })[0];
    if (!me) return null;
    if (me.role !== 'vip') return null;
    if ((me.username || '').toLowerCase() !== (vipUsername || '').toLowerCase()) return null;
    if (me.password !== vipPassword) return null;
    return me;
}

module.exports = {
    DB_URL: DB_URL,
    fetchAllAccounts: fetchAllAccounts,
    saveAllAccounts: saveAllAccounts,
    removeAccountTraces: removeAccountTraces,
    findValidVip: findValidVip
};

