'use strict';
/* Nilai yang disisipkan server ke index.html sebelum dikirim ke browser: site key Turnstile, client id Google
   dan GitHub (semuanya publik), serta isi halaman utama untuk tamu. File ini hanya bantu (bukan endpoint),
   jadi tidak menambah jumlah Serverless Function. */
const { injectSiteKey } = require('./turnstile');
const { injectClientId } = require('./google-auth');
const githubAuth = require('./github-auth');
const { injectGuestVault } = require('./guest-vault');

function renderIndex(html) {
    return injectGuestVault(githubAuth.injectClientId(injectClientId(injectSiteKey(html))));
}

module.exports = { renderIndex };
