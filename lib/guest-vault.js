'use strict';
/* Isi halaman utama untuk tamu (masuk lewat tombol "Masuk sebagai Tamu" di kartu login).

   Daftar project ditampilkan (nama, deskripsi singkat, kategori, rating) supaya tamu tahu isi
   HIDZPROJECT, tetapi alamat project (`download`), deskripsi lengkap, dan tautan developer TIDAK ikut:
   semuanya baru dikirim setelah login lewat vault yang lama. Project khusus VIP juga tidak ditampilkan,
   sama seperti untuk akun role user.

   Dicetak langsung ke HTML (blok JSON yang tidak dieksekusi), jadi halaman utama langsung terisi tanpa
   menunggu satu panggilan API. File ini hanya bantu (bukan endpoint), jadi tidak menambah jumlah
   Serverless Function. */
const fs = require('fs');
const path = require('path');

const PLACEHOLDER = '<!--HZ_GUEST_VAULT-->';
let cached = null;

function build() {
    const v = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'server-views/vault.json'), 'utf8'));
    return {
        pages: Array.isArray(v.pages) ? v.pages : [],
        profileName: v.profileName || '',
        profileDesc: v.profileDesc || '',
        profileImg: v.profileImg || '',
        projects: (v.projects || []).filter(function (p) { return !p.vipOnly; }).map(function (p) {
            return {
                name: p.name, desc: p.desc, img: p.img, rating: p.rating,
                releasedAt: p.releasedAt, pageId: p.pageId, category: p.category,
                download: '', detailDesc: '', dev: ''
            };
        })
    };
}

function getVault() {
    if (!cached) cached = build();
    return cached;
}

/* `<` dan U+2028/2029 diloloskan supaya isi JSON tidak bisa menutup blok <script> atau memecah baris. */
function injectGuestVault(html) {
    let json;
    try { json = JSON.stringify(getVault()); } catch (e) { return String(html); }
    json = json.replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    return String(html).replace(PLACEHOLDER, '<script type="application/json" id="hzGuestVault">' + json + '</script>');
}

module.exports = { injectGuestVault, getVault };
