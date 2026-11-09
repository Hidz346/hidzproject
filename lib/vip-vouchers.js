/* Aturan voucher VIP: paket yang dicakup, batas jumlah orang, dan pemakaiannya.

   Voucher disimpan di hidz_vouchers/<KODE>:
   - plans    : { <idPaket>: { planLabel, normalPrice, finalPrice, discountAmount, percent } }
                (voucher lama hanya punya planId/normalPrice/finalPrice, dibaca lewat planMap)
   - maxUses  : batas jumlah orang; 0 atau kosong = semua orang sampai voucher berakhir
   - usedCount: jumlah pembayaran yang sudah memakai voucher
   - usedBy   : akun yang sudah memakai (hanya untuk voucher berbatas, satu akun satu slot)
   - reserved : slot yang sedang dikunci pesanan QRIS yang belum dibayar

   "Siapa cepat dia dapat" harus dikunci saat QRIS dibuat, bukan saat bayar. Kalau tidak, orang
   ke-4 masih bisa membuat QRIS selama tiga orang pertama belum membayar, lalu semuanya membayar
   dengan harga diskon. Karena itu pesanan memesan slot lebih dulu (reserveSlot), dan slot itu
   menjadi pemakaian tetap hanya ketika pembayarannya berhasil (consumeSlot). */

var db = require('./db');

/* Pesanan baru boleh belum tersimpan selama ini sejak slotnya dikunci (QRIS dibuat dulu di Midtrans) */
var RESERVE_GRACE_MS = 60 * 1000;
/* Sama dengan toleransi pembayaran terlambat di project-vip-checkout */
var LATE_PAY_GRACE_MS = 15 * 1000;

function fbKey(s) { return String(s).replace(/[.$#\[\]\/]/g, '_'); }
function accountKey(id) { return 'a_' + fbKey(id); }

/* Baca satu path dan bedakan "tidak ada" ({ ok: true, value: null }) dari "gagal baca" ({ ok: false }),
   supaya gangguan sesaat di database tidak dianggap voucher dihapus atau slot kosong. */
async function readStrict(path) {
    var secret = process.env.FIREBASE_DB_SECRET || '';
    if (!secret) return { ok: false };
    try {
        var r = await fetch(db.DB_URL + '/' + path + '.json?auth=' + secret);
        if (!r.ok) return { ok: false };
        return { ok: true, value: await r.json() };
    } catch (e) {
        return { ok: false };
    }
}

function planMap(v) {
    if (v.plans && typeof v.plans === 'object' && Object.keys(v.plans).length) return v.plans;
    var map = {};
    if (v.planId) {
        var normal = Number(v.normalPrice), fin = Number(v.finalPrice);
        map[v.planId] = { planLabel: v.planLabel || v.planId, normalPrice: normal, finalPrice: fin, discountAmount: Math.max(0, normal - fin), percent: Number(v.percent) || 0 };
    }
    return map;
}

function limitOf(v) {
    var n = Math.floor(Number(v.maxUses));
    return n > 0 ? n : 0;
}

/* Salinan voucher tanpa data akun, aman dikirim ke browser atau disimpan sebagai snapshot riwayat */
function stripPrivate(v) {
    var copy = Object.assign({}, v);
    delete copy.reserved;
    delete copy.usedBy;
    return copy;
}

/* Cara yang sama dengan transitionOrderAtomically: baca bersama ETag, tulis dengan if-match,
   ulangi kalau ada yang menulis lebih dulu. Mutator mengembalikan { save, voucher, result }. */
async function mutateVoucherAtomically(code, mutator) {
    var secret = process.env.FIREBASE_DB_SECRET || '';
    if (!secret) return { ok: false };
    var url = db.DB_URL + '/hidz_vouchers/' + encodeURIComponent(code) + '.json?auth=' + secret;
    for (var attempt = 0; attempt < 8; attempt++) {
        var r = await fetch(url, { headers: { 'X-Firebase-ETag': 'true' } });
        if (!r.ok) return { ok: false };
        var etag = r.headers.get('etag');
        var current = await r.json();
        if (!current || typeof current !== 'object') return { ok: false, reason: 'not_found' };
        var next = mutator(current);
        if (!next || !next.save) return { ok: true, changed: false, voucher: current, result: next ? next.result : null };
        var w = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'if-match': etag || '*' }, body: JSON.stringify(next.voucher) });
        if (w.ok) return { ok: true, changed: true, voucher: next.voucher, result: next.result };
        if (w.status !== 412) return { ok: false };
        await new Promise(function (res) { setTimeout(res, 40 * (attempt + 1)); });
    }
    return { ok: false };
}

