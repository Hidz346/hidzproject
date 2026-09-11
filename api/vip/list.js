/* Panel VIP butuh lihat daftar akun role=user buat dikelola. Dulu ini
   didapat dengan download SELURUH hidz_access_db langsung ke browser
   (termasuk password VIP lain & admin) baru difilter di JS. Sekarang
   filternya dilakukan di server — VIP yang login cuma dikasih apa yang
   memang perlu dia lihat. */

var db = require('../_lib/db');

module.exports = async function (req, res) {
    if (req.method !== 'POST') {
        res.status(200).json({ ok: false });
        return;
    }

    var body        = req.body || {};
    var vipId       = typeof body.vipId === 'string' ? body.vipId : '';
    var vipUsername = typeof body.vipUsername === 'string' ? body.vipUsername : '';
    var vipPassword = typeof body.vipPassword === 'string' ? body.vipPassword : '';

    if (!vipId || !vipUsername || !vipPassword) {
        res.status(200).json({ ok: false });
        return;
    }

    var list = await db.fetchAllAccounts();
    if (list === null) {
        res.status(200).json({ ok: false, error: true });
        return;
    }

    var me = db.findValidVip(list, vipId, vipUsername, vipPassword);
    if (!me) {
        res.status(200).json({ ok: false });
        return;
    }

    var users = list.filter(function (u) { return u.role === 'user'; });
    res.status(200).json({ ok: true, users: users });
};
