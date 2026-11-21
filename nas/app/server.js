// 车间生产看板 · NAS 服务端（只用 Node.js 自带模块，不需要 npm install）
// 数据存在 DATA_DIR/db.json，每天第一次保存前自动备份到 DATA_DIR/backup/
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 8686;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backup');
const INDEX = path.join(__dirname, 'index.html');
const KEEP_BACKUPS = 60;
// 打票软件模块每次请求重新加载：以后只改 hx-sync.js 不用重启容器
function hxMod(){ const f = require.resolve('./hx-sync'); delete require.cache[f]; return require(f); }
let hxBusy = false;
const guard = require('./auth')(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));

fs.mkdirSync(BACKUP_DIR, { recursive: true });

// db = { rev: 数字，每次改动 +1, docs: { "orders/abc": {...}, ... } }
let db = { rev: 1, docs: {} };
if (fs.existsSync(DB_FILE)) {
  try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch (e) { console.error('db.json 读取失败，请从 backup 文件夹恢复：', e.message); process.exit(1); }
}
if (!db.docs) db.docs = {};
if (!db.rev) db.rev = 1;

const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: process.env.TZ || 'Asia/Shanghai' });

function backupOnce() {
  if (!fs.existsSync(DB_FILE)) return;
  const f = path.join(BACKUP_DIR, `db-${today()}.json`);
  if (fs.existsSync(f)) return;
  fs.copyFileSync(DB_FILE, f);
  const old = fs.readdirSync(BACKUP_DIR).filter(n => /^db-\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort();
  old.slice(0, Math.max(0, old.length - KEEP_BACKUPS)).forEach(n => fs.unlinkSync(path.join(BACKUP_DIR, n)));
}

let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      backupOnce();
      const tmp = DB_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(db));
      fs.renameSync(tmp, DB_FILE);
    } catch (e) { console.error('保存失败：', e.message); }
  }, 300);
}

// 等待数据变化的长轮询请求
let waiters = [];
function changed() {
  db.rev++;
  persist();
  const w = waiters; waiters = [];
  w.forEach(fn => fn());
}

const SEG = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
function validDocPath(p) {
  const s = p.split('/');
  return s.length >= 2 && s.length % 2 === 0 && s.length <= 16 && s.every(x => SEG.test(x) && x !== '.' && x !== '..');
}
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
function merge(a, b) {
  const out = { ...a };
  for (const k of Object.keys(b)) out[k] = isObj(b[k]) && isObj(a[k]) ? merge(a[k], b[k]) : b[k];
  return out;
}

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 1024 * 1024) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (await guard(req, res, p)) return;
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return fs.createReadStream(INDEX).pipe(res);
    }

    // 读取全部数据；带 rev 时，如果没变化就等最多 25 秒再回答（长轮询）
    if (req.method === 'GET' && p === '/api/state') {
      const since = Number(url.searchParams.get('rev'));
      if (since !== db.rev) return send(res, 200, { rev: db.rev, docs: db.docs });
      let done = false;
      const reply = () => { if (done) return; done = true; clearTimeout(t); send(res, 200, since === db.rev ? { rev: db.rev, same: true } : { rev: db.rev, docs: db.docs }); };
      const t = setTimeout(() => { waiters = waiters.filter(f => f !== reply); reply(); }, 25000);
      req.on('close', () => { done = true; clearTimeout(t); waiters = waiters.filter(f => f !== reply); });
      waiters.push(reply);
      return;
    }

    if (p.startsWith('/api/doc/')) {
      const dp = decodeURIComponent(p.slice('/api/doc/'.length));
      if (!validDocPath(dp)) return send(res, 400, { code: 'invalid_argument', message: '路径不对：' + dp });
      if (req.method === 'PUT') {
        const body = await readBody(req);
        if (!isObj(body)) return send(res, 400, { code: 'invalid_argument', message: '内容必须是对象' });
        db.docs[dp] = body; changed(); return send(res, 200, { rev: db.rev });
      }
      if (req.method === 'PATCH') {
        const body = await readBody(req);
        if (!isObj(body)) return send(res, 400, { code: 'invalid_argument', message: '内容必须是对象' });
        if (!db.docs[dp]) return send(res, 400, { code: 'invalid_argument', message: '要修改的记录不存在：' + dp });
        db.docs[dp] = merge(db.docs[dp], body); changed(); return send(res, 200, { rev: db.rev });
      }
      if (req.method === 'DELETE') {
        if (db.docs[dp]) { delete db.docs[dp]; changed(); }
        return send(res, 200, { rev: db.rev });
      }
    }

    if (req.method === 'GET' && p === '/api/health') return send(res, 200, { ok: true, rev: db.rev, docs: Object.keys(db.docs).length });

    // 宏翔打票软件：裁剪单同步（只读对方数据库）
    if (p.startsWith('/api/hx/')) {
      const hx = hxMod(), name = p.slice(8), fn = hx.api && hx.api[name];
      if (!fn) return send(res, 404, { ok:false, message:'没有这个接口' });
      if (hxBusy) return send(res, 200, { ok:false, message:'打票软件正在读取，请稍等' });
      hxBusy = true;
      try { return send(res, 200, await fn({ dataDir:DATA_DIR, q:url.searchParams, method:req.method, db, changed })); }
      catch (e) { return send(res, 200, { ok:false, message:String(e && e.message || e) }); }
      finally { hxBusy = false; }
    }
    send(res, 404, { code: 'not_found', message: '没有这个地址' });
  } catch (e) {
    send(res, 400, { code: 'invalid_argument', message: e.message });
  }
});

server.listen(PORT, () => console.log(`车间生产看板已启动：http://0.0.0.0:${PORT}  数据文件：${DB_FILE}`));

// 停止容器时先把数据写完
function flushAndExit() {
  clearTimeout(saveTimer);
  try { const tmp = DB_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(db)); fs.renameSync(tmp, DB_FILE); } catch (e) { console.error(e); }
  process.exit(0);
}
process.on('SIGTERM', flushAndExit);
process.on('SIGINT', flushAndExit);
