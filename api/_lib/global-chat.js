/* Chat Global — ruang obrolan bersama untuk role VIP & ADMIN.

   Membaca pesan dilakukan langsung dari Firebase (real-time; aturannya ada di
   databaserules.json: semua akun yang sudah login boleh membaca). Menulis TIDAK
   boleh dari browser. Semua pesan lewat sini supaya role dicek ulang ke database
   di setiap kirim — USER tidak bisa mengirim walau mengakali tampilan, dan USER
   yang baru membeli VIP langsung bisa kirim tanpa login ulang.

   File ini dipanggil dari check-session.js lewat vercel.json (/api/chat/send dan
   /api/chat/delete). Tidak dibuat sebagai fungsi tersendiri karena jumlah fungsi
   di plan Hobby sudah mentok. */

var db = require('./db');
var firebaseAuth = require('./firebase-auth');

var CHAT_PATH       = 'hidz_global_chat';
var MESSAGES_PATH   = CHAT_PATH + '/messages';
var COOLDOWN_PATH   = CHAT_PATH + '/cooldown';
var ADMIN_UID       = 'admin_hidz_protected';
var ADMIN_NAME      = 'Hidz';
var MAX_TEXT_LENGTH = 500;
var QUOTE_LENGTH    = 120;     // panjang kutipan yang disimpan di pesan balasan
var COOLDOWN_MS     = 1500;
var ID_PAST_MS      = 30000;   // kunci pesan dari browser boleh sampai 30 detik lebih lama dari jam server
var ID_FUTURE_MS    = 10000;   // ...dan sampai 10 detik lebih cepat
var KEEP_MESSAGES   = 300;
var PRUNE_CHANCE    = 0.05;
var MESSAGE_ID      = /^[0-9]{13}-[a-z0-9]{6}$/;

function isExpired(acc, now) {
    var paused = typeof acc.pausedRemainingMs === 'number' && acc.pausedRemainingMs > 0;
    return !paused && !!acc.expiresAt && now > acc.expiresAt;
}

/* Siapa yang mengirim request ini? Identitas diambil dari token Firebase, role dan
   masa aktifnya dibaca ulang dari database (bukan dari isi request). */
async function authenticate(req) {
    var token = firebaseAuth.bearerToken(req);
    if (!token) return { ok: false, reason: 'auth_required' };

    var claims;
    try { claims = await firebaseAuth.verifyIdToken(token); }
    catch (e) { return { ok: false, reason: 'auth_required' }; }

    var uid = claims.user_id || claims.sub;
    if (uid === ADMIN_UID) {
        if (claims.admin !== true || claims.role !== 'admin') return { ok: false, reason: 'auth_required' };
        return { ok: true, uid: uid, role: 'admin', name: ADMIN_NAME, canModerate: true };
    }

    var list = await db.fetchAllAccounts();
    if (!list) return { ok: false, reason: 'db_error' };
    var acc = list.filter(function (u) { return u && u.id === uid; })[0];
    if (!acc) return { ok: false, reason: 'not_found' };
    if (isExpired(acc, Date.now())) return { ok: false, reason: 'expired' };

    var role = (acc.role === 'vip' || acc.role === 'admin') ? acc.role : 'user';
    return { ok: true, uid: uid, role: role, name: acc.username, canModerate: false };
}

/* Karakter kontrol dan karakter tak terlihat (zero-width, pemisah baris/paragraf, BOM). */
var INVISIBLE_CHARS = new RegExp('[\\u0000-\\u001f\\u007f\\u200b-\\u200f\\u2028\\u2029\\ufeff]', 'g');

