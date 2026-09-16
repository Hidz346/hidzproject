# HIDZ Security Layer

Update ini menambahkan lapisan keamanan server-side tanpa mengubah alur login utama.

## Yang ditambahkan
- Deteksi pola SQL injection, script/defacement injection, path traversal dan command-injection pada request API.
- IP yang terdeteksi otomatis diblokir di application layer selama 24 jam; pelanggaran berulang memperpanjang sampai maksimal 7 hari.
- Event keamanan disimpan di Firebase pada `hidz_security_events` dan IP block pada `hidz_security_ip_blocks`.
- HidzAdmin memiliki monitor keamanan dan tombol BUKA BLOKIR.
- Security guard dipasang pada seluruh endpoint `/api` di HidzProject.
- Password tidak ikut dipindai oleh regex untuk mengurangi false-positive.
- Header keamanan dasar ditambahkan di `vercel.json`.

## Environment variable
Tetap wajib menggunakan:
- `FIREBASE_DB_SECRET`
- `ADMIN_USERNAME`
- `ADMIN_PASSWORD`

Jangan pernah menaruh secret tersebut di HTML/JavaScript browser.

## Penting tentang DDoS
Script aplikasi tidak bisa menjamin penghentian DDoS volumetrik: trafik dapat membanjiri jaringan/CDN sebelum request mencapai Vercel Function. Untuk proteksi edge, gunakan WAF/CDN seperti Cloudflare atau firewall provider hosting. Setelah domain diproxy melalui Cloudflare, aktifkan DDoS Managed Rules dan rate limiting untuk `/api/*`, terutama `/api/login` dan `/api/admin-login`.

## SQL injection
Project ini menggunakan Firebase Realtime Database, bukan query SQL langsung. Jadi tidak ada query SQL yang bisa diparameterisasi di endpoint yang sekarang. Guard tetap mendeteksi pola SQL injection sebagai sinyal serangan, tetapi pencegahan utamanya adalah jangan pernah menambahkan query SQL berbasis string jika database SQL ditambahkan nanti. Gunakan prepared/parameterized statements.

## Deface
Vercel deployment bersifat immutable; script ini tidak mencoba "memperbaiki" file deployment dari runtime. Header keamanan dan deteksi payload membantu mencegah XSS/injection, sedangkan integritas deployment harus dijaga melalui Git/Vercel dan akses akun.
