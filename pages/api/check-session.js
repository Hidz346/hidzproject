import fs from 'fs';
import path from 'path';
import m from '../../server-views/api/check-session.js';

function getVault(role) {
  const v = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'server-views/vault.json'), 'utf8'));
  const isVip = role === 'vip' || role === 'admin';
  return { ...v, projects: (v.projects || []).filter(p => !p.vipOnly || isVip) };
}

export default async function handler(req, res) {
  const origJson = res.json.bind(res);
  res.json = (body) => {
    if (body && body.valid === true) {
      body.vault = getVault(body.role || (req.body && req.body.role));
    }
    return origJson(body);
  };
  const fn = typeof m === 'function' ? m : (m && (m.default || m.handler));
  return await fn(req, res);
}
