/* ============================================================
 * HidzProject — Service Worker
 * Fokusnya cuma dua: (1) biar hidzproject.html bisa di-"Add to
 * Home Screen" kayak app asli, (2) tetap bisa kebuka pas offline
 * (nampilin shell halaman terakhir yang sempat dimuat).
 *
 * SENGAJA nggak nge-cache Firebase/CDN/API sama sekali — semua
 * request selain navigasi halaman dibiarkan lewat apa adanya,
 * supaya data real-time (status login, maintenance, promo,
 * pengumuman, Konseling, dll) selalu ambil yang paling baru,
 * bukan versi basi dari cache.
 * ============================================================ */

var CACHE_NAME = 'hidzproject-shell-v1';
var SHELL_URL = './';

self.addEventListener('install', function (event) {
    self.skipWaiting();
    event.waitUntil(
        caches.open(CACHE_NAME).then(function (cache) {
            return cache.addAll([SHELL_URL]).catch(function () {
                /* Offline pas pertama kali install service worker — gapapa,
                   nanti ke-cache otomatis begitu ada koneksi & halaman dibuka. */
            });
        })
    );
});

self.addEventListener('activate', function (event) {
    event.waitUntil(
        caches.keys().then(function (keys) {
            return Promise.all(
                keys.filter(function (k) { return k !== CACHE_NAME; })
                    .map(function (k) { return caches.delete(k); })
            );
        }).then(function () { return self.clients.claim(); })
    );
});

self.addEventListener('fetch', function (event) {
    var req = event.request;

    /* Cuma tangani navigasi ke halaman utama. Semua request lain
       (Firebase SDK, Firebase Realtime Database, Font Awesome, Google
       Fonts, gambar, dll) dibiarkan lewat langsung tanpa disentuh. */
    if (req.mode === 'navigate') {
        event.respondWith(
            fetch(req)
                .then(function (res) {
                    var resClone = res.clone();
                    caches.open(CACHE_NAME).then(function (cache) { cache.put(SHELL_URL, resClone); });
                    return res;
                })
                .catch(function () {
                    return caches.match(SHELL_URL);
                })
        );
    }
});

/* ============================================================
 * Notifikasi Chrome (Web Push)
 * Dikirim dari HidzAdmin saat ada RESET PASSWORD, TAMBAH DURASI,
 * MAINTENANCE, atau PROJECT BARU — ke device yang sudah mengaktifkan
 * notifikasi.
 *
 * Kalau tab HidzProject di device ini sedang terbuka & terlihat,
 * notifikasi sistem sengaja TIDAK ditampilkan: kabarnya sudah
 * muncul langsung di dalam halaman (lihat bagian notifikasi di
 * index.html), jadi tidak ada pesan ganda (kecuali di Safari, yang
 * mewajibkan notifikasi tampil di setiap push). Selain itu tampil di
 * bar notifikasi seperti notifikasi Chrome biasa.
 * ============================================================ */

var NOTIF_ICON = 'https://www.gobox.my.id/file/vVUoB.png';

/* Langganan Safari (iPhone, iPad, Mac) selalu beralamat di push.apple.com.
   Kalau gagal dibaca dianggap bukan Safari, perilakunya sama seperti dulu. */
function isApplePush() {
    return self.registration.pushManager.getSubscription().then(function (sub) {
        return !!sub && /(^|\.)push\.apple\.com$/.test(new URL(sub.endpoint).hostname);
    }).catch(function () { return false; });
}

self.addEventListener('push', function (event) {
    var data = {};
    try { data = event.data ? event.data.json() : {}; } catch (e) { data = {}; }

    var title = data.title || 'Hidz Project';
    var options = {
        body:  data.body || '',
        icon:  NOTIF_ICON,
        badge: NOTIF_ICON,
        tag:   data.tag || 'hidz-info',
        data:  { url: './' }
    };

    event.waitUntil(
        Promise.all([
            self.clients.matchAll({ type: 'window', includeUncontrolled: true }),
            isApplePush()
        ]).then(function (r) {
            var pageVisible = r[0].some(function (c) { return c.visibilityState === 'visible'; });
            /* Safari mencabut langganan kalau ada push yang tidak berujung
               notifikasi, jadi di sana selalu ditampilkan. */
            if (pageVisible && !r[1]) return;
            return self.registration.showNotification(title, options);
        })
    );
});

self.addEventListener('notificationclick', function (event) {
    event.notification.close();
    var target = (event.notification.data && event.notification.data.url) || './';

    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
            for (var i = 0; i < list.length; i++) {
                if ('focus' in list[i]) return list[i].focus();
            }
            return self.clients.openWindow(target);
        })
    );
});
