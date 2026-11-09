/* Chat Global — ruang obrolan bersama untuk role VIP & ADMIN.

   Membaca pesan dilakukan langsung dari Firebase (real-time; aturannya ada di
   databaserules.json: semua akun yang sudah login boleh membaca). Menulis TIDAK
   boleh dari browser. Semua pesan lewat sini supaya role dicek ulang ke database
   di setiap kirim — USER tidak bisa mengirim walau mengakali tampilan, dan USER
   yang baru membeli VIP langsung bisa kirim tanpa login ulang.

   Pesan bisa membalas pesan lain (reply) dan menandai akun VIP/ADMIN dengan @nama
   (mentions). Kutipan balasan dan daftar akun yang ditag disusun di sini dari data
   database, bukan dari kiriman browser, jadi tidak bisa dipalsukan. Akun yang dibalas
   atau ditag juga mendapat notifikasi Chrome lewat chat-push.js.

   File ini dipanggil dari check-session.js lewat vercel.json (/api/chat/send,
   /api/chat/delete, /api/chat/members). Tidak dibuat sebagai fungsi tersendiri karena
   jumlah fungsi di plan Hobby sudah mentok. */

var db = require('./db');
var firebaseAuth = require('./firebase-auth');
var chatPush = require('./chat-push');

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
var ACCOUNT_ID      = /^[A-Za-z0-9_-]{1,128}$/;
var MAX_MENTIONS    = 8;       // akun yang boleh ditag dalam satu pesan
var WORD_CHAR       = /[A-Za-z0-9_]/;

function isExpired(acc, now) {
    var paused = typeof acc.pausedRemainingMs === 'number' && acc.pausedRemainingMs > 0;
    return !paused && !!acc.expiresAt && now > acc.expiresAt;
}

/* Akun yang bisa ditag: semua VIP dan ADMIN yang masih aktif, termasuk akun yang baru dibuat dan belum
   pernah login. Dibaca dari database, jadi akun baru langsung ikut tanpa menunggu apa pun. */
function memberList(accounts, now) {
    var seen = {};
    var out = [];
    accounts.forEach(function (u) {
        if (!u || typeof u.username !== 'string' || !u.username || !ACCOUNT_ID.test(String(u.id || ''))) return;
        var role = u.role === 'admin' ? 'admin' : (u.role === 'vip' ? 'vip' : '');
        if (!role || isExpired(u, now) || seen[u.id]) return;
        seen[u.id] = true;
        out.push({ uid: u.id, name: u.id === ADMIN_UID ? ADMIN_NAME : u.username, role: role });
    });
    if (!seen[ADMIN_UID]) out.push({ uid: ADMIN_UID, name: ADMIN_NAME, role: 'admin' });
    return out;
}

/* Selalu dibaca langsung dari database (tanpa simpanan), supaya akun yang baru dibuat langsung ikut.
   `known` = daftar akun yang sudah dibaca untuk memeriksa pengirim, biar tidak dibaca dua kali. */
async function getMembers(known) {
    var accounts = known || await db.fetchAllAccounts();
    return accounts ? memberList(accounts, Date.now()) : null;
}

/* "@nama" berdiri sendiri di teks (bukan bagian dari kata lain, mis. email atau @namaLain) */
function mentionedInText(text, name) {
    var needle = '@' + name;
    var i = 0;
    while ((i = text.indexOf(needle, i)) !== -1) {
        var before = i > 0 ? text.charAt(i - 1) : '';
        var after  = text.charAt(i + needle.length);
        if ((!before || !WORD_CHAR.test(before)) && (!after || !WORD_CHAR.test(after))) return true;
        i += 1;
    }
    return false;
}

/* Akun yang benar-benar ditag: harus anggota aktif (VIP/ADMIN), bukan pengirimnya sendiri, dan "@nama"-nya
   memang tertulis di pesan — supaya tidak ada yang bisa memanggil orang tanpa terlihat. Nama diambil dari
   database. Yang tidak memenuhi syarat dibuang diam-diam, pesannya tetap terkirim. */
function buildMentions(ids, text, members, senderUid) {
    var byUid = {};
    members.forEach(function (m) { byUid[m.uid] = m; });
    var seen = {};
    var out = [];
    ids.forEach(function (id) {
        var m = byUid[id];
        if (!m || id === senderUid || seen[id] || out.length >= MAX_MENTIONS) return;
        if (!mentionedInText(text, m.name)) return;
        seen[id] = true;
        out.push({ uid: m.uid, name: m.name });
    });
    return out;
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
    return { ok: true, uid: uid, role: role, name: acc.username, canModerate: false, accounts: list };
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

    /* Akun yang ditag: hanya id-nya yang dikirim browser, sisanya (nama, apakah masih aktif) dari database */
    var tagIds = [];
    var rawTags = (req.body || {}).mentions;
    if (Array.isArray(rawTags)) {
        rawTags.slice(0, MAX_MENTIONS * 2).forEach(function (id) {
            if (typeof id === 'string' && ACCOUNT_ID.test(id) && tagIds.indexOf(id) === -1) tagIds.push(id);
        });
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
    if (tagIds.length) {
        var members = await getMembers(auth.accounts);
        var mentions = members ? buildMentions(tagIds, text, members, auth.uid) : [];
        if (mentions.length) record.mentions = mentions;
    }
    var written = await Promise.all([
        db.setPath(COOLDOWN_PATH + '/' + auth.uid, now),
        db.setPath(MESSAGES_PATH + '/' + id, record)
    ]);
    if (!written[1]) {
        res.status(200).json({ ok: false, reason: 'db_error' });
        return;
    }

    /* Notifikasi Chrome untuk yang dibalas/ditag; tidak pernah menggagalkan pengiriman */
    if (record.reply || record.mentions) await chatPush.notifyChat(record, id, auth.uid);

    if (Math.random() < PRUNE_CHANCE) await pruneOldMessages();
    res.status(200).json({ ok: true, id: id });
}

/* Daftar akun VIP & ADMIN untuk menu tag (@) di kolom pesan */
async function listMembers(auth, res) {
    if (auth.role === 'user') {
        res.status(200).json({ ok: false, reason: 'vip_required' });
        return;
    }
    var members = await getMembers();
    if (!members) {
        res.status(200).json({ ok: false, reason: 'db_error' });
        return;
    }
    res.status(200).json({ ok: true, members: members });
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
    if (action === 'chat-members') { await listMembers(auth, res); return; }
    res.status(200).json({ ok: false });
}

module.exports = { handleAction: handleAction, _test: { memberList: memberList, buildMentions: buildMentions, mentionedInText: mentionedInText } };