/* Id pesanan yang slotnya sudah tidak ditahan: waktunya lewat, dibatalkan/gagal/kedaluwarsa,
   atau pesanannya tidak pernah tersimpan. Pesanan PENDING dan SUCCESS tetap menahan slot. */
async function freedReservations(v, now) {
    var reserved = v.reserved || {}, freed = [];
    await Promise.all(Object.keys(reserved).map(async function (id) {
        var r = reserved[id] || {};
        if (now > Number(r.expiresAt) + LATE_PAY_GRACE_MS) { freed.push(id); return; }
        var rd = await readStrict('hidz_vip_orders/' + id);
        if (!rd.ok) return; /* tidak bisa memastikan: slot tetap dianggap ditahan */
        var ord = rd.value;
        if (!ord || typeof ord !== 'object') {
            if (now - Number(r.createdAt) > RESERVE_GRACE_MS) freed.push(id);
            return;
        }
        if (ord.status !== 'PENDING' && ord.status !== 'SUCCESS') freed.push(id);
    }));
    return freed;
}

function slotState(v, freed, accountId) {
    var limit = limitOf(v), reserved = v.reserved || {}, holding = 0, mine = false;
    Object.keys(reserved).forEach(function (id) {
        if (freed.indexOf(id) !== -1) return;
        holding++;
        if (reserved[id] && reserved[id].accountId === accountId) mine = true;
    });
    var used = Number(v.usedCount) || 0;
    return {
        limit: limit, used: used, holding: holding, mine: mine,
        alreadyUsed: !!(v.usedBy && v.usedBy[accountKey(accountId)]),
        remaining: limit ? Math.max(0, limit - used - holding) : null
    };
}

/* null kalau akun ini boleh memakai voucher, selain itu alasan penolakannya */
function slotProblem(st) {
    if (!st.limit || st.mine) return null;
    if (st.alreadyUsed) return { reason: 'already_used', message: 'Voucher ini sudah pernah kamu pakai. Satu akun hanya bisa memakainya sekali.' };
    if (st.remaining <= 0) {
        return {
            reason: 'exhausted',
            message: st.used >= st.limit ? 'Kuota voucher sudah habis.' : 'Kuota voucher sedang penuh karena masih ada yang menyelesaikan pembayaran. Coba lagi beberapa menit lagi.'
        };
    }
    return null;
}

var NOT_FOUND = { valid: false, reason: 'not_found', message: 'Kode voucher tidak ditemukan atau tidak valid.' };
var UNAVAILABLE = { valid: false, reason: 'unavailable', message: 'Voucher belum bisa diperiksa, coba lagi sebentar lagi.' };

/* Periksa voucher untuk akun ini (dan paket tertentu kalau planId diisi), tanpa mengubah apa pun */
async function validate(rawCode, planId, accountId) {
    var code = String(rawCode || '').trim().toUpperCase();
    if (!code || !/^[A-Z0-9]{4,20}$/.test(code)) return NOT_FOUND;
    var rd = await readStrict('hidz_vouchers/' + code);
    if (!rd.ok) return UNAVAILABLE;
    var v = rd.value;
    if (!v || typeof v !== 'object' || v.status === 'deleted') return NOT_FOUND;
    var now = Date.now();
    if (v.expiresAt && now > Number(v.expiresAt)) return { valid: false, reason: 'expired', message: 'Kode voucher sudah kedaluwarsa.' };

    var map = planMap(v), ids = Object.keys(map);
    if (!ids.length) return NOT_FOUND;
    if (planId && !map[planId]) {
        var labels = ids.map(function (id) { return map[id].planLabel || id; });
        return { valid: false, reason: 'wrong_plan', message: 'Voucher ini hanya berlaku untuk paket ' + labels.join(', ') + '.' };
    }

    var st = slotState(v, await freedReservations(v, now), accountId);
    var problem = slotProblem(st);
    if (problem) return { valid: false, reason: problem.reason, message: problem.message };

    return {
        valid: true,
        voucher: {
            code: v.code || code, discountType: v.discountType, expiresAt: Number(v.expiresAt),
            maxUses: st.limit, usedCount: st.used, remaining: st.remaining, plans: map
        }
    };
}

