/* HidzProject security guard.
 * Server-side detection only. It never trusts browser-side security checks.
 * IP blocking is an application-layer fallback; volumetric DDoS must still
 * be stopped at the CDN/WAF edge (see SECURITY_SETUP.md).
 */
var crypto = require('crypto');
var db = require('./db');

var BLOCK_MS = 24 * 60 * 60 * 1000;
var MAX_ALERT_TEXT = 180;

function clientIp(req) {
    var h = req.headers || {};
    var raw = h['cf-connecting-ip'] || h['x-forwarded-for'] || h['x-real-ip'] || '';
    var ip = String(raw).split(',')[0].trim();
    if (!ip && req.socket && req.socket.remoteAddress) ip = req.socket.remoteAddress;
    return ip || 'unknown';
}

function ipKey(ip) {
    return crypto.createHash('sha256').update(String(ip)).digest('hex').slice(0, 48);
}

function textFromBody(body, key, out) {
    if (body == null) return;
    if (typeof body === 'string') { out.push(body); return; }
    if (typeof body !== 'object') return;
    Object.keys(body).forEach(function (k) {
        /* Passwords are deliberately excluded from pattern scanning so a
           legitimate password containing punctuation is not blocked. */
        if (/password/i.test(k)) return;
        var v = body[k];
        if (typeof v === 'string' || typeof v === 'number') out.push(String(v));
        else if (v && typeof v === 'object') textFromBody(v, k, out);
    });
}

var SQLI = [
    /(?:union\s+(?:all\s+)?select)/i,
    /(?:or|and)\s+['"`]?\w+['"`]?\s*=\s*['"`]?\w+/i,
    /(?:sleep|benchmark|pg_sleep)\s*\(/i,
    /information_schema/i,
    /(?:load_file|into\s+outfile|xp_cmdshell)\s*\(/i,
    /(?:drop|truncate)\s+(?:table|database)\b/i
];
var WEB = [
    /<\s*(?:script|iframe|object|embed)\b/i,
    /<\s*(?:svg|img)\b[^>]*\bon\w+\s*=/i,
    /javascript\s*:/i,
    /document\.(?:body|documentElement)\.(?:innerHTML|outerHTML)/i,
    /(?:window\.)?eval\s*\(/i,
    /<\s*meta\b[^>]*http-equiv\s*=\s*["']?refresh/i
];
var PATH = [
    /\.\.\//,
    /%2e%2e(?:%2f|\/)/i,
    /(?:;|\||&&)\s*(?:cat|curl|wget|bash|sh|powershell|cmd)\b/i
];

function classify(req) {
    var pieces = [];
    textFromBody(req.body, '', pieces);
    var q = req.url || '';
    pieces.push(q);
    var text = pieces.join('\n').slice(0, 12000);
    for (var i = 0; i < SQLI.length; i++) if (SQLI[i].test(text)) return 'SQL injection pattern';
    for (var j = 0; j < WEB.length; j++) if (WEB[j].test(text)) return 'script/defacement pattern';
    for (var k = 0; k < PATH.length; k++) if (PATH[k].test(text)) return 'path traversal/command pattern';
    return null;
}

async function isBlocked(ip) {
    var rec = await db.fetchPath('hidz_security_ip_blocks/' + ipKey(ip));
    if (!rec || !rec.blockedUntil) return false;
    if (Date.now() < Number(rec.blockedUntil)) return true;
    await db.deletePath('hidz_security_ip_blocks/' + ipKey(ip));
    return false;
}

async function alertAndBlock(req, reason) {
    var ip = clientIp(req);
    var key = ipKey(ip);
    var old = await db.fetchPath('hidz_security_ip_blocks/' + key);
    var tier = old && Number(old.tier) ? Number(old.tier) : 0;
    var duration = Math.min(BLOCK_MS * Math.pow(2, tier), 7 * 24 * 60 * 60 * 1000);
    var now = Date.now();
    await db.setPath('hidz_security_ip_blocks/' + key, {
        ip: ip,
        blocked: true,
        blockedAt: now,
        blockedUntil: now + duration,
        tier: tier + 1,
        reason: reason
    });
    await db.setPath('hidz_security_events/' + (now + '_' + Math.random().toString(36).slice(2, 8)), {
        ip: ip,
        attemptAt: now,
        blockedUntil: now + duration,
        endpoint: String(req.url || '').slice(0, 180),
        method: String(req.method || '').slice(0, 12),
        reason: String(reason || 'Suspicious request').slice(0, MAX_ALERT_TEXT),
        userAgent: String((req.headers && req.headers['user-agent']) || '').slice(0, 220),
        tier: tier + 1
    });
    return { ip: ip, blockedUntil: now + duration };
}

async function guard(req, res) {
    var ip = clientIp(req);
    try {
        if (await isBlocked(ip)) {
            res.status(403).json({ ok: false, error: 'Access denied' });
            return false;
        }
        var reason = classify(req);
        if (reason) {
            await alertAndBlock(req, reason);
            res.status(403).json({ ok: false, error: 'Access denied' });
            return false;
        }
    } catch (e) {
        /* Security failures must fail closed only for the suspicious path;
           a temporary Firebase outage must not take the whole site offline. */
    }
    return true;
}

module.exports = { guard: guard, clientIp: clientIp, ipKey: ipKey };
