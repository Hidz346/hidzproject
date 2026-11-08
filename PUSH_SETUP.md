# Setup Notifikasi (HidzProject — sisi penerima)

Kartu pesan dalam halaman dan notifikasi Chrome untuk akun yang direset
passwordnya, ditambah durasinya, saat maintenance dinyalakan, atau saat ada
project baru.
Pengirimnya ada di project HidzAdmin (lihat `PUSH_SETUP.md` di sana).

## Yang perlu diisi

**Environment Variable** project HidzProject di Vercel:

    VAPID_PUBLIC_KEY  = (sama persis dengan VAPID_PUBLIC_KEY di HidzAdmin)
    VAPID_PRIVATE_KEY = (sama persis dengan VAPID_PRIVATE_KEY di HidzAdmin; baru dipakai untuk
                         notifikasi balasan/tag Chat Global, lihat bagian di bawah)
    VAPID_SUBJECT     = (opsional, bawaan https://hidzproject.my.id)

Lalu salin `databaserules.json` ke Firebase Realtime Database → Rules → Publish.
(Rules ini wajib di-publish ulang setelah pembaruan penghitung tampil — tanpa
itu hitungannya tidak bisa ditulis, dan pesan hanya muncul sekali lalu dihapus.)

## Cara kerjanya

- Pesan dalam halaman: antreannya di `hidz_notifications/{id akun}`. Hanya
  ditampilkan saat akun login **dan** tab terlihat. Tiap pesan muncul paling
  banyak **3 kali** (sekali setiap halaman dibuka kembali); hitungannya
  disimpan di field `shown` pada pesan itu. Kalau tab sedang tidak dibuka
  (atau akunnya belum pernah login), pesan menunggu di antrean akunnya.
  Pesan yang sudah dibaca tetap ada di **Riwayat Notifikasi** — tab
  Notifikasi di halaman Pengumuman — sampai dihapus atau masa berlakunya
  (`expiresAt`) habis.
- Akun yang dibuat dari **Panel VIP** (`/api/vip/create`) langsung mendapat salinan notifikasi
  project baru dan voucher yang masih berlaku, sama seperti akun yang dibuat dari HidzAdmin
  (maintenance tidak disalin; voucher yang sudah dihapus, berakhir, atau kuotanya habis dilewati).
  Logikanya ada di `api/_lib/notif-seed.js` — file bantu, bukan Serverless Function.
- Notifikasi Chrome: setelah login, user diajak mengaktifkan notifikasi
  (muncul beberapa detik setelah masuk; "Nanti" menundanya 3 hari). Langganan
  device disimpan lewat `/api/push` di `hidz_push_subs/{id akun}/{id device}`
  dan hanya bisa dibaca server.
- Logout manual melepas langganan device itu dari akunnya.
- Kalau tab HidzProject sedang terbuka dan terlihat, notifikasi Chrome sengaja
  tidak ditampilkan supaya tidak dobel dengan kartu di dalam halaman.

## Balasan dan tag (@) di Chat Global

Akun yang pesannya dibalas, atau yang di-tag (@nama), mendapat:

- Di dalam halaman: gelembung bertanda "Menyebut kamu" / "Membalas kamu", titik di tombol Chat
  berubah warna, lencana "@" di kartu Chat Global, nada pendek + kabar singkat. Pesan lain
  di Chat Global tetap hanya menambah titik merah biasa tanpa bunyi.
- Notifikasi Chrome (walau tab tidak dibuka), hanya untuk balasan/tag. Mengetuknya membuka
  Chat Global (`/?gc=1`); kalau HidzProject sudah terbuka di tab lain, tab itu yang dipakai.

Menu tag diambil dari `/api/chat/members` (rewrite ke `/api/check-session?vipAction=chat-members`,
jadi tidak menambah Serverless Function). Isinya akun VIP aktif + ADMIN, dibaca langsung dari
database setiap diminta, jadi akun yang baru dibuat langsung ada di menu tanpa login ulang.
Hanya VIP/ADMIN yang boleh memintanya. Server hanya mempercayai id akun yang dikirim client:
nama diambil dari database, harus akun aktif, bukan diri sendiri, dan `@nama` memang ada di teks.

Pengiriman notifikasi Chrome ada di `api/_lib/chat-push.js` (file bantu, bukan function) dan
memakai paket `web-push` dari `package.json` di root repo. Kalau paket atau `VAPID_PRIVATE_KEY`
belum ada, pengiriman push dilewati begitu saja (ada satu baris peringatan di log Vercel):
pesan tetap terkirim dan tanda di dalam halaman tetap jalan. Pesan dari HidzAdmin memakai
jalur yang sama lewat `push.notifyChat` di sisi HidzAdmin.

Rules Firebase tidak perlu diubah: field `reply` dan `mentions` lolos validasi yang ada.

## Batas Serverless Function

`/api/push` membuat jumlah function di project ini pas **12** (batas paket Hobby).
Kalau nanti butuh endpoint baru, `api/migrate-passwords.js` adalah kandidat
yang bisa dihapus setelah semua akun selesai dimigrasi.
