var crypto = require('crypto');
var db = require('./db');
var pw = require('./password');
var firebaseAuth = require('./firebase-auth');
var gateway = require('./midtrans-qris-gateway');
var vouchers = require('./vip-vouchers');

var DAY_MS = 86400000;
var ORDER_EXPIRY_MS = 5 * 60 * 1000;
var VIP_ORDER_RATE_PATH = 'hidz_vip_rate_limit';

var DEFAULT_VIP_PLANS = [
    { id: '1d',  label: '1 Day',   days: 1,   price: 3000,   durationMs: 1 * DAY_MS,   durationLabel: '1 HARI' },
    { id: '3d',  label: '3 Day',   days: 3,   price: 5000,   durationMs: 3 * DAY_MS,   durationLabel: '3 HARI' },
    { id: '7d',  label: '7 Day',   days: 7,   price: 10000,  durationMs: 7 * DAY_MS,   durationLabel: '7 HARI' },
    { id: '14d', label: '14 Day',  days: 14,  price: 15000,  durationMs: 14 * DAY_MS,  durationLabel: '14 HARI' },
    { id: '1m',  label: '1 Month', days: 30,  price: 20000,  durationMs: 30 * DAY_MS,  durationLabel: '1 BULAN' },
    { id: '3m',  label: '3 Month', days: 90,  price: 30000,  durationMs: 90 * DAY_MS,  durationLabel: '3 BULAN' },
    { id: '5m',  label: '5 Month', days: 150, price: 50000,  durationMs: 150 * DAY_MS, durationLabel: '5 BULAN' },
    { id: '1y',  label: '1 Year',  days: 365, price: 100000, durationMs: 365 * DAY_MS, durationLabel: '1 TAHUN' }
];

function msToLabel(ms) {
    if (ms === null || ms === undefined) return 'UNLIMITED';
    var units = [['TAHUN', 365 * DAY_MS], ['BULAN', 30 * DAY_MS], ['MINGGU', 7 * DAY_MS], ['HARI', DAY_MS], ['JAM', 3600000], ['MENIT', 60000]];
    for (var i = 0; i < units.length; i++) {
        if (ms >= units[i][1] && ms % units[i][1] === 0) return (ms / units[i][1]) + ' ' + units[i][0];
    }
    return Math.max(1, Math.round(ms / DAY_MS)) + ' HARI';
}

function makeVerificationCode(order) {
    var secret = process.env.VIP_RECEIPT_HMAC_SECRET || process.env.FIREBASE_DB_SECRET || 'hidz_default_hmac';
    var payload = [order.orderId, order.accountId, order.username, order.planId, order.totalAmount, order.paidAt || order.createdAt].join('|');
    return 'HZV-' + crypto.createHmac('sha256', secret).update(payload).digest('hex').slice(0, 16).toUpperCase();
}

async function getCatalogPlans() {
    var stored = await db.fetchPath('hidz_vip_plans');
    if (Array.isArray(stored) && stored.length === 8) return stored;
    await db.setPath('hidz_vip_plans', DEFAULT_VIP_PLANS);
    return DEFAULT_VIP_PLANS;
}

async function authenticateCustomer(req) {
    var body = req.body || {};
    var token = firebaseAuth.bearerToken(req);
    var list = await db.fetchAllAccounts();
    if (!list) return { ok: false, reason: 'db_error' };
    if (token) {
        try {
            var claims = await firebaseAuth.verifyIdToken(token);
            var uid = claims.user_id || claims.sub;
            if (uid === 'admin_hidz_protected' || claims.role === 'admin') return { ok: false, reason: 'admin_cannot_buy' };
            var acc = list.filter(function (u) { return u && u.id === uid; })[0];
            if (acc) return { ok: true, account: acc };
        } catch (e) {}
    }
    var id = typeof body.id === 'string' ? body.id : '';
    var username = typeof body.username === 'string' ? body.username : '';
    var password = typeof body.password === 'string' ? body.password : '';
    if (!id || !username || !password) return { ok: false, reason: 'auth_required' };
    if (id === 'admin_hidz_protected') return { ok: false, reason: 'admin_cannot_buy' };
    var found = list.filter(function (u) { return u && u.id === id; })[0];
    if (!found) return { ok: false, reason: 'not_found' };
    if ((found.username || '').toLowerCase() !== username.toLowerCase() || !pw.verifyPassword(password, found.password)) return { ok: false, reason: 'auth_required' };
    if (found.role === 'admin') return { ok: false, reason: 'admin_cannot_buy' };
    return { ok: true, account: found };
}