/* Kunci satu slot untuk pesanan ini. Voucher tanpa batas orang tidak mengunci apa pun. */
async function reserveSlot(rawCode, account, orderId, createdAt, orderExpiresAt) {
    var code = String(rawCode || '').trim().toUpperCase();
    var rd = await readStrict('hidz_vouchers/' + code);
    if (!rd.ok) return { ok: false, reason: 'unavailable', message: UNAVAILABLE.message };
    var first = rd.value;
    if (!first || typeof first !== 'object') return { ok: false, reason: 'not_found', message: NOT_FOUND.message };
    if (!limitOf(first)) return { ok: true };

    var freed = await freedReservations(first, createdAt);
    var out = await mutateVoucherAtomically(code, function (cur) {
        if (!limitOf(cur)) return { save: false, result: { ok: true } };
        var reserved = Object.assign({}, cur.reserved);
        freed.forEach(function (id) { delete reserved[id]; });
        var problem = slotProblem(slotState(Object.assign({}, cur, { reserved: reserved }), [], account.id));
        if (problem) return { save: false, result: { ok: false, reason: problem.reason, message: problem.message } };
        reserved[fbKey(orderId)] = { accountId: account.id, createdAt: createdAt, expiresAt: orderExpiresAt };
        return { save: true, voucher: Object.assign({}, cur, { reserved: reserved }), result: { ok: true } };
    });
    if (out.reason === 'not_found') return { ok: false, reason: 'not_found', message: NOT_FOUND.message };
    if (!out.ok) return { ok: false, reason: 'busy', message: 'Gagal mengunci kuota voucher. Coba lagi.' };
    return out.result;
}

/* Lepas slot pesanan yang gagal dibuat. Pesanan yang dibatalkan atau kedaluwarsa tidak perlu lewat sini:
   slotnya otomatis dianggap bebas oleh freedReservations. */
async function releaseSlot(rawCode, orderId) {
    var key = fbKey(orderId);
    await mutateVoucherAtomically(String(rawCode || '').trim().toUpperCase(), function (cur) {
        if (!cur.reserved || !cur.reserved[key]) return { save: false };
        var reserved = Object.assign({}, cur.reserved);
        delete reserved[key];
        return { save: true, voucher: Object.assign({}, cur, { reserved: reserved }) };
    });
}

/* Pembayaran berhasil: catat pemakaian, dan untuk voucher berbatas ubah slot terkunci jadi pemakaian tetap.
   Mengembalikan voucher terbaru (tanpa data akun), atau null kalau voucher sudah dihapus admin. */
async function consumeSlot(rawCode, order, usedAt) {
    var out = await mutateVoucherAtomically(String(rawCode || '').trim().toUpperCase(), function (cur) {
        var next = Object.assign({}, cur, { usedCount: (Number(cur.usedCount) || 0) + 1, lastUsedAt: usedAt });
        if (limitOf(cur)) {
            var reserved = Object.assign({}, cur.reserved), usedBy = Object.assign({}, cur.usedBy);
            delete reserved[fbKey(order.orderId)];
            usedBy[accountKey(order.accountId)] = { orderId: order.orderId, at: usedAt };
            next.reserved = reserved;
            next.usedBy = usedBy;
        }
        return { save: true, voucher: next };
    });
    return (out.ok && out.voucher) ? stripPrivate(out.voucher) : null;
}

/* Apakah voucher masih menjadi dasar harga sebuah pesanan yang belum dibayar: masih ada (belum dihapus admin),
   belum kedaluwarsa, dan masih mencakup paket pesanan. true / false, atau null kalau database tidak bisa dibaca. */
async function isHonored(rawCode, planId) {
    var rd = await readStrict('hidz_vouchers/' + String(rawCode || '').trim().toUpperCase());
    if (!rd.ok) return null;
    var v = rd.value;
    if (!v || typeof v !== 'object' || v.status === 'deleted') return false;
    if (v.expiresAt && Date.now() > Number(v.expiresAt)) return false;
    return !!planMap(v)[planId];
}

module.exports = { validate: validate, reserveSlot: reserveSlot, releaseSlot: releaseSlot, consumeSlot: consumeSlot, isHonored: isHonored };
