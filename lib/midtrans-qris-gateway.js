var crypto = require('crypto');

function isProduction() {
    return String(process.env.MIDTRANS_IS_PRODUCTION || '').toLowerCase() === 'true';
}
function baseUrl() {
    return isProduction() ? 'https://api.midtrans.com' : 'https://api.sandbox.midtrans.com';
}
function authHeader() {
    var k = (process.env.MIDTRANS_SERVER_KEY || '').trim();
    return k ? ('Basic ' + Buffer.from(k + ':').toString('base64')) : null;
}

async function createQris(order) {
    var auth = authHeader();
    if (!auth) return { ok: false, reason: 'MIDTRANS_NOT_CONFIGURED' };
    var payload = {
        payment_type: 'qris',
        transaction_details: { order_id: String(order.orderId), gross_amount: Math.round(Number(order.totalAmount)) },
        item_details: [{ id: String(order.planId), price: Math.round(Number(order.totalAmount)), quantity: 1, name: ('VIP ' + String(order.planLabel || order.planId)).slice(0, 50) }],
        customer_details: { first_name: String(order.username || 'User').slice(0, 40) },
        custom_expiry: { expiry_duration: 5, unit: 'minute' }
    };
    try {
        var r = await fetch(baseUrl() + '/v2/charge', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'Authorization': auth },
            body: JSON.stringify(payload)
        });
        var data = await r.json();
        if (!data || (String(data.status_code) !== '201' && String(data.status_code) !== '200')) {
            return { ok: false, reason: (data && data.status_message) || 'CHARGE_FAILED' };
        }
        var qrImageUrl = '';
        if (Array.isArray(data.actions)) {
            data.actions.forEach(function (a) {
                if (a && a.url && a.name && a.name.indexOf('generate-qr-code') === 0) qrImageUrl = a.url;
            });
        }
        return {
            ok: true,
            provider: isProduction() ? 'midtrans_live' : 'midtrans_sandbox',
            providerRef: data.transaction_id || order.orderId,
            qrString: data.qr_string || '',
            qrImageUrl: qrImageUrl
        };
    } catch (e) {
        return { ok: false, reason: 'NETWORK_ERROR' };
    }
}

async function getStatus(orderId) {
    var auth = authHeader();
    if (!auth) return { ok: false, reason: 'MIDTRANS_NOT_CONFIGURED' };
    try {
        var r = await fetch(baseUrl() + '/v2/' + encodeURIComponent(orderId) + '/status', {
            method: 'GET',
            headers: { 'Accept': 'application/json', 'Authorization': auth }
        });
        var data = await r.json();
        if (!data || String(data.status_code) === '404') return { ok: false, reason: 'NOT_FOUND' };
        return {
            ok: true,
            transactionStatus: String(data.transaction_status || '').toLowerCase(),
            fraudStatus: String(data.fraud_status || 'accept').toLowerCase(),
            grossAmount: Math.round(Number(data.gross_amount || 0)),
            transactionId: data.transaction_id || '',
            settlementTime: data.settlement_time || data.transaction_time || ''
        };
    } catch (e) {
        return { ok: false, reason: 'NETWORK_ERROR' };
    }
}

async function cancelOrder(orderId) {
    var auth = authHeader();
    if (!auth) return false;
    try {
        var r = await fetch(baseUrl() + '/v2/' + encodeURIComponent(orderId) + '/cancel', {
            method: 'POST',
            headers: { 'Accept': 'application/json', 'Authorization': auth }
        });
        return r.ok;
    } catch (e) { return false; }
}

function verifyWebhook(body) {
    var serverKey = (process.env.MIDTRANS_SERVER_KEY || '').trim();
    if (!serverKey || !body || typeof body !== 'object') return false;
    var orderId = String(body.order_id || ''), statusCode = String(body.status_code || ''), grossAmount = String(body.gross_amount || ''), sig = String(body.signature_key || '').toLowerCase();
    if (!orderId || !statusCode || !grossAmount || !sig) return false;
    var expected = crypto.createHash('sha512').update(orderId + statusCode + grossAmount + serverKey).digest('hex').toLowerCase();
    if (expected.length !== sig.length) return false;
    try { return crypto.timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(sig, 'utf8')); } catch (e) { return false; }
}

module.exports = { createQris: createQris, getStatus: getStatus, cancelOrder: cancelOrder, verifyWebhook: verifyWebhook };