async function transitionOrderAtomically(orderId, mutator) {
    var secret = process.env.FIREBASE_DB_SECRET || '';
    if (!secret) return { ok: false };
    var url = db.DB_URL + '/hidz_vip_orders/' + encodeURIComponent(orderId) + '.json?auth=' + secret;
    for (var attempt = 0; attempt < 8; attempt++) {
        var r = await fetch(url, { headers: { 'X-Firebase-ETag': 'true' } });
        if (!r.ok) return { ok: false };
        var etag = r.headers.get('etag');
        var current = await r.json();
        if (!current || typeof current !== 'object') return { ok: false, reason: 'not_found' };
        var next = mutator(current);
        if (!next || !next.save) return { ok: true, changed: false, order: current, result: next ? next.result : null };
        var w = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'if-match': etag || '*' }, body: JSON.stringify(next.order) });
        if (w.ok) return { ok: true, changed: true, order: next.order, result: next.result };
        if (w.status !== 412) return { ok: false };
        await new Promise(function (res) { setTimeout(res, 40 * (attempt + 1)); });
    }
    return { ok: false };
}

async function fulfillOrderSuccess(orderId, settlementMeta) {
    var now = Date.now();
    var lockRes = await transitionOrderAtomically(orderId, function (ord) {
        if (ord.status === 'SUCCESS') return { save: false, result: { alreadySuccess: true } };
        if (ord.status === 'EXPIRED' || ord.status === 'CANCELLED' || now > Number(ord.expiresAt) + 15000) {
            if (ord.status !== 'LATE_PAYMENT') {
                return { save: true, order: Object.assign({}, ord, { status: 'LATE_PAYMENT', latePaidAt: now, providerSettlement: settlementMeta || null }), result: { latePayment: true } };
            }
            return { save: false, result: { latePayment: true } };
        }
        if (ord.status !== 'PENDING') return { save: false, result: { ignored: true } };
        var lockedOrd = Object.assign({}, ord, { status: 'SUCCESS', paidAt: now, providerSettlement: settlementMeta || null });
        lockedOrd.verificationCode = makeVerificationCode(lockedOrd);
        return { save: true, order: lockedOrd, result: { lockedForActivation: true } };
    });
    if (!lockRes.ok) return { ok: false };
    if (!lockRes.changed) return { ok: true, order: lockRes.order };
    if (lockRes.result && lockRes.result.latePayment) return { ok: true, order: lockRes.order, latePayment: true };

    var order = lockRes.order;
    var maint = await db.fetchPath('hidz_maintenance_mode');
    var maintActive = !!(maint && maint.active === true);
    var addMs = Number(order.durationMs) || DAY_MS;

    var accMut = await db.mutateAccounts(function (list) {
        var target = list.filter(function (u) { return u && u.id === order.accountId; })[0];
        if (!target) return { save: false, result: { accountMissing: true } };
        var beforeSnapshot = { role: target.role || 'user', durationMs: target.durationMs || null, expiresAt: target.expiresAt || null, durationLabel: target.durationLabel || '-', activated: !!target.activated };
        var wasVip = (target.role === 'vip');
        var pending = !target.activated || !target.expiresAt;
        var hasPause = !pending && ((typeof target.pausedRemainingMs === 'number' && target.pausedRemainingMs > 0) || (maintActive && maint.startedAt && target.expiresAt > maint.startedAt));
        var pausedRem = hasPause ? ((typeof target.pausedRemainingMs === 'number' && target.pausedRemainingMs > 0) ? target.pausedRemainingMs : Math.max(0, target.expiresAt - maint.startedAt)) : 0;
        var isExp = !pending && !hasPause && target.expiresAt && now > target.expiresAt;

        target.role = 'vip';
        if (!wasVip) {
            target.activated = true; target.loggedOut = false; target.durationMs = addMs; target.expiresAt = now + addMs;
            if (maintActive) { target.pausedRemainingMs = addMs; target.pausedAt = (maint && maint.startedAt) || now; }
            else { delete target.pausedRemainingMs; delete target.pausedAt; }
        } else {
            if (pending) { target.activated = true; target.loggedOut = false; target.durationMs = (target.durationMs || 0) + addMs; target.expiresAt = now + target.durationMs; }
            else if (isExp) { target.activated = true; target.loggedOut = false; delete target.pausedRemainingMs; delete target.pausedAt; target.durationMs = addMs; target.expiresAt = now + addMs; }
            else {
                if (hasPause) { target.pausedRemainingMs = pausedRem + addMs; if (!target.pausedAt) target.pausedAt = (maint && maint.startedAt) || now; }
                target.expiresAt = target.expiresAt + addMs; target.durationMs = (target.durationMs || 0) + addMs;
            }
        }
        target.durationLabel = msToLabel(target.durationMs);
        var afterSnapshot = { role: target.role, durationMs: target.durationMs, expiresAt: target.expiresAt, durationLabel: target.durationLabel, activated: !!target.activated };
        return { save: true, result: { beforeSnapshot: beforeSnapshot, afterSnapshot: afterSnapshot } };
    });

    var activatedAt = Date.now();
    var snaps = (accMut.ok && accMut.result) ? accMut.result : {};
    var finalOrder = Object.assign({}, order, {
        activatedAt: activatedAt,
        beforeSnapshot: snaps.beforeSnapshot || order.beforeSnapshot || null,
        afterSnapshot: snaps.afterSnapshot || { role: 'vip', durationMs: addMs, expiresAt: activatedAt + addMs, durationLabel: order.planDurationLabel || msToLabel(addMs), activated: true }
    });
    await db.setPath('hidz_vip_orders/' + orderId, finalOrder);

    if (order.voucherCode) {
        var vCode = String(order.voucherCode).toUpperCase();
        var vData = await vouchers.consumeSlot(vCode, order, activatedAt);
        /* Voucher yang sudah dihapus admin (beserta riwayatnya) tidak dicatat lagi, supaya riwayat
           yatim tidak muncul kembali di panel admin. Pesanannya sendiri tetap menyimpan kode vouchernya. */
        if (vData) {
            var histId = 'vh_' + activatedAt + '_' + crypto.randomBytes(3).toString('hex');
            await db.setPath('hidz_voucher_history/' + histId, {
                id: histId, code: vCode, action: 'used', username: order.username, orderId: order.orderId,
                planId: order.planId, planLabel: order.planLabel, discountAmount: order.discountAmount || 0,
                finalPrice: order.totalAmount, actor: order.username, timestamp: activatedAt, snapshot: vData
            });
        }
    }
    return { ok: true, order: finalOrder };
}

