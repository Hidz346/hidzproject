var db = require('./_lib/db');
var securityGuard = require('./_lib/security');
var vipCheckout = require('./_lib/project-vip-checkout');

module.exports = async function (req, res) {
    var queryAction = (req.query && req.query.vipAction) || (req.body && req.body.vipAction) || '';
    if (queryAction === 'webhook') {
        await vipCheckout.handleAction('webhook', req, res);
        return;
    }
    if (!(await securityGuard.guard(req, res))) return;
    if (queryAction) {
        await vipCheckout.handleAction(String(queryAction), req, res);
        return;
    }
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
        role: found.role || 'user',
        durationMs: (typeof found.durationMs === 'number') ? found.durationMs : null,
        expiresAt: (typeof effectiveExpiresAt === 'number') ? effectiveExpiresAt : null,
        durationLabel: found.durationLabel || null
    });
};
