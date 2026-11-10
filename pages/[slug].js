import fs from 'fs';
import path from 'path';
import { injectSiteKey } from '../lib/turnstile';

let indexHtml = null, paketHtml = null;
export async function getServerSideProps({ params, res }) {
  const isPaket = params?.slug === 'paket';
  if (isPaket) {
    if (!paketHtml) paketHtml = fs.readFileSync(path.join(process.cwd(), 'server-views/paket.html'), 'utf8');
  } else {
    if (!indexHtml) indexHtml = fs.readFileSync(path.join(process.cwd(), 'server-views/index.html'), 'utf8');
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.write(isPaket ? paketHtml : injectSiteKey(indexHtml));
  res.end();
  return { props: {} };
}
export default function SlugPage() { return null; }