async function syncOrderStatus(order) {
    if (!order || typeof order !== 'object' || order.status !== 'PENDING') return order;
    var now = Date.now();
    var st = await gateway.getStatus(order.orderId);
    if (st.ok) {
        if ((st.transactionStatus === 'settlement' || st.transactionStatus === 'capture') && st.fraudStatus === 'accept' && st.grossAmount === Number(order.totalAmount)) {
            var fulfilled = await fulfillOrderSuccess(order.orderId, st);
            if (fulfilled.ok && fulfilled.order) return fulfilled.order;
        } else if (st.transactionStatus === 'cancel' || st.transactionStatus === 'deny' || st.transactionStatus === 'expire') {
            var nextSt = st.transactionStatus === 'expire' ? 'EXPIRED' : (st.transactionStatus === 'cancel' ? 'CANCELLED' : 'FAILED');
            var upd = await transitionOrderAtomically(order.orderId, function (cur) {
                if (cur.status !== 'PENDING') return { save: false };
                return { save: true, order: Object.assign({}, cur, { status: nextSt, updatedAt: now }) };
            });
            if (upd.ok && upd.order) return upd.order;
        }
    }
    if (now > Number(order.expiresAt)) {
        var expUpd = await transitionOrderAtomically(order.orderId, function (cur) {
            if (cur.status !== 'PENDING') return { save: false };
            return { save: true, order: Object.assign({}, cur, { status: 'EXPIRED', expiredAt: now }) };
        });
        try { await gateway.cancelOrder(order.orderId); } catch (e) {}
        if (expUpd.ok && expUpd.order) return expUpd.order;
    }
    return order;
}

