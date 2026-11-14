import fs from 'fs';
import path from 'path';
import { renderIndex } from '../lib/page-inject';

/* Halaman statis yang punya file sendiri. Slug lain dibuka sebagai halaman utama (slug project). */
const STATIC_PAGES = new Map([['paket', 'paket.html'], ['privasi', 'privasi.html'], ['ketentuan', 'ketentuan.html']]);
const viewCache = new Map();

function readView(file) {
  if (!viewCache.has(file)) viewCache.set(file, fs.readFileSync(path.join(process.cwd(), 'server-views', file), 'utf8'));
  return viewCache.get(file);
}

export async function getServerSideProps({ params, res }) {
  const staticFile = STATIC_PAGES.get(params?.slug);
  const html = staticFile ? readView(staticFile) : renderIndex(readView('index.html'));
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.write(html);
  res.end();
  return { props: {} };
}
export default function SlugPage() { return null; }
