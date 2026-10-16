var db = require('./_lib/db');
var securityGuard = require('./_lib/security');

module.exports = async function (req, res) {
    if (!(await securityGuard.guard(req, res))) return;
    if (req.method !== 'POST') {
        res.status(200).json({ valid: true });
        return;
    }

    var body = req.body || {};
    var id   = typeof body.id === 'string' ? body.id : '';
    var role = typeof body.role === 'string' ? body.role : '';

    if (!id || role === 'admin') {
        res.status(200).json({ valid: true });
        return;
    }

    var list = await db.fetchAllAccounts();
    if (list === null) {
        res.status(200).json({ valid: true });
        return;
    }

    var found = null;
    for (var i = 0; i < list.length; i++) {
        if (list[i].id === id) { found = list[i]; break; }
    }

    if (!found) {
        res.status(200).json({ valid: false, reason: 'deleted' });
        return;
    }

    var now = Date.now();
    var hasPaused = (typeof found.pausedRemainingMs === 'number' && found.pausedRemainingMs > 0);
    var effectiveExpiresAt = hasPaused ? (now + found.pausedRemainingMs) : found.expiresAt;

    if (!hasPaused && found.expiresAt && now > found.expiresAt) {
        res.status(200).json({ valid: false, reason: 'expired' });
        return;
    }

    res.status(200).json({
        valid: true,
        expiresAt: (typeof effectiveExpiresAt === 'number') ? effectiveExpiresAt : null,
        durationLabel: found.durationLabel || null
    });
};
