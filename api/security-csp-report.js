var db=require('./_lib/db');
module.exports=async function(req,res){
 if(req.method!=='POST'){res.status(204).end();return;}
 try{var body=req.body||{};var h=req.headers||{};var ip=String(h['cf-connecting-ip']||h['x-forwarded-for']||h['x-real-ip']||'').split(',')[0].trim()||'unknown';var now=Date.now();await db.setPath('hidz_security_events/'+(now+'_'+Math.random().toString(36).slice(2,8)),{ip:ip,attemptAt:now,endpoint:'CSP',method:'REPORT',reason:'CSP violation report',userAgent:String(h['user-agent']||'').slice(0,220),report:body});}catch(e){} res.status(204).end();
};
