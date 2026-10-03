# Setup Notifikasi (HidzProject — sisi penerima)

Kartu pesan dalam halaman dan notifikasi Chrome untuk akun yang direset
passwordnya, ditambah durasinya, saat maintenance dinyalakan, atau saat ada
project baru.
Pengirimnya ada di project HidzAdmin (lihat `PUSH_SETUP.md` di sana).

## Yang perlu diisi

**Environment Variable** project HidzProject di Vercel:

    VAPID_PUBLIC_KEY = (sama persis dengan VAPID_PUBLIC_KEY di HidzAdmin)

Lalu salin `databaserules.json` ke Firebase Realtime Database → Rules → Publish.
(Rules ini wajib di-publish ulang setelah pembaruan penghitung tampil — tanpa
itu hitungannya tidak bisa ditulis, dan pesan hanya muncul sekali lalu dihapus.)

## Cara kerjanya

- Pesan dalam halaman: antreannya di `hidz_notifications/{id akun}`. Hanya
  ditampilkan saat akun login **dan** tab terlihat. Tiap pesan muncul paling
  banyak **3 kali** (sekali setiap halaman dibuka kembali), lalu dihapus;
  hitungannya disimpan di field `shown` pada pesan itu. Kalau tab sedang
  tidak dibuka, pesan menunggu.
- Notifikasi Chrome: setelah login, user diajak mengaktifkan notifikasi
  (muncul beberapa detik setelah masuk; "Nanti" menundanya 3 hari). Langganan
  device disimpan lewat `/api/push` di `hidz_push_subs/{id akun}/{id device}`
  dan hanya bisa dibaca server.
- Logout manual melepas langganan device itu dari akunnya.
- Kalau tab HidzProject sedang terbuka dan terlihat, notifikasi Chrome sengaja
  tidak ditampilkan supaya tidak dobel dengan kartu di dalam halaman.

## Batas Serverless Function

`/api/push` membuat jumlah function di project ini pas **12** (batas paket Hobby).
Kalau nanti butuh endpoint baru, `api/migrate-passwords.js` adalah kandidat
yang bisa dihapus setelah semua akun selesai dimigrasi.