/* Teks pesan: buang karakter kontrol dan karakter tak terlihat, rapikan spasi. */
function cleanText(raw) {
    if (typeof raw !== 'string') return '';
    return raw
        .replace(INVISIBLE_CHARS, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/* Kutipan untuk pesan balasan, disusun di server dari pesan aslinya (bukan dari kiriman browser), jadi
   tidak bisa dipakai untuk memalsukan "si A bilang ...". Pesan yang sudah dihapus tidak bisa dibalas. */
function buildReply(original, id) {
    if (!original || typeof original !== 'object' || original.delAll === true || typeof original.text !== 'string') return null;
    var text = cleanText(original.text);
    if (text.length > QUOTE_LENGTH) {
        var cut = text.slice(0, QUOTE_LENGTH - 1);
        if (/[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1);   // jangan memenggal emoji
        text = cut.replace(/\s+$/, '') + '\u2026';
    }
    return { id: id, uid: String(original.uid || ''), name: String(original.name || 'User'), text: text };
}

/* ID pesan berurutan waktu (13 digit milidetik + akhiran acak), jadi urutan kunci
   di Firebase sama dengan urutan kirimnya. */
function messageId(now) {
    return String(now).padStart(13, '0') + '-' + Math.random().toString(36).slice(2, 8).padEnd(6, '0');
}

/* Browser membuat kunci pesan sendiri supaya pesan bisa langsung tampil di layar pengirim dan
   dicocokkan dengan salinannya dari Firebase. Dipakai hanya kalau bentuknya benar dan waktunya
   wajar; kalau tidak, server membuat kunci sendiri dan browser mengikuti kunci dari server. */
function clientId(hint, now) {
    if (typeof hint !== 'string' || !MESSAGE_ID.test(hint)) return null;
    var ts = parseInt(hint.slice(0, 13), 10);
    if (ts < now - ID_PAST_MS || ts > now + ID_FUTURE_MS) return null;
    return { id: hint, ts: ts };
}

/* Simpan hanya KEEP_MESSAGES pesan terbaru supaya database tidak menumpuk. Dijalankan
   sesekali saja (bukan di setiap kirim) dan tidak boleh menggagalkan pengiriman. */
async function pruneOldMessages() {
    var secret = process.env.FIREBASE_DB_SECRET || '';
    if (!secret) return;
    try {
        var listRes = await fetch(db.DB_URL + '/' + MESSAGES_PATH + '.json?shallow=true&auth=' + secret);
        var keys = Object.keys((await listRes.json()) || {}).sort();
        var extra = keys.length - KEEP_MESSAGES;
        if (extra <= 0) return;
        var patch = {};
        keys.slice(0, extra).forEach(function (k) { patch[k] = null; });
        await fetch(db.DB_URL + '/' + MESSAGES_PATH + '.json?auth=' + secret, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(patch)
        });
    } catch (e) {}
}

async function sendMessage(auth, req, res) {
    if (auth.role === 'user') {
        res.status(200).json({ ok: false, reason: 'vip_required', message: 'Chat global khusus untuk VIP & ADMIN.' });
        return;
    }

    var text = cleanText((req.body || {}).chatText);
    if (!text) {
        res.status(200).json({ ok: false, reason: 'invalid_text', message: 'Pesan tidak boleh kosong.' });
        return;
    }
    if (text.length > MAX_TEXT_LENGTH) {
        res.status(200).json({ ok: false, reason: 'too_long', message: 'Pesan maksimal ' + MAX_TEXT_LENGTH + ' karakter.' });
        return;
    }

    /* Membalas pesan lain: id pesan yang dibalas harus berbentuk benar dan pesannya harus masih ada */
    var replyId = (req.body || {}).replyTo;
    if (replyId !== undefined && replyId !== null && (typeof replyId !== 'string' || !MESSAGE_ID.test(replyId))) {
        res.status(200).json({ ok: false, reason: 'invalid_reply', message: 'Pesan yang dibalas tidak valid.' });
        return;
    }

    var now = Date.now();
    var pick = clientId((req.body || {}).id, now);
    var checks = await Promise.all([
        db.fetchPath(COOLDOWN_PATH + '/' + auth.uid),
        pick ? db.fetchPath(MESSAGES_PATH + '/' + pick.id) : null,
        replyId ? db.fetchPath(MESSAGES_PATH + '/' + replyId) : null
    ]);
    var last = checks[0];
    if (typeof last === 'number' && now - last < COOLDOWN_MS) {
        res.status(200).json({ ok: false, reason: 'slow_down', retryAfterMs: COOLDOWN_MS - (now - last) });
        return;
    }

    var reply = null;
    if (replyId) {
        reply = buildReply(checks[2], replyId);
        if (!reply) {
            res.status(200).json({ ok: false, reason: 'reply_gone', message: 'Pesan yang kamu balas sudah dihapus.' });
            return;
        }
    }

    /* Kunci dari browser tidak boleh menimpa pesan yang sudah ada */
    var id = (pick && !checks[1]) ? pick.id : messageId(now);
    var ts = (pick && !checks[1]) ? pick.ts : now;
    var record = { uid: auth.uid, name: auth.name, role: auth.role, text: text, ts: ts };
    if (reply) record.reply = reply;
    var written = await Promise.all([
        db.setPath(COOLDOWN_PATH + '/' + auth.uid, now),
        db.setPath(MESSAGES_PATH + '/' + id, record)
    ]);
    if (!written[1]) {
        res.status(200).json({ ok: false, reason: 'db_error' });
        return;
    }

    if (Math.random() < PRUNE_CHANCE) await pruneOldMessages();
    res.status(200).json({ ok: true, id: id });
}

/* Pengirim boleh menghapus pesannya sendiri; ADMIN boleh menghapus pesan siapa pun. Pesan tidak dibuang,
   isinya dikosongkan dan ditandai delAll supaya semua layar menampilkan "Pesan ini telah dihapus"
   (sama seperti "Hapus untuk semua" di Konseling). */
async function deleteMessage(auth, req, res) {
    var id = (req.body || {}).messageId;
    if (typeof id !== 'string' || !MESSAGE_ID.test(id)) {
        res.status(200).json({ ok: false, reason: 'invalid_id' });
        return;
    }

    var msg = await db.fetchPath(MESSAGES_PATH + '/' + id);
    if (!msg) {
        res.status(200).json({ ok: true, already: true });
        return;
    }
    if (msg.uid !== auth.uid && !auth.canModerate) {
        res.status(200).json({ ok: false, reason: 'forbidden', message: 'Kamu hanya bisa menghapus pesanmu sendiri.' });
        return;
    }

    if (msg.delAll === true) {
        res.status(200).json({ ok: true, already: true });
        return;
    }
    var removed = await db.setPath(MESSAGES_PATH + '/' + id, { uid: msg.uid, name: msg.name, role: msg.role, ts: msg.ts, text: '', delAll: true });
    res.status(200).json(removed ? { ok: true } : { ok: false, reason: 'db_error' });
}

async function handleAction(action, req, res) {
    if (req.method !== 'POST') {
        res.status(200).json({ ok: false });
        return;
    }
    var auth = await authenticate(req);
    if (!auth.ok) {
        res.status(200).json({ ok: false, reason: auth.reason });
        return;
    }
    if (action === 'chat-send')   { await sendMessage(auth, req, res); return; }
    if (action === 'chat-delete') { await deleteMessage(auth, req, res); return; }
    res.status(200).json({ ok: false });
}

module.exports = { handleAction: handleAction };
