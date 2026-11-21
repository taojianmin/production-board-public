// 登录验证：DATA_DIR/auth.json 里有密码时才启用；没有这个文件就和以前一样不用登录
// 工厂局域网里直接访问（不经过群晖反向代理）可以免登录，见 auth.json 的 lanFree
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

module.exports = function makeAuth(DATA_DIR) {
  const AUTH_FILE = path.join(DATA_DIR, 'auth.json');
  const SESS_FILE = path.join(DATA_DIR, 'sessions.json');
  const DAYS = 180;
  const COOKIE = 'pb_sid';

  let conf = null, confMtime = -1, lastHash;
  function config() {
    let m = -1;
    try { m = fs.statSync(AUTH_FILE).mtimeMs; } catch (e) { conf = null; confMtime = -1; return null; }
    if (m !== confMtime) {
      try { conf = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')); } catch (e) { console.error('auth.json 读不了：', e.message); conf = { broken: true }; }
      confMtime = m;
      // 换了密码：以前登录的设备都要重新登录
      if (lastHash !== undefined && conf.hash !== lastHash) { sessions = {}; saveSessions(); }
      lastHash = conf.hash;
    }
    return conf;
  }

  let sessions = {};
  try { sessions = JSON.parse(fs.readFileSync(SESS_FILE, 'utf8')); } catch (e) {}
  function saveSessions() {
    const now = Date.now();
    for (const [k, v] of Object.entries(sessions)) if (!v || v.exp < now) delete sessions[k];
    try { fs.writeFileSync(SESS_FILE + '.tmp', JSON.stringify(sessions)); fs.renameSync(SESS_FILE + '.tmp', SESS_FILE); } catch (e) { console.error('保存登录状态失败：', e.message); }
  }

  const cookies = req => Object.fromEntries((req.headers.cookie || '').split(';').map(x => x.trim().split('=')).filter(x => x[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
  const viaProxy = req => !!(req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.headers['x-forwarded-proto']);
  const clientIp = req => String(req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.socket.remoteAddress || '').split(',')[0].trim().replace(/^::ffff:/, '');
  // 只认 192.168.x.x 和 10.x.x.x。127.0.0.1 是群晖反向代理自己（外网从这里进来），172.x 是 Docker 内部地址，都不算
  const isLan = ip => /^(192\.168\.|10\.)/.test(ip);

  function hashPw(pw, salt) { return crypto.scryptSync(String(pw), Buffer.from(salt, 'hex'), 32).toString('hex'); }
  function checkPw(pw) {
    const c = config(); if (!c || !c.hash || !c.salt) return false;
    const a = Buffer.from(hashPw(pw, c.salt), 'hex'), b = Buffer.from(c.hash, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  // 输错太多次先锁一会儿
  const fails = {};
  function tooMany(ip) {
    const f = fails[ip]; if (!f) return false;
    if (Date.now() - f.t > 15 * 60e3) { delete fails[ip]; return false; }
    return f.n >= 8;
  }
  function failed(ip) { const f = fails[ip] && Date.now() - fails[ip].t < 15 * 60e3 ? fails[ip] : (fails[ip] = { n: 0, t: Date.now() }); f.n++; }

  function loggedIn(req) {
    const t = cookies(req)[COOKIE];
    const s = t && sessions[t];
    if (!s || s.exp < Date.now()) return false;
    // 用着就续期
    if (s.exp - Date.now() < (DAYS - 7) * 86400e3) { s.exp = Date.now() + DAYS * 86400e3; saveSessions(); }
    return true;
  }

  const page = (msg, next) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>登录 · 车间生产看板</title><style>
:root{--bg:#eef1f4;--panel:#fff;--line:#d8dee5;--fg:#18222e;--mute:#5d6b7a;--accent:#24507f;--err:#b3261e;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#12171d;--panel:#1b222a;--line:#2c3640;--fg:#e4e9ee;--mute:#93a1af;--accent:#7fb0e6;--err:#ff8a80;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:16px/1.5 "Noto Sans SC","PingFang SC","Microsoft YaHei",system-ui,sans-serif;padding:16px}
form{width:100%;max-width:340px;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:26px 22px}
h1{font-size:21px;margin:0 0 4px}p{margin:0 0 18px;color:var(--mute);font-size:14px}
input{width:100%;font:inherit;font-size:17px;padding:11px 12px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg)}
input:focus{outline:2px solid var(--accent);outline-offset:1px}
button{width:100%;margin-top:14px;font:inherit;font-weight:700;padding:11px;border:0;border-radius:8px;background:var(--accent);color:var(--panel)}
.e{color:var(--err);font-size:14px;margin:10px 0 0}
</style></head><body><form method="post" action="login">
<h1>车间生产看板</h1><p>请输入看板密码</p>
<input type="hidden" name="next" value="${String(next || '').replace(/[^\w\-./?=&%]/g, '')}">
<input type="password" name="password" autocomplete="current-password" autofocus required placeholder="密码">
${msg ? `<div class="e">${msg}</div>` : ''}<button type="submit">登录</button></form></body></html>`;

  function readForm(req) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on('data', c => { size += c.length; if (size > 8192) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
      req.on('end', () => resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))));
      req.on('error', reject);
    });
  }
  const html = (res, code, body, extra) => { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...extra }); res.end(body); };
  const safeNext = n => (typeof n === 'string' && n.startsWith('/') && !n.startsWith('//')) ? n : '/';

  // 返回 true 表示这个请求已经处理完（登录页、跳转、401）
  return async function guard(req, res, p) {
    const c = config();
    if (!c) return false;                                     // 没设密码：不用登录
    if (c.lanFree !== false && !viaProxy(req) && isLan(clientIp(req))) return false;   // 厂里局域网直连
    const ip = clientIp(req);
    const secure = req.headers['x-forwarded-proto'] === 'https';

    if (p === '/login' && req.method === 'POST') {
      if (tooMany(ip)) { html(res, 429, page('输错次数太多，请 15 分钟后再试', '')); return true; }
      const f = await readForm(req);
      const next = safeNext(f.get('next'));
      if (!c.broken && checkPw(f.get('password') || '')) {
        delete fails[ip];
        const t = crypto.randomBytes(24).toString('hex');
        sessions[t] = { exp: Date.now() + DAYS * 86400e3, at: Date.now() };
        saveSessions();
        res.writeHead(303, { Location: next, 'Cache-Control': 'no-store',
          'Set-Cookie': `${COOKIE}=${t}; Path=/; Max-Age=${DAYS * 86400}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}` });
        res.end(); return true;
      }
      failed(ip);
      await new Promise(r => setTimeout(r, 800));
      html(res, 401, page('密码不对', next)); return true;
    }
    if (p === '/login') { html(res, 200, page('', safeNext(new URL(req.url, 'http://x').searchParams.get('next')))); return true; }
    if (p === '/logout') {
      const t = cookies(req)[COOKIE]; if (t && sessions[t]) { delete sessions[t]; saveSessions(); }
      res.writeHead(303, { Location: 'login', 'Set-Cookie': `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}` }); res.end(); return true;
    }
    if (loggedIn(req)) return false;
    if (p.startsWith('/api/')) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ code: 'unauthenticated', message: '需要登录' })); return true;
    }
    res.writeHead(302, { Location: 'login?next=' + encodeURIComponent(p), 'Cache-Control': 'no-store' }); res.end(); return true;
  };
};
