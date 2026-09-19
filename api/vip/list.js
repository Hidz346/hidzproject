/* Panel VIP butuh lihat daftar akun role=user buat dikelola. Dulu ini
   didapat dengan download SELURUH hidz_access_db langsung ke browser
   (termasuk password VIP lain & admin) baru difilter di JS. Sekarang
   filternya dilakukan di server — VIP yang login cuma dikasih apa yang
   memang perlu dia lihat. */

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

    if (!vipId || !vipUsername || !vipPassword) {
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

    var users = list.filter(function (u) { return u.role === 'user'; }).map(function (u) {
        var copy = {};
        Object.keys(u).forEach(function (k) { if (k !== 'password') copy[k] = u[k]; });
        return copy;
    });
    res.status(200).json({ ok: true, users: users });
};
