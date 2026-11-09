/* Bekal notifikasi untuk akun yang baru dibuat dari Panel VIP.

   Notifikasi "untuk semua akun" (voucher baru, project baru, dst.) ditulis admin ke antrean tiap akun yang
   ADA saat itu, jadi akun yang dibuat sesudahnya tidak ikut menerimanya. Fungsi di sini menyalin ke antrean
   akun baru (= riwayat notifikasinya) semua notifikasi yang MASIH berlaku, lengkap dengan masa berlaku,
   waktu masuk, dan penanda aslinya — jadi ikut tertarik kalau admin menghapus riwayat atau voucher-nya.
   Belum dibaca, jadi kartunya muncul saat akun itu login pertama.

   Logikanya sama dengan seedNewAccount() di HIDZADMIN (api/_lib/push.js), yang memakainya saat admin membuat
   akun. Dijaga sama supaya akun dari mana pun menerima hal yang sama. File ini hanya bantu (bukan endpoint),
   jadi tidak menambah jumlah Serverless Function. */

var crypto = require('crypto');
var db = require('./db');

var INBOX_PATH   = 'hidz_notifications';
var LOG_PATH     = 'hidz_notification_log';
var VOUCHER_PATH = 'hidz_vouchers';
var ADMIN_ID     = 'admin_hidz_protected';

/* Id akun dipakai langsung sebagai kunci path Firebase: satu kunci dengan karakter terlarang (. # $ [ ] /)
   membuat seluruh penulisan ditolak, jadi id yang aneh dilewati. */
var ID_PATTERN     = /^[A-Za-z0-9_-]{1,128}$/;
var LOG_ID_PATTERN = /^l_[0-9]{10,16}_[0-9a-f]{6}$/;
var REF_PATTERN    = /^[A-Za-z0-9:_-]{1,80}$/;

function newInboxId() {
    return 'n_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex');
}

/* Penanda kelompok sebuah catatan riwayat. Catatan voucher yang ditulis sebelum ada field `ref` dikenali dari
   judulnya ("Voucher VIP Baru: KODE"). */
function refOfLog(entry) {
    if (REF_PATTERN.test(String(entry.ref || ''))) return entry.ref;
    var m = entry.type === 'voucher_new' && /^Voucher VIP Baru: ([A-Za-z0-9_-]{1,60})$/.exec(String(entry.title || ''));
    return m ? 'voucher:' + m[1] : '';
}

/* Voucher yang masih bisa dipakai: ada di daftar, belum berakhir, kuotanya belum habis. */
function voucherUsable(v, now) {
    if (!v || typeof v !== 'object') return false;
    var end = Number(v.expiresAt);
    if (end > 0 && end <= now) return false;
    var max = Math.floor(Number(v.maxUses)) > 0 ? Math.floor(Number(v.maxUses)) : 0;
    return !(max > 0 && (Number(v.usedCount) || 0) >= max);
}

/* Yang dilewati: maintenance (kabar sesaat, tidak berguna bagi akun baru), catatan yang sudah berakhir atau
   sudah dihapus admin, dan voucher yang sudah dihapus / berakhir / kuotanya habis. Voucher yang dibuat ulang
   dengan kode yang sama cukup disalin yang terbaru. Aman dipanggil dua kali: yang sudah ada tidak digandakan.

   Best-effort, tidak pernah melempar error — gagal di sini tidak boleh menggagalkan pembuatan akun.
   Balikan: jumlah notifikasi yang disalin. */
async function seedNewAccount(userId) {
    if (!userId || userId === ADMIN_ID || !ID_PATTERN.test(String(userId))) return 0;

    try {
        var now = Date.now();
        var log = await db.fetchPath(LOG_PATH);
        if (!log || typeof log !== 'object') return 0;

        var candidates = Object.keys(log)
            .filter(function (id) { return LOG_ID_PATTERN.test(id) && log[id] && typeof log[id] === 'object'; })
            .map(function (id) { return { id: id, e: log[id] }; })
            .filter(function (it) {
                var e = it.e;
                return e.scope === 'all' && e.type !== 'maintenance' && e.title && e.body && Number(e.expiresAt) > now;
            })
            .sort(function (a, b) { return (Number(b.e.createdAt) || 0) - (Number(a.e.createdAt) || 0); });
        if (!candidates.length) return 0;

        var vouchers = null;
        if (candidates.some(function (it) { return refOfLog(it.e).indexOf('voucher:') === 0; })) {
            vouchers = (await db.fetchPath(VOUCHER_PATH)) || {};
        }

        var mine = await db.fetchPath(INBOX_PATH + '/' + userId);
        var has = {};
        if (mine && typeof mine === 'object') {
            Object.keys(mine).forEach(function (k) { if (mine[k] && mine[k].logId) has[mine[k].logId] = true; });
        }

        var taken = {};
        var writes = {};
        var count = 0;
        candidates.forEach(function (it) {
            var ref = refOfLog(it.e);
            if (ref) {
                if (taken[ref]) return;          /* terbaru per penanda saja */
                taken[ref] = true;
                if (ref.indexOf('voucher:') === 0 && !voucherUsable(vouchers[ref.slice(8)], now)) return;
            }
            if (has[it.id]) return;

            var note = {
                type:      it.e.type || 'info',
                title:     it.e.title,
                body:      it.e.body,
                createdAt: Number(it.e.createdAt) || now,
                expiresAt: Number(it.e.expiresAt),
                logId:     it.id
            };
            if (ref) note.ref = ref;
            writes[userId + '/' + newInboxId()] = note;
            count++;
        });

        if (!count) return 0;
        return (await db.updatePath(INBOX_PATH, writes)) ? count : 0;
    } catch (e) {
        return 0;
    }
}

module.exports = { seedNewAccount: seedNewAccount };