async function handleAction(action, req, res) {
    var body = req.body || {};
    var now = Date.now();
    if (action === 'webhook') {
        if (!gateway.verifyWebhook(body)) { res.status(401).json({ ok: false, error: 'INVALID_SIGNATURE' }); return; }
        var orderId = String(body.order_id || ''), txStatus = String(body.transaction_status || '').toLowerCase(), fraudStatus = String(body.fraud_status || 'accept').toLowerCase(), grossAmount = Math.round(Number(body.gross_amount || 0));
        var existing = await db.fetchPath('hidz_vip_orders/' + orderId);
        if (!existing) { res.status(200).json({ ok: true, ignored: true }); return; }
        if (grossAmount !== Number(existing.totalAmount)) { res.status(400).json({ ok: false, error: 'AMOUNT_MISMATCH' }); return; }
        if ((txStatus === 'settlement' || txStatus === 'capture') && fraudStatus === 'accept') {
            await fulfillOrderSuccess(orderId, { transactionStatus: txStatus, transactionId: body.transaction_id || '', settlementTime: body.settlement_time || '' });
            res.status(200).json({ ok: true }); return;
        }
        if (txStatus === 'expire' || txStatus === 'cancel' || txStatus === 'deny') {
            var mapped = txStatus === 'expire' ? 'EXPIRED' : (txStatus === 'cancel' ? 'CANCELLED' : 'FAILED');
            await transitionOrderAtomically(orderId, function (cur) {
                if (cur.status !== 'PENDING') return { save: false };
                return { save: true, order: Object.assign({}, cur, { status: mapped, updatedAt: now }) };
            });
        }
        res.status(200).json({ ok: true }); return;
    }
    if (action === 'plans') {
        res.status(200).json({ ok: true, serverNow: now, plans: await getCatalogPlans() }); return;
    }
    var auth = await authenticateCustomer(req);
    if (!auth.ok) { res.status(200).json({ ok: false, reason: auth.reason }); return; }
    var account = auth.account;

    if (action === 'voucher-check') {
        var rlKey = 'vchk_' + account.id;
        var limit = await db.checkRateLimitByKey(VIP_ORDER_RATE_PATH, rlKey);
        if (limit.blocked) { res.status(200).json({ ok: false, locked: true, retryAfterSec: limit.retryAfterSec, message: 'Terlalu banyak percobaan voucher. Coba lagi dalam ' + limit.retryAfterSec + ' detik.' }); return; }
        var vRes = await vouchers.validate(body.code, body.planId || '', account.id);
        if (!vRes.valid) {
            if (!body.silentPoll) await db.registerRateLimitFailByKey(VIP_ORDER_RATE_PATH, rlKey);
            res.status(200).json({ ok: false, reason: vRes.reason, message: vRes.message }); return;
        }
        await db.clearRateLimitByKey(VIP_ORDER_RATE_PATH, rlKey);
        res.status(200).json({ ok: true, serverNow: now, voucher: vRes.voucher }); return;
    }

    if (action === 'order-create') {
        var ordRlKey = 'ord_' + account.id;
        var ordLimit = await db.checkRateLimitByKey(VIP_ORDER_RATE_PATH, ordRlKey);
        if (ordLimit.blocked) { res.status(200).json({ ok: false, message: 'Terlalu sering membuat QRIS. Tunggu ' + ordLimit.retryAfterSec + ' detik.' }); return; }
        var catalog = await getCatalogPlans();
        var plan = catalog.filter(function (p) { return p.id === String(body.planId || '').trim(); })[0];
        if (!plan) { res.status(200).json({ ok: false, message: 'Paket VIP tidak valid.' }); return; }

        var allOrders = (await db.fetchPath('hidz_vip_orders')) || {};
        var orderIds = Object.keys(allOrders);
        for (var i = 0; i < orderIds.length; i++) {
            var o = allOrders[orderIds[i]];
            if (o && o.accountId === account.id && o.status === 'PENDING') {
                var synced = await syncOrderStatus(o);
                if (synced && synced.status === 'PENDING' && Date.now() < Number(synced.expiresAt)) {
                    res.status(200).json({ ok: true, resumed: true, serverNow: Date.now(), order: synced }); return;
                }
            }
        }
        var normalPrice = Number(plan.price), finalPrice = normalPrice, discountAmount = 0, appliedVoucherCode = null, discountPercent = 0;
        if (body.voucherCode) {
            var vc = await vouchers.validate(body.voucherCode, plan.id, account.id);
            if (!vc.valid) { res.status(200).json({ ok: false, reason: 'voucher_invalid', voucherReason: vc.reason, message: vc.message }); return; }
            var vPlan = vc.voucher.plans[plan.id];
            /* Harga voucher dibekukan saat voucher dibuat; kalau harga katalog kemudian diturunkan sampai
               di bawahnya, voucher tidak boleh membuat harganya justru naik. */
            finalPrice = Math.min(Number(vPlan.finalPrice), normalPrice);
            discountAmount = normalPrice - finalPrice; appliedVoucherCode = vc.voucher.code; discountPercent = Number(vPlan.percent) || 0;
        }
        var createdAt = Date.now(), expiresAt = createdAt + ORDER_EXPIRY_MS;
        var newOrderId = 'HZVIP-' + createdAt + '-' + crypto.randomBytes(2).toString('hex').toUpperCase();
        /* Voucher berbatas orang: slot dikunci sebelum QRIS dibuat, supaya siapa yang lebih dulu membuat
           pesanan yang dapat, dan pesanan ke-(batas+1) ditolak walau yang lain belum membayar. */
        if (appliedVoucherCode) {
            var slot = await vouchers.reserveSlot(appliedVoucherCode, account, newOrderId, createdAt, expiresAt);
            if (!slot.ok) { res.status(200).json({ ok: false, reason: 'voucher_invalid', voucherReason: slot.reason, message: slot.message }); return; }
        }
        var newOrder = {
            orderId: newOrderId, status: 'PENDING', accountId: account.id, username: account.username,
            planId: plan.id, planLabel: plan.label, days: plan.days, durationMs: plan.durationMs, planDurationLabel: plan.durationLabel,
            normalPrice: normalPrice, voucherCode: appliedVoucherCode, discountPercent: discountPercent, discountAmount: discountAmount, totalAmount: finalPrice,
            merchantName: 'Hidz Store', merchantNmid: 'ID1026609601806', paymentMethod: 'QRIS',
            createdAt: createdAt, expiresAt: expiresAt, paidAt: null, activatedAt: null, verificationCode: null,
            beforeSnapshot: { role: account.role || 'user', durationMs: account.durationMs || null, expiresAt: account.expiresAt || null, durationLabel: account.durationLabel || '-', activated: !!account.activated },
            afterSnapshot: null
        };
        var qrisRes = await gateway.createQris(newOrder);
        if (!qrisRes.ok) {
            if (appliedVoucherCode) await vouchers.releaseSlot(appliedVoucherCode, newOrderId);
            await db.registerRateLimitFailByKey(VIP_ORDER_RATE_PATH, ordRlKey);
            var humanMsg = qrisRes.reason === 'MIDTRANS_NOT_CONFIGURED' ? 'MIDTRANS_SERVER_KEY belum diatur di Environment Variables Vercel.' : 'Gagal membuat QRIS (' + qrisRes.reason + '). Coba lagi.';
            res.status(200).json({ ok: false, reason: qrisRes.reason, message: humanMsg }); return;
        }
        newOrder.provider = qrisRes.provider; newOrder.providerRef = qrisRes.providerRef; newOrder.qrString = qrisRes.qrString || ''; newOrder.qrImageUrl = qrisRes.qrImageUrl || '';
        await db.setPath('hidz_vip_orders/' + newOrderId, newOrder);
        res.status(200).json({ ok: true, resumed: false, serverNow: Date.now(), order: newOrder }); return;
    }

    if (action === 'order-status') {
        var checkOrderId = String(body.orderId || '').trim();
        if (!checkOrderId) {
            var allOrd = (await db.fetchPath('hidz_vip_orders')) || {};
            var myPending = Object.values(allOrd).filter(function (o) { return o && o.accountId === account.id && o.status === 'PENDING'; })[0];
            if (!myPending) { res.status(200).json({ ok: true, serverNow: Date.now(), order: null }); return; }
            res.status(200).json({ ok: true, serverNow: Date.now(), order: await syncOrderStatus(myPending) }); return;
        }
        var ord = await db.fetchPath('hidz_vip_orders/' + checkOrderId);
        if (!ord || ord.accountId !== account.id) { res.status(200).json({ ok: false, message: 'Transaksi tidak ditemukan.' }); return; }
        res.status(200).json({ ok: true, serverNow: Date.now(), order: await syncOrderStatus(ord) }); return;
    }

    if (action === 'order-cancel') {
        var cancelOrderId = String(body.orderId || '').trim();
        var targetOrd = await db.fetchPath('hidz_vip_orders/' + cancelOrderId);
        if (!targetOrd || targetOrd.accountId !== account.id) { res.status(200).json({ ok: false, message: 'Pesanan tidak ditemukan.' }); return; }
        if (targetOrd.status !== 'PENDING') { res.status(200).json({ ok: true, order: targetOrd }); return; }
        try { await gateway.cancelOrder(cancelOrderId); } catch (e) {}
        var cancelled = await transitionOrderAtomically(cancelOrderId, function (cur) {
            if (cur.status !== 'PENDING') return { save: false };
            return { save: true, order: Object.assign({}, cur, { status: 'CANCELLED', cancelledAt: Date.now() }) };
        });
        res.status(200).json({ ok: true, serverNow: Date.now(), order: cancelled.order || targetOrd }); return;
    }

    if (action === 'transactions') {
        var rawOrders = (await db.fetchPath('hidz_vip_orders')) || {};
        var myOrders = Object.values(rawOrders).filter(function (o) { return o && o.accountId === account.id && o.status === 'SUCCESS'; }).sort(function (a, b) { return (Number(b.paidAt || b.createdAt) || 0) - (Number(a.paidAt || a.createdAt) || 0); });
        res.status(200).json({ ok: true, serverNow: Date.now(), items: myOrders }); return;
    }
    res.status(200).json({ ok: false, message: 'Aksi tidak dikenali.' });
}

module.exports = { handleAction: handleAction, DEFAULT_VIP_PLANS: DEFAULT_VIP_PLANS };
