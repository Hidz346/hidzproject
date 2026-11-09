/* Notifikasi Chrome (Web Push) untuk Chat Global: akun yang pesannya dibalas atau yang ditag
   mendapat notifikasi di device yang sudah mengaktifkan notifikasi, walau tab HidzProject sedang
   tidak dibuka. Pesan lain di Chat Global tidak mengirim apa-apa.

   Langganan device disimpan oleh api/push.js di hidz_push_subs/{id akun}/{id device}. Pengirimnya
   dipakai bersama dengan HidzAdmin: kunci VAPID-nya HARUS sama dengan di sana, jadi di Vercel
   project HidzProject isi:

       VAPID_PUBLIC_KEY   (sudah ada)
       VAPID_PRIVATE_KEY  (salin dari HidzAdmin)
       VAPID_SUBJECT      (opsional, bawaan https://hidzproject.my.id)

   Paket web-push dipasang lewat package.json di root repo. Kalau paket atau kuncinya belum ada,
   pengiriman push dilewati begitu saja: pesan tetap terkirim, tanda @ dan lencana di dalam
   halaman tetap jalan. File bantu saja (folder _lib), bukan Serverless Function. */

var db = require('./db');

var webpush = null;
try { webpush = require('web-push'); } catch (e) { webpush = null; }

var SUBS_PATH    = 'hidz_push_subs';
var ID_PATTERN   = /^[A-Za-z0-9_-]{1,128}$/;
var SEND_TIMEOUT = 2000;   // batas tiap pengiriman ke layanan push
var TOTAL_BUDGET = 2500;   // batas total sebelum balasan ke pengirim pesan dikirim
var PUSH_TTL     = 3600;   // detik; notifikasi yang tidak sempat sampai dalam sejam tidak berguna lagi
var BODY_LENGTH  = 120;

/* Hanya layanan push milik browser besar (sama seperti api/push.js) */
var PUSH_HOST_SUFFIXES = [
    '.googleapis.com',
    '.push.services.mozilla.com',
    '.push.apple.com',
    '.notify.windows.com'
];

function isAllowedEndpoint(endpoint) {
    var url;
    try { url = new URL(endpoint); } catch (e) { return false; }
    if (url.protocol !== 'https:') return false;
    return PUSH_HOST_SUFFIXES.some(function (suffix) {
        return url.hostname.length > suffix.length && url.hostname.slice(-suffix.length) === suffix;
    });
}

var _warned = {};
function warnOnce(key, message) {
    if (_warned[key]) return;
    _warned[key] = true;
    console.warn('[chat-push] ' + message);
}

var _configured = false;
function pushReady() {
    if (!webpush) { warnOnce('module', 'paket web-push belum terpasang (package.json di root repo HidzProject) — notifikasi Chrome Chat Global dilewati.'); return false; }
    if (_configured) return true;
    var publicKey  = process.env.VAPID_PUBLIC_KEY || '';
    var privateKey = process.env.VAPID_PRIVATE_KEY || '';
    if (!publicKey || !privateKey) { warnOnce('keys', 'VAPID_PRIVATE_KEY belum diisi di HidzProject — notifikasi Chrome Chat Global dilewati.'); return false; }
    try {
        webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'https://hidzproject.my.id', publicKey, privateKey);
        _configured = true;
    } catch (e) {
        warnOnce('details', 'kunci VAPID / VAPID_SUBJECT ditolak: ' + (e && e.message));
        return false;
    }
    return true;
}

function clip(text, max) {
    text = String(text || '');
    if (text.length <= max) return text;
    var cut = text.slice(0, max - 1);
    if (/[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1);
    return cut.replace(/\s+$/, '') + '…';
}

/* Siapa yang perlu diberi tahu: pemilik pesan yang dibalas dan akun yang ditag, kecuali pengirimnya
   sendiri. Satu akun cukup sekali (ditag lebih diutamakan daripada dibalas). */
function targetsOf(record, senderUid) {
    var map = {};
    if (record.reply && typeof record.reply === 'object' && record.reply.uid) map[record.reply.uid] = 'reply';
    (Array.isArray(record.mentions) ? record.mentions : []).forEach(function (t) {
        if (t && t.uid) map[t.uid] = 'mention';
    });
    return Object.keys(map)
        .filter(function (uid) { return uid !== senderUid && ID_PATTERN.test(uid); })
        .map(function (uid) { return { uid: uid, kind: map[uid] }; });
}

async function sendOne(path, sub, payload) {
    if (!sub || typeof sub.endpoint !== 'string' || !isAllowedEndpoint(sub.endpoint)) return false;
    if (!sub.keys || typeof sub.keys.p256dh !== 'string' || typeof sub.keys.auth !== 'string') return false;
    try {
        await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } },
            payload,
            { TTL: PUSH_TTL, urgency: 'high', timeout: SEND_TIMEOUT }
        );
        return true;
    } catch (e) {
        /* Langganan yang sudah mati (aplikasi dihapus, izin dicabut) dibuang supaya tidak dicoba terus */
        if (e && (e.statusCode === 404 || e.statusCode === 410)) await db.deletePath(path);
        return false;
    }
}

/* Kabari akun-akun yang dibalas/ditag. record = pesan yang baru disimpan, id = kunci pesannya.
   Best-effort: tidak pernah melempar error dan tidak menunggu lebih dari TOTAL_BUDGET. */
function notifyChat(record, id, senderUid) {
    var work = (async function () {
        var targets = targetsOf(record, senderUid);
        if (!targets.length || !pushReady()) return 0;

        var subs = await Promise.all(targets.map(function (t) { return db.fetchPath(SUBS_PATH + '/' + t.uid); }));
        var jobs = [];
        targets.forEach(function (t, i) {
            var devices = subs[i];
            if (!devices || typeof devices !== 'object') return;
            var from = clip(record.name || 'Seseorang', 40);
            var payload = JSON.stringify({
                title: from + (t.kind === 'mention' ? ' menyebut kamu di Chat Global' : ' membalas pesanmu di Chat Global'),
                body:  clip(record.text, BODY_LENGTH),
                tag:   'hidz-gc-' + id,
                type:  'chat',
                url:   './?gc=1'
            });
            Object.keys(devices).forEach(function (deviceId) {
                if (!ID_PATTERN.test(deviceId)) return;
                jobs.push(sendOne(SUBS_PATH + '/' + t.uid + '/' + deviceId, devices[deviceId], payload));
            });
        });
        var results = await Promise.all(jobs);
        return results.filter(Boolean).length;
    })().catch(function () { return 0; });

    var timer;
    var limit = new Promise(function (resolve) { timer = setTimeout(function () { resolve(0); }, TOTAL_BUDGET); });
    return Promise.race([work, limit]).then(function (n) { clearTimeout(timer); return n; });
}

module.exports = { notifyChat: notifyChat, targetsOf: targetsOf };
