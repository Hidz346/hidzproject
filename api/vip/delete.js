/* Hapus akun role=user dari Panel VIP, sekalian bersihkan jejaknya di
   hidz_sessions/hidz_banned/hidz_blocked_devices — persis seperti yang
   dilakukan Panel VIP versi lama, cuma sekarang eksekusinya di server. */

var db = require('../_lib/db');

var securityGuard = require('../_lib/security');

/* Sama seperti vip/create.js — lockout brute-force di-key pakai vipId,
   di luar rate limit umum 90 req/menit dari security.js. */
var VIP_RATE_PATH = 'hidz_vip_rate_limit';

module.exports = async function (req, res) {
    if (!(await securityGuard.guard(req, res))) return;
    if (req.method !== 'POST') {
        res.status(200).json({ ok: false });
        return;
    }

    var body        = req.body || {};
    var vipId       = typeof body.vipId === 'string' ? body.vipId : '';
    var vipUsername = typeof body.vipUsername === 'string' ? body.vipUsername : '';
    var vipPassword = typeof body.vipPassword === 'string' ? body.vipPassword : '';
    var targetId    = typeof body.targetId === 'string' ? body.targetId : '';

    if (!vipId || !vipUsername || !vipPassword || !targetId) {
        res.status(200).json({ ok: false });
        return;
    }

    var limit = await db.checkRateLimitByKey(VIP_RATE_PATH, vipId);
    if (limit.blocked) {
        res.status(200).json({ ok: false, locked: true, retryAfterSec: limit.retryAfterSec });
        return;
    }

    var list = await db.fetchAllAccounts();
    if (list === null) {
        res.status(200).json({ ok: false, error: true });
        return;
    }

    var me = db.findValidVip(list, vipId, vipUsername, vipPassword);
    if (!me) {
        await db.registerRateLimitFailByKey(VIP_RATE_PATH, vipId);
        res.status(200).json({ ok: false });
        return;
    }
    await db.clearRateLimitByKey(VIP_RATE_PATH, vipId);

    var target = list.filter(function (u) { return u.id === targetId; })[0];
    if (!target || target.role !== 'user') {
        res.status(200).json({ ok: false, reason: 'not_found' });
        return;
    }

    var remaining = list.filter(function (u) { return u.id !== targetId; });
    var ok = await db.saveAllAccounts(remaining);
    if (!ok) {
        res.status(200).json({ ok: false, error: true });
        return;
    }

    await db.removeAccountTraces(targetId);
    res.status(200).json({ ok: true });
};
