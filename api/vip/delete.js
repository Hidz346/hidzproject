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

    var out = await db.mutateAccounts(function (list) {
        var me = db.findValidVip(list, vipId, vipUsername, vipPassword);
        if (!me) return { save: false, result: { valid: false } };

        var target = list.filter(function (u) { return u.id === targetId; })[0];
        if (!target || target.role !== 'user') {
            return { save: false, result: { valid: true, response: { ok: false, reason: 'not_found' } } };
        }

        return {
            save: true,
            list: list.filter(function (u) { return u.id !== targetId; }),
            result: { valid: true, response: { ok: true } }
        };
    });

    if (!out.ok) {
        res.status(200).json({ ok: false, error: true });
        return;
    }
    if (!out.result.valid) {
        await db.registerRateLimitFailByKey(VIP_RATE_PATH, vipId);
        res.status(200).json({ ok: false });
        return;
    }
    await db.clearRateLimitByKey(VIP_RATE_PATH, vipId);

    if (out.result.response.ok) await db.removeAccountTraces(targetId);
    res.status(200).json(out.result.response);
};
