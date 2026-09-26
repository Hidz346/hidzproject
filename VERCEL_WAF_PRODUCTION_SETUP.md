# HIDZPROJECT — Vercel Firewall Production Setup

HIDZPROJECT uses two security layers:

1. Vercel Firewall at the edge for DDoS and abusive request mitigation.
2. Server-side protection in `api/_lib/security.js`, plus credential-based rate limits in the login and VIP APIs.

The application layer is defense in depth. It must not be treated as the DDoS boundary.

## 1. Automatic DDoS protection

Vercel provides platform-level DDoS mitigation automatically for deployed projects. No application code is required for this layer.

## 2. Hobby-plan firewall layout

The current Vercel firewall supports custom rules on Hobby. Current Hobby limits are three custom firewall rules per project and one rate-limiting rule per project. Bot Protection is available as a managed ruleset. The OWASP Core Ruleset is not available on Hobby.

Because HIDZPROJECT is on the Hobby plan, keep the configuration within those limits. Do not create multiple rate-limit rules.

## 3. Rule 1 — authentication and privileged API rate limit

Create one custom rule:

- Name: `HIDZ Auth Abuse`
- Match: `POST` requests to `/api/login` OR `/api/admin-login` OR `/api/vip/`
- Rate limit: `20 requests / 60 seconds / IP`
- Exceeded action: `429`
- Keep the rule active and publish it.

Do not rate-limit every `/api/*` route. `/api/check-session` and `/api/check-file-version` are normal browser traffic and can be called repeatedly during a normal session.

The application also has per-IP login lockout and per-VIP-ID credential lockout, so rotating browser sessions does not remove every protection layer.

## 4. Rule 2 — common scanner paths

Create one blocking rule for obvious probes that are not part of HIDZPROJECT:

- `/.env`
- `/.git/`
- `/wp-admin`
- `/wp-login.php`
- `/xmlrpc.php`
- `/phpmyadmin`
- `/server-status`
- `/cgi-bin/`

Action: `Deny`.

Keep this rule path-based. Do not globally block words such as `select`, `union`, or `script`; the application guard already handles suspicious payload patterns on protected API routes and a global string rule can create false positives.

## 5. Rule 3 — bot protection

Enable Vercel's **Bot Protection** managed ruleset for the project.

Use challenge behavior for suspicious automated traffic where the project exposes that option. Do not blanket-block every non-browser client because monitoring and legitimate API tooling can use non-browser clients.

## 6. Managed OWASP rules

Do not expect the OWASP Core Ruleset on Hobby; it is not available on this plan.

The server-side guard remains enabled and detects common SQL injection, XSS/script, path traversal, and command-style payloads. Detected abusive IPs are temporarily blocked in the application layer.

## 7. Attack Challenge Mode

Use **Attack Challenge Mode** only during an active attack or severe traffic spike. It is an emergency control, not a permanent replacement for the normal rules.

## 8. Emergency IP blocking

Use **Firewall → IP Blocking** for confirmed abusive addresses. Keep the block targeted and review false positives.

## 9. Production verification

After publishing the firewall changes:

1. Open the live site normally.
2. Test one valid user login.
3. Test one invalid login.
4. Confirm session checking still works.
5. Open VIP/admin features that you actually use.
6. Confirm logout still works.
7. Watch Vercel Firewall traffic for false positives.
8. Check production logs for 4xx/5xx spikes.

Do not intentionally generate a large production traffic flood to test DDoS mitigation.

## 10. CSP reporting

CSP reports stay separate from attack events. The existing `/api/security-csp-report` endpoint is telemetry only, so CSP noise does not automatically become an attack event in HidzAdmin.
