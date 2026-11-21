// 从宏翔「制衣条码扫描」的 SQL Server 数据库读取裁剪单（只读，只发 SELECT）
// 账号密码放在 DATA_DIR/宏翔数据库.json，由使用者自己填写；这个程序不会把密码返回给网页
const fs = require('fs');
const path = require('path');

let tedious = null;
try { tedious = require('tedious'); } catch (e) { /* 没装驱动时，接口会提示 */ }

const TEMPLATE = {
  说明: '把下面几项填好后保存，再到看板「设置」里点「测试连接」。建议用宏翔给的只读账号。',
  server: 'sql.example.invalid',
  port: 1433,
  database: 'reporting_database',
  user: '在这里填账号',
  password: '在这里填密码',
  encrypt: true,
  table: 'report_sc_ordmas_1',
  since: '2026-01-01',
};

function cfgFile(dataDir) { return path.join(dataDir, '宏翔数据库.json'); }
function loadCfg(dataDir, createTemplate = true) {
  const f = cfgFile(dataDir);
  if (!fs.existsSync(f)) {
    if (!createTemplate) return { ok:false, why:'尚未設定宏翔資料庫連線' };
    fs.writeFileSync(f, JSON.stringify(TEMPLATE, null, 2));
    return { ok:false, why:'还没填账号：配置文件已生成，请在 NAS 上打开 data/宏翔数据库.json 填写' };
  }
  let c;
  try { c = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')); } catch (e) { return { ok:false, why:'宏翔数据库.json 格式不对：' + e.message }; }
  if (!c.user || !c.password || /在这里填/.test(c.user + c.password)) return { ok:false, why:'宏翔数据库.json 里还没填账号或密码' };
  if (!/^[A-Za-z0-9_]+$/.test(c.table || '')) return { ok:false, why:'table 只能是英文字母、数字和下划线' };
  return { ok:true, cfg:c };
}

function connect(c){
  return new Promise((resolve, reject) => {
    if (!tedious) return reject(new Error('看板服务里没有装 SQL Server 驱动（node_modules/tedious）'));
    const conn = new tedious.Connection({
      server: c.server,
      authentication: { type:'default', options:{ userName:c.user, password:c.password } },
      options: {
        port: Number(c.port) || 1433, database: c.database,
        encrypt: c.encrypt !== false, trustServerCertificate: true,
        connectTimeout: 20000, requestTimeout: 60000, rowCollectionOnRequestCompletion: true,
        ...(c.tdsVersion ? { tdsVersion: c.tdsVersion } : {}),
      },
    });
    conn.on('connect', err => err ? reject(err) : resolve(conn));
    conn.connect();
  });
}
function query(conn, sql, params){
  return new Promise((resolve, reject) => {
    if (!/^\s*select\s/i.test(sql)) return reject(new Error('只允许查询'));
    const req = new tedious.Request(sql, (err, n, rows) => {
      if (err) return reject(err);
      resolve((rows || []).map(cols => { const o = {}; cols.forEach(col => { o[col.metadata.colName] = col.value; }); return o; }));
    });
    (params || []).forEach(p => req.addParameter(p.name, p.type, p.value));
    conn.execSql(req);
  });
}
const close = conn => { try { conn.close(); } catch (e) {} };
const explain = e => {
  const m = String(e && e.message || e);
  if (/Login failed/i.test(m)) return '登录失败：账号或密码不对，或者这个账号不能访问这个数据库';
  if (/ETIMEOUT|timeout|ESOCKET|ENOTFOUND|ECONNREFUSED/i.test(m)) return '连不上数据库服务器：请确认 NAS 能上外网、服务器地址和端口没写错（' + m + '）';
  if (/Invalid object name/i.test(m)) return '找不到裁剪单表：' + m;
  return m;
};
const fmtDate = d => d instanceof Date ? d.toISOString().slice(0, 10) : (d ? String(d).slice(0, 10) : '');
const str = v => v == null ? '' : String(v).trim();

/* 测试连接：看看能不能登录、裁剪单表有哪些字段、最近几行长什么样 */
async function test(dataDir){
  const L = loadCfg(dataDir); if (!L.ok) return { ok:false, message:L.why };
  const c = L.cfg; let conn;
  try {
    conn = await connect(c);
    const tables = await query(conn, "SELECT TABLE_NAME AS name, TABLE_TYPE AS type FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME LIKE '%sc_ord%' OR TABLE_NAME LIKE '%caijian%' ORDER BY TABLE_NAME");
    const sample = await query(conn, `SELECT TOP 5 * FROM [${c.table}] ORDER BY f_sc_date DESC`);
    const count = await query(conn, `SELECT COUNT(*) AS n, COUNT(DISTINCT f_sc_no) AS orders, MIN(f_sc_date) AS first, MAX(f_sc_date) AS last FROM [${c.table}]`);
    return { ok:true, message:'连接成功', table:c.table, since:c.since, tables, count:count[0], columns: sample[0] ? Object.keys(sample[0]) : [], sample: sample.map(r => { const o = {}; for (const k of Object.keys(r)) o[k] = r[k] instanceof Date ? fmtDate(r[k]) : r[k]; return o; }) };
  } catch (e) { return { ok:false, message:explain(e) }; }
  finally { if (conn) close(conn); }
}

const inList = (nos, type) => {
  const list = [...new Set(nos)].slice(0, 300);
  return { sql:list.map((_, i) => '@n' + i).join(', ') || "''", params:list.map((v, i) => ({ name:'n' + i, type:type || tedious.TYPES.VarChar, value:v })) };
};

// 裁剪单原始行保留了裁床号、颜色和尺码的对应关系。订单展示和日报共用这个映射。
function bedBreakdown(cutRows){
  const grouped = new Map();
  for (const r of cutRows) {
    const bed = str(r.bed), c = str(r.color), s = str(r.size), q = Number(r.q) || 0;
    if (!bed || !(q > 0)) continue;
    const key = JSON.stringify([bed, c, s]);
    grouped.set(key, (grouped.get(key) || 0) + q);
  }
  return [...grouped].map(([key, q]) => { const [bed, c, s] = JSON.parse(key); return { bed, c, s, q }; });
}
const completeBedBreakdown = cutRows => cutRows.length && cutRows.every(r => str(r.bed)) ? bedBreakdown(cutRows) : null;

/* 读取某天以后（或指定单号）的裁剪单明细（一行一包），整理成和 Excel 导入一样的格式 */
async function rows(dataDir, since, nos){
  const L = loadCfg(dataDir); if (!L.ok) return { ok:false, message:L.why };
  const c = L.cfg; let conn, list;
  const day = /^\d{4}-\d{2}-\d{2}$/.test(since || '') ? since : (c.since || '2026-01-01');
  try {
    conn = await connect(c);
    const cols = 'f_sc_no, f_sc_date, f_item_no, f_ks_no, f_ks_dsp, f_itm_dsp, CaiChuanHao, cBaoHao, f_col_dsp, f_col_no, f_size, nQty, nOrder';
    if (nos) { const I = inList(nos); list = await query(conn, `SELECT TOP 20000 ${cols} FROM [${c.table}] WHERE f_sc_no IN (${I.sql}) ORDER BY f_sc_date, f_sc_no, nOrder`, I.params); }
    else list = await query(conn, `SELECT TOP 20000 ${cols} FROM [${c.table}] WHERE f_sc_date >= @since ORDER BY f_sc_date, f_sc_no, nOrder`,
      [{ name:'since', type:tedious.TYPES.Date, value:new Date(day + 'T00:00:00Z') }]);
  } catch (e) { return { ok:false, message:explain(e) }; }
  finally { if (conn) close(conn); }
  const out = [];
  for (const r of list) {
    const no = str(r.f_sc_no), q = Number(r.nQty) || 0;
    if (!no || !(q > 0)) continue;
    out.push({ date:fmtDate(r.f_sc_date), no, item:str(r.f_item_no) || str(r.f_ks_no), style:str(r.f_ks_dsp) || str(r.f_itm_dsp) || str(r.f_ks_no) || ('裁剪单 ' + no),
      bed:str(r.CaiChuanHao), bag:str(r.cBaoHao), color:str(r.f_col_dsp) || str(r.f_col_no), size:str(r.f_size), q });
  }
  return { ok:true, since:day, rows:out, truncated:list.length >= 20000 };
}

function status(dataDir){
  const L = loadCfg(dataDir);
  return { configured:L.ok, message:L.ok ? '已填好账号' : L.why, driver:!!tedious, table:L.ok ? L.cfg.table : TEMPLATE.table, since:L.ok ? L.cfg.since : TEMPLATE.since };
}

/* 员工扫票报工记录（计件）：只取需要的列，不读身份证等个人信息 */
async function scans(dataDir, since, until, nos){
  const L = loadCfg(dataDir); if (!L.ok) return { ok:false, message:L.why };
  const ok = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
  if (!nos && !ok(since)) return { ok:false, message:'日期不对' };
  const end = ok(until) ? until : (since || '9999-12-31');
  let conn, list;
  try {
    conn = await connect(L.cfg);
    const cols = 'f_id, f_pty_no, f_pty_date, f_sc_no, f_ks_dsp, f_itm_dsp, f_col_dsp, f_size, f_gx_no, f_gx_dsp, bh, name, f_qty, nFeiPinQty, nCiPinQty, TiaoMa, CaiChuanHao, nPage';
    if (nos) { const I = inList(nos); list = await query(conn, `SELECT TOP 20000 ${cols} FROM [report_sc_ptymas] WHERE f_sc_no IN (${I.sql}) AND f_pty_no <= @b ORDER BY f_id`, [...I.params, { name:'b', type:tedious.TYPES.VarChar, value:'CLD' + end }]); }
    else list = await query(conn, `SELECT TOP 20000 ${cols} FROM [report_sc_ptymas] WHERE f_pty_no >= @a AND f_pty_no <= @b ORDER BY f_id`,
      [{ name:'a', type:tedious.TYPES.VarChar, value:'CLD' + since }, { name:'b', type:tedious.TYPES.VarChar, value:'CLD' + end }]);
  } catch (e) { return { ok:false, message:explain(e) }; }
  finally { if (conn) close(conn); }
  return { ok:true, since, until:end, truncated:list.length >= 20000, rows:list.map(r => ({
    id:r.f_id, day:str(r.f_pty_no).replace(/^CLD/, ''), at:r.f_pty_date instanceof Date ? r.f_pty_date.toISOString().slice(11, 16) : '',
    no:str(r.f_sc_no), style:str(r.f_ks_dsp) || str(r.f_itm_dsp), color:str(r.f_col_dsp), size:str(r.f_size),
    gxNo:str(r.f_gx_no), gx:str(r.f_gx_dsp), bh:str(r.bh), name:str(r.name), q:Number(r.f_qty) || 0,
    bad:(Number(r.nFeiPinQty) || 0) + (Number(r.nCiPinQty) || 0), ticket:str(r.TiaoMa), bag:r.nPage })) };
}


/* ---------- 员工扫票报工 → 看板报工 ----------
   打票软件每扫一包一行（员工 × 裁剪单 × 小工序 × 包）。同步时：
   · 员工按名字对上看板员工（设置里可以改：config.hxWorkerMap）
   · 小工序按关键词归到看板工序（设置里可以改：config.hxProcMap）
   · 同一个员工在同一包上做的几道小工序归到同一道看板工序时，按这一包的件数算一次
   · 裁剪单号对上看板订单的 source.nos；对不上时，如果只有一张同款同色、没有单号的手建订单，就认作这张
   · 扫的裁剪单不在看板上、但款式看板认识（款式库里有，或看板上有同款订单）：自动把这张裁剪单导进来，
     工序路线照款式套；这种新导入的单，以前的扫票也一起补记（它以前不在看板上，不会和手工报的重复）
   · 每天从打票软件填进来的数记在 hxlog/<日期>，再同步时只补差额，所以重复同步不会多算 */
const PROC_RULES = [
  [/包装/, '包装'], [/套结/, '套结'], [/三针五线/, '三针五线包边'], [/人字车/, '人字车'],
  [/双针/, '平双针'], [/平车.*包边/, '平车包边'], [/修边|修头/, '拷边修边'], [/拷边/, '拷边'], [/平车/, '平车'],
];
const baseName = n => String(n || '').replace(/[（(][^）)]*[）)]/g, '').trim();
const dayStr = d => d.toLocaleDateString('sv-SE', { timeZone: process.env.TZ || 'Asia/Shanghai' });
const nextDay = d => dayStr(new Date(new Date(d + 'T12:00:00+08:00').getTime() + 864e5));
const isDay = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '');

function guessProc(gx, procs){
  for (const [re, name] of PROC_RULES) if (re.test(gx)) { const p = procs.find(x => x.name === name); if (p) return p.id; }
  return '';
}
function guessWorker(name, workers){
  if (!name) return '';
  const w = workers.find(x => x.name === name) || workers.find(x => x.name && x.name.length >= 2 && (name.includes(x.name) || x.name.includes(name)));
  return w ? w.id : '';
}
function styleNames(o, styles){
  const s = new Set([o.style, baseName(o.style)].filter(Boolean));
  const st = styles.find(x => x.id === o.styleId) || styles.find(x => x.name === o.style || (x.aliases || []).includes(o.style));
  if (st) { s.add(st.name); (st.aliases || []).forEach(a => { s.add(a); s.add(baseName(a)); }); }
  return s;
}
const hasNos = o => !!(o.source && ((o.source.nos && o.source.nos.length) || o.source.no));
/* 看板认不认识这个款式：先找款式库（名字、别名、去掉括号），再找看板上的同款订单；返回工序路线 */
function knownStyle(name, styles, orders){
  const n = String(name || '').trim(), b = baseName(n);
  const byLib = x => styles.find(s => s.name === x) || styles.find(s => (s.aliases || []).includes(x));
  const st = byLib(n) || byLib(b);
  if (st) return { styleId:st.id, from:'款式库「' + st.name + '」', steps:(st.steps || []).map(s => ({ p:s.p, gx:s.gx || '' })) };
  const o = orders.filter(o => (o.style === n || baseName(o.style) === b) && Array.isArray(o.steps) && o.steps.length).sort((a, c) => (c.createdAt || 0) - (a.createdAt || 0))[0];
  if (o) return { styleId:o.styleId || '', from:'看板上的同款订单', steps:o.steps.map(s => ({ p:s.p, gx:s.gx || '' })) };
  return null;
}

async function scanSync({ dataDir, q, db, changed }){
  const docs = db.docs, cfg = docs['config/main'] || {};
  const procs = cfg.processes || [], workers = cfg.workers || [], styles = cfg.styles || [];
  const today = dayStr(new Date());
  const start = cfg.hxScanSince;
  const dry = q.get('dry') === '1';
  if (!dry && !isDay(start)) return { ok:false, off:true, message:'还没开启扫票同步：请先到「设置 → 打票软件同步」核对员工和工序，再点「开始自动同步」' };
  // 默认同步最近 3 天（补扫的也能跟上），但不早于开启那天
  let since = q.get('since');
  if (!isDay(since)) since = dayStr(new Date(Date.now() - 2 * 864e5));
  if (!dry && since < start) since = start;
  if (since > today) return { ok:true, message:'还没到开始同步的日子', touched:0 };
  const R = await scans(dataDir, since, today);
  if (!R.ok) return R;

  const wmap = cfg.hxWorkerMap || {}, pmap = cfg.hxProcMap || {};
  const orders = Object.entries(docs).filter(([k]) => k.startsWith('orders/')).map(([k, v]) => ({ ...v, id:k.slice(7) }));
  const byNo = new Map();
  orders.forEach(o => { const s = o.source || {}; (s.nos || (s.no ? [s.no] : [])).forEach(n => byNo.set(String(n), o)); });
  const linked = {};
  const findOrder = r => {
    if (byNo.has(r.no)) return byNo.get(r.no);
    const c = orders.filter(o => o.status !== 'archived' && !hasNos(o) && (styleNames(o, styles).has(r.style) || styleNames(o, styles).has(baseName(r.style))))
      .filter(o => !o.color || !r.color || o.color === r.color);
    if (c.length === 1) { linked[r.no] = c[0].id; byNo.set(r.no, c[0]); return c[0]; }
    return null;
  };

  // 不在看板上、但款式认识的裁剪单：自动导入
  const rid = p => p + Math.random().toString(36).slice(2, 12);
  const fresh = new Set(), autoMade = [], autoPlan = {};
  const unknown = {};
  for (const r of R.rows) if (!byNo.has(r.no) && !unknown[r.no] && !findOrder(r)) unknown[r.no] = r;
  for (const [no, r] of Object.entries(unknown)) { const k = knownStyle(r.style, styles, orders); if (k) autoPlan[no] = { style:r.style, from:k.from, k }; }
  if (Object.keys(autoPlan).length && !dry) {
    const C = await rows(dataDir, null, Object.keys(autoPlan));
    if (!C.ok) return C;
    const groups = new Map();
    for (const c of C.rows) {
      if (!autoPlan[c.no]) continue;
      const key = c.style + '|' + c.item + '|' + c.color;
      if (!groups.has(key)) groups.set(key, { style:c.style, item:c.item, color:c.color, rows:[], k:autoPlan[c.no].k });
      groups.get(key).rows.push(c);
    }
    for (const g of groups.values()) {
      const bd = new Map(); g.rows.forEach(c => { const k = c.color + '|' + c.size; bd.set(k, (bd.get(k) || 0) + c.q); });
      const nos = [...new Set(g.rows.map(c => c.no))];
      const steps = g.k.steps.map(x => ({ id:rid('s'), p:x.p, ...(x.gx ? { gx:x.gx } : {}) }));
      const bedPlan = completeBedBreakdown(g.rows);
      const id = rid('o');
      const o = { kind:'order', customer:'', style:g.style, color:g.color || '', styleId:g.k.styleId, qty:g.rows.reduce((a, c) => a + c.q, 0), due:'', steps, processes:steps.map(s => s.p), status:'active', createdAt:Date.now(),
        source:{ sys:'打票软件裁剪单', auto:'员工扫票时自动导入', scanAll:true, nos, no:nos.length === 1 ? nos[0] : `${nos[0]} 等 ${nos.length} 个`,
          date:[...new Set(g.rows.map(c => c.date).filter(Boolean))].sort().join('、'), item:g.item, bed:[...new Set(g.rows.map(c => c.bed).filter(Boolean))].join('、'), bundles:g.rows.length, route:g.k.from },
        breakdown:[...bd].map(([k, q]) => { const [c, z] = k.split('|'); return { c, s:z, q }; }),
        ...(bedPlan ? { bedBreakdown:bedPlan } : {}) };
      docs['orders/' + id] = o;
      const full = { ...o, id }; orders.push(full); nos.forEach(n => byNo.set(n, full)); fresh.add(id);
      autoMade.push({ nos, style:g.style, color:g.color, qty:o.qty, route:g.k.from });
    }
    // 新导入的单：以前的扫票也一起补上
    if (autoMade.length) {
      const E = await scans(dataDir, null, today, autoMade.flatMap(a => a.nos));
      if (!E.ok) return E;
      const seen = new Set(R.rows.map(r => r.id));
      E.rows.forEach(r => { if (!seen.has(r.id)) R.rows.push(r); });
    }
  }

  const wOf = r => { const k = r.name || r.bh; return k in wmap ? wmap[k] : guessWorker(r.name, workers); };
  const pOf = r => r.gx in pmap ? pmap[r.gx] : guessProc(r.gx, procs);

  // 汇总：日 × 员工 × 订单 × 看板工序 × 包 → 件数（同一包几道小工序取最大的一次）
  const bundles = new Map(), miss = { worker:{}, proc:{}, order:{}, step:{} }, seenW = {}, seenP = {};
  for (const r of R.rows) {
    const wk = r.name || r.bh;
    if (!(wk in seenW)) seenW[wk] = wOf(r);
    if (!(r.gx in seenP)) seenP[r.gx] = pOf(r);
    const wid = seenW[wk], pid = seenP[r.gx];
    if (!wid) { miss.worker[wk] = (miss.worker[wk] || 0) + r.q; continue; }
    if (!pid) { miss.proc[r.gx] = (miss.proc[r.gx] || 0) + r.q; continue; }
    const o = findOrder(r);
    if (!o) { const k = r.no + ' ' + r.style + (r.color ? ' ' + r.color : ''); miss.order[k] = (miss.order[k] || 0) + r.q; continue; }
    if (!dry && r.day < since && !(o.source && o.source.scanAll)) continue;
    const route = Array.isArray(o.steps) ? o.steps : [];
    const exact = route.find(st => st.gx && st.gx === r.gx);
    const sk = exact ? exact.id : '';
    const pp = exact ? exact.p : pid;
    const key = [r.day, wid, o.id, pp, sk, r.no, r.bag, r.color, r.size].join('\u0001');
    const b = bundles.get(key);
    // 工序名逐票保留，包件数仍只计最大的一次。
    const ticketNames = b ? b.ticketNames : new Set();
    if (r.q > 0 && r.gx && (!exact || !route.some(st => st !== exact && st.gx === r.gx))) ticketNames.add(r.gx);
    if (!b || r.q > b.q) bundles.set(key, { day:r.day, wid, oid:o.id, pid:pp, sk, c:o.color || r.color, s:r.size, q:r.q, ticketNames });
  }
  const sums = new Map();
  for (const b of bundles.values()) {
    const k = [b.day, b.wid, b.oid, b.pid, b.sk].join('\u0001');
    const x = sums.get(k) || { day:b.day, wid:b.wid, oid:b.oid, pid:b.pid, sk:b.sk, q:0, lines:{}, ticketNames:new Set() };
    x.q += b.q; const lk = b.c + '|' + b.s; x.lines[lk] = (x.lines[lk] || 0) + b.q;
    for (const name of b.ticketNames) x.ticketNames.add(name);
    sums.set(k, x);
  }

  const wname = id => (workers.find(w => w.id === id) || {}).name || id;
  const pname = id => (procs.find(p => p.id === id) || {}).name || id;
  const oname = o => o ? (o.style || o.customer || '') + (o.color ? ' · ' + o.color : '') : '';
  const summary = [...sums.values()].map(x => ({ day:x.day, worker:wname(x.wid), order:oname(orders.find(o => o.id === x.oid)), proc:pname(x.pid), q:x.q }));
  const mapping = {
    workers: Object.entries(seenW).map(([name, wid]) => ({ name, wid, set: name in wmap })),
    procs: Object.entries(seenP).map(([gx, pid]) => ({ gx, pid, set: gx in pmap })),
  };
  // 预览时，会自动导入的单从「对不上」里拿出来单独列
  const auto = Object.entries(autoPlan).map(([no, a]) => ({ no, style:a.style, route:a.from }));
  if (dry) { for (const k of Object.keys(miss.order)) if (autoPlan[k.split(' ')[0]]) delete miss.order[k]; }
  if (dry) return { ok:true, dry:true, since, until:today, rows:R.rows.length, summary, mapping, miss, linked, auto };

  // 写进看板：算出每个任务每天应有的打票件数，和上次记下的比，只补差额
  const tasks = Object.entries(docs).filter(([k]) => k.startsWith('tasks/')).map(([k, v]) => ({ ...v, id:k.slice(6) }));
  const stepsOf = o => Array.isArray(o.steps) && o.steps.length ? o.steps : (o.processes || []).map((p, i) => ({ id:'legacy' + i, p }));
  const want = {};   // day -> tid -> { q, lines:{ 'c|s': n }, ticketNames }
  let made = 0;
  for (const x of [...sums.values()].sort((a, b) => a.day.localeCompare(b.day))) {
    const o = orders.find(z => z.id === x.oid);
    const route = stepsOf(o);
    const steps = x.sk ? route.filter(s => s.id === x.sk) : route.filter(s => s.p === x.pid && !s.gx).concat(route.filter(s => s.p === x.pid && s.gx));
    if (!steps.length) { const k = oname(o) + ' 的路线里没有「' + pname(x.pid) + '」'; miss.step[k] = (miss.step[k] || 0) + x.q; continue; }
    const stepIds = new Set(steps.map(s => s.id));
    const mine = tasks.filter(t => t.orderId === o.id && t.workerId === x.wid && (stepIds.has(t.step) || (!t.step && t.process === x.pid)))
      .sort((a, b) => steps.findIndex(s => s.id === a.step) - steps.findIndex(s => s.id === b.step) || (a.seq || 0) - (b.seq || 0));
    const H = (docs['hxlog/' + x.day] || {}).tasks || {};
    // 上次记在哪个任务上就继续记在那个任务上；第一次就记在还没做完的那个
    let t = mine.find(t => H[t.id]) || mine.find(t => t.status !== 'done') || mine[0];
    if (!t) {   // 没派过：像报工页「直接记上」一样新建一个任务
      const id = rid('t');
      // 路线里同一道工序有好几次（比如两道平车）：先放到还没有人做的那一次
      const freeStep = steps.find(s => !tasks.some(z => z.orderId === o.id && z.step === s.id)) || steps[0];
      t = { id, orderId:o.id, step:freeStep.id, process:x.pid, workerId:x.wid, target:0, done:0, status:'done', adhoc:true, hx:true, dist:{}, seq:Date.now(), createdAt:Date.now() };
      const { id:_, ...doc } = t; docs['tasks/' + id] = doc; tasks.push(t); made++;
    }
    const d = want[x.day] || (want[x.day] = {});
    const cur = d[t.id] || (d[t.id] = { q:0, lines:{}, ticketNames:new Set() });
    cur.q += x.q; for (const [k, n] of Object.entries(x.lines)) cur.lines[k] = (cur.lines[k] || 0) + n;
    // 同类工序有多道时，沿用原有的件数落点，但只在能定位到同一道时显示票名。
    if (steps.length === 1 && (t.step === steps[0].id || (!t.step && route.filter(s => s.p === t.process).length === 1))) {
      for (const name of x.ticketNames) cur.ticketNames.add(name);
    }
  }

  let touched = 0, delta = 0;
  const taskNames = new Map();
  const days = new Set(Object.keys(want));
  for (let d = since; d <= today; d = nextDay(d)) days.add(d);
  for (const day of [...days].sort()) {
    const W = want[day] || {};
    const H0 = docs['hxlog/' + day], H = { day, tasks:{ ...((H0 && H0.tasks) || {}) } };
    const log = docs['logs/' + day] ? { ...docs['logs/' + day] } : { date:day, entries:{}, lines:{} };
    log.entries = { ...(log.entries || {}) }; log.lines = { ...(log.lines || {}) };
    let dayChanged = false, logChanged = false;
    for (const tid of new Set([...Object.keys(W), ...Object.keys(H.tasks)])) {
      const doc = docs['tasks/' + tid]; if (!doc) { delete H.tasks[tid]; dayChanged = logChanged = true; continue; }
      const nw = W[tid] || { q:0, lines:{} }, old = H.tasks[tid] || { q:0, lines:{} };
      const names = nw.q && nw.ticketNames ? [...nw.ticketNames].sort() : [];
      const oldNames = old.ticketNames || [];
      if (names.length || oldNames.length || doc.hxTicketNames) taskNames.set(tid, new Set());
      if (nw.q === old.q && JSON.stringify(nw.lines) === JSON.stringify(old.lines)) {
        if (JSON.stringify(names) !== JSON.stringify(oldNames)) {
          const entry = { ...old };
          if (names.length) entry.ticketNames = names; else delete entry.ticketNames;
          H.tasks[tid] = entry;
          dayChanged = true;
        }
        continue;
      }
      const dq = nw.q - old.q;
      doc.done = Math.max(0, (Number(doc.done) || 0) + dq);
      const dist = { ...(doc.dist || {}) };
      for (const [k, n] of Object.entries(old.lines)) if (k !== '|') dist[k] = Math.max(0, (dist[k] || 0) - n);
      for (const [k, n] of Object.entries(nw.lines)) if (k !== '|') dist[k] = (dist[k] || 0) + n;
      doc.dist = dist;
      if (doc.adhoc) doc.target = doc.done;
      doc.status = doc.done >= (Number(doc.target) || 0) ? 'done' : 'active';
      // 当天报工：去掉上次打票填的行，换成这次的；手工报的行留着
      const manual = (log.lines[tid] || []).filter(l => !l.hx);
      const hxLines = Object.entries(nw.lines).map(([k, n]) => { const [c, s] = k.split('|'); return { c, s, q:n, hx:true }; });
      const all = [...manual, ...hxLines];
      const tot = all.reduce((a, l) => a + (Number(l.q) || 0), 0);
      if (tot) { log.entries[tid] = tot; log.lines[tid] = all; } else { delete log.entries[tid]; delete log.lines[tid]; }
      if (nw.q) H.tasks[tid] = { q:nw.q, lines:nw.lines, ...(names.length ? { ticketNames:names } : {}) }; else delete H.tasks[tid];
      touched++; delta += dq; dayChanged = logChanged = true;
    }
    if (dayChanged) docs['hxlog/' + day] = { ...H, at:Date.now() };
    if (logChanged) docs['logs/' + day] = log;
  }
  if (taskNames.size) {
    for (const [key, ledger] of Object.entries(docs)) {
      if (!key.startsWith('hxlog/')) continue;
      for (const [tid, entry] of Object.entries(ledger.tasks || {})) {
        const names = taskNames.get(tid);
        if (names && entry.q) for (const name of entry.ticketNames || []) names.add(name);
      }
    }
    for (const [tid, names] of taskNames) {
      const doc = docs['tasks/' + tid];
      if (names.size) doc.hxTicketNames = [...names].sort(); else delete doc.hxTicketNames;
    }
  }
  // 自动认上的裁剪单号记到订单上，以后同步裁剪单不会再重复建单
  for (const [no, oid] of Object.entries(linked)) {
    const o = docs['orders/' + oid]; if (!o) continue;
    const s = o.source || (o.source = { sys:'打票软件扫票时认上', nos:[] });
    s.nos = [...new Set([...(s.nos || (s.no ? [s.no] : [])), no])];
    if (!s.no) s.no = s.nos.join('、');
  }
  const message = (autoMade.length ? `自动导入了 ${autoMade.length} 张裁剪单（${autoMade.map(a => a.style + (a.color ? ' ' + a.color : '')).join('、')}），` : '')
    + (touched ? `已从打票软件更新 ${touched} 条报工（${delta >= 0 ? '+' : ''}${delta} 件）` : '打票软件没有新的扫票');
  docs['hxstate/scan'] = { at:Date.now(), since, until:today, rows:R.rows.length, touched, delta, made, miss, linked, autoMade, message };
  changed();
  return { ok:true, since, until:today, rows:R.rows.length, touched, delta, made, miss, linked, autoMade, message };
}

/* 打票软件的款式和工序：rp_ksmas（款号、款名）+ sc_price（每个款的工序，按工序号排，停用的不要）
   每道工序按设置里的归类（或关键词）对到看板工序 */
async function hxStyles({ dataDir, db }){
  const L = loadCfg(dataDir); if (!L.ok) return { ok:false, message:L.why };
  const cfg = db.docs['config/main'] || {}, procs = cfg.processes || [], pmap = cfg.hxProcMap || {};
  let conn, ks, gx, cut;
  try {
    conn = await connect(L.cfg);
    ks = await query(conn, 'SELECT f_ks_no, f_ks_dsp FROM rp_ksmas');
    gx = await query(conn, 'SELECT f_ks_no, f_gx_no, f_gx_dsp, nPrice FROM sc_price WHERE (bStop = 0 OR bStop IS NULL) ORDER BY f_ks_no, f_gx_no, nAutoID');
    cut = await query(conn, `SELECT f_ks_no, MAX(f_sc_date) AS last, COUNT(DISTINCT f_sc_no) AS n FROM [${L.cfg.table}] GROUP BY f_ks_no`);
  } catch (e) { return { ok:false, message:explain(e) }; }
  finally { if (conn) close(conn); }
  const lastCut = {}; cut.forEach(r => { lastCut[str(r.f_ks_no)] = { last:fmtDate(r.last), n:r.n }; });
  const steps = {};
  gx.forEach(r => { const name = str(r.f_gx_dsp); if (!name) return; const k = str(r.f_ks_no); (steps[k] || (steps[k] = [])).push({ no:str(r.f_gx_no), gx:name, price:Number(r.nPrice) || 0, p: name in pmap ? pmap[name] : guessProc(name, procs) }); });
  const list = ks.map(r => { const no = str(r.f_ks_no); return { ksNo:no, name:str(r.f_ks_dsp), steps:steps[no] || [], last:(lastCut[no] || {}).last || '', cuts:(lastCut[no] || {}).n || 0 }; })
    .filter(x => x.name && x.steps.length);
  return { ok:true, styles:list };
}

const sizeKey = (c, s) => JSON.stringify([str(c), str(s)]);
function orderBedNos(o){
  const source = o && o.source || {};
  const list = Array.isArray(source.nos) && source.nos.length ? source.nos
    : /等\s*\d+\s*个/.test(str(source.no)) ? [] : str(source.no).split(/[、,，]+/);
  return [...new Set(list.map(str).filter(Boolean))];
}
function bedSourceStamp(o){
  return JSON.stringify([orderBedNos(o), o && o.source && o.source.item, o && o.source && o.source.bed,
    o && o.color, o && o.breakdown, o && o.bedBreakdown]);
}
function bedPlanForOrder(o, byNo){
  if (Array.isArray(o.bedBreakdown) && o.bedBreakdown.length) return { status:'already', reason:'已有尺码裁床号映射' };
  const nos = orderBedNos(o);
  if (!nos.length) return { status:'skip', reason:'没有关联裁剪单号，不能从打票软件回填' };
  if (!Array.isArray(o.breakdown) || !o.breakdown.length) return { status:'skip', reason:'订单没有尺码明细，不能核对映射' };
  const expected = new Map();
  for (const r of o.breakdown) {
    const q = Number(r.q), key = sizeKey(r.c || o.color, r.s);
    if (!(q > 0) || !Number.isFinite(q)) return { status:'skip', reason:'订单尺码计划数量不合法' };
    expected.set(key, (expected.get(key) || 0) + q);
  }
  const colors = new Set([...expected.keys()].map(k => JSON.parse(k)[0]));
  const item = str(o.source && o.source.item);
  const matched = nos.flatMap(no => byNo.get(no) || [])
    .filter(r => colors.has(str(r.color)) && (!item || str(r.item) === item));
  if (!matched.length) return { status:'skip', reason:'打票软件没有找到该订单颜色与货号的原始行' };
  const actual = new Map();
  for (const r of matched) {
    const key = sizeKey(r.color, r.size);
    actual.set(key, (actual.get(key) || 0) + Number(r.q));
  }
  if ([...new Set([...expected.keys(), ...actual.keys()])].some(k => (expected.get(k) || 0) !== (actual.get(k) || 0)))
    return { status:'skip', reason:'打票软件与看板的各颜色尺码数量不一致，需人工核对' };
  if (matched.some(r => !str(r.bed))) return { status:'skip', reason:'原始行有空裁床号，不能形成完整映射' };
  const sourceBeds = new Set(str(o.source && o.source.bed).split(/[、,，\s]+/).filter(Boolean));
  const rawBeds = new Set(matched.map(r => str(r.bed)));
  if (sourceBeds.size && (sourceBeds.size !== rawBeds.size || [...sourceBeds].some(b => !rawBeds.has(b))))
    return { status:'skip', reason:'打票软件与看板的裁床号列表不一致，需人工核对' };
  return { status:'ready', reason:'可补回', bedBreakdown:bedBreakdown(matched), qty:[...actual.values()].reduce((a, b) => a + b, 0) };
}

// 先 GET /api/hx/bedplan 预览；明确 POST /api/hx/bedfill 才会只补订单的 bedBreakdown。
async function backfillBeds({ dataDir, db, changed }, apply, readCutRows = rows){
  const snapshots = Object.entries(db.docs).filter(([k]) => k.startsWith('orders/'))
    .map(([key, order]) => ({ key, order, stamp:bedSourceStamp(order) }));
  const nos = [...new Set(snapshots.filter(x => !(Array.isArray(x.order.bedBreakdown) && x.order.bedBreakdown.length))
    .flatMap(x => orderBedNos(x.order)))];
  const byNo = new Map(); let queriedRows = 0;
  for (let i = 0; i < nos.length; i += 100) {
    const R = await readCutRows(dataDir, null, nos.slice(i, i + 100));
    if (!R.ok) return R;
    if (R.truncated) return { ok:false, message:'裁剪单查询达到 20000 行上限，未回填；请缩小批次后再试' };
    queriedRows += R.rows.length;
    for (const r of R.rows) {
      const a = byNo.get(r.no) || []; a.push(r); byNo.set(r.no, a);
    }
  }
  const pending = [];
  const items = snapshots.map(x => {
    const current = db.docs[x.key];
    if (!current || bedSourceStamp(current) !== x.stamp)
      return { id:x.key.slice(7), style:x.order.style || '', status:'skip', reason:'查询期间订单资料发生变化，未回填' };
    const plan = bedPlanForOrder(current, byNo);
    if (apply && plan.status === 'ready') pending.push({ key:x.key, bedBreakdown:plan.bedBreakdown });
    return { id:x.key.slice(7), style:current.style || '', color:current.color || '', status:plan.status,
      reason:plan.reason, qty:plan.qty, bedBreakdown:plan.bedBreakdown };
  });
  for (const p of pending) db.docs[p.key].bedBreakdown = p.bedBreakdown;
  const updated = pending.length;
  if (updated) changed();
  const counts = { ready:items.filter(x => x.status === 'ready').length,
    already:items.filter(x => x.status === 'already').length, skipped:items.filter(x => x.status === 'skip').length };
  return { ok:true, dry:!apply, queriedNos:nos.length, queriedRows, updated, ...counts, items };
}

/* 歷史核對獨立於同步流程。只讀既有裁剪單號與指定日期，不建立訂單或補登報工。 */
async function readHistoricalScans(dataDir, since, until, nos){
  const L = loadCfg(dataDir, false);
  if (!L.ok) return { ok:false, message:L.why };
  let conn;
  try {
    conn = await connect(L.cfg);
    const I = inList(nos);
    const params = [
      ...I.params,
      { name:'a', type:tedious.TYPES.VarChar, value:'CLD' + since },
      { name:'b', type:tedious.TYPES.VarChar, value:'CLD' + until },
    ];
    const records = await query(conn, `SELECT TOP 20000 f_pty_no, f_sc_no, f_col_dsp, f_size, f_gx_dsp, bh, name, f_qty, nPage, CaiChuanHao
      FROM [report_sc_ptymas] WHERE f_sc_no IN (${I.sql}) AND f_pty_no >= @a AND f_pty_no <= @b`, params);
    return { ok:true, truncated:records.length >= 20000, rows:records.map(r => ({
      day:str(r.f_pty_no).replace(/^CLD/, ''), no:str(r.f_sc_no), color:str(r.f_col_dsp), size:str(r.f_size),
      gx:str(r.f_gx_dsp), bh:str(r.bh), name:str(r.name), q:Number(r.f_qty), bag:str(r.nPage), bed:str(r.CaiChuanHao),
    })) };
  } catch (e) { return { ok:false, message:explain(e) }; }
  finally { if (conn) close(conn); }
}

const historicalDay = value => isDay(value) && !isNaN(Date.parse(value + 'T00:00:00Z')) &&
  new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
const historicalSpec = (color, size) => [color, size].filter(Boolean).join(' ') || '未分顏色尺碼';
const historicalQty = value => Number.isSafeInteger(Number(value)) && Number(value) >= 0;
const historicalKey = (...parts) => JSON.stringify(parts);
function historicalGroup(map, key, group, qty){
  if (!map.has(key)) map.set(key, { ...group, q:0 });
  map.get(key).q += qty;
}
function historicalSteps(order, names){
  const route = Array.isArray(order.steps) && order.steps.length ? order.steps
    : (Array.isArray(order.processes) ? order.processes.map(p => ({ id:p, p })) : []);
  return route.map((s, i) => {
    const label = str(s.gx) || names.get(s.p) || '未命名工序';
    return {
      id:s.id, index:i, legacyId:!order.steps?.length ? 'legacy' + i : null, p:s.p, gx:str(s.gx), label,
      current:0, allSynced:0, periodSynced:0, manual:false, posted:new Map(), old:new Map(), packs:new Map(), issues:new Set(),
    };
  });
}
function historicalRouteStep(stages, task){
  const matched = task.step !== null && task.step !== undefined && task.step !== ''
    ? stages.filter(s => s.id === task.step || s.legacyId === task.step)
    : stages.filter(s => s.p === task.process);
  return matched.length === 1 ? matched[0] : null;
}
function historicalSourceStage(stages, gx, pmap, names){
  if (!gx) return null;
  const exact = stages.filter(s => s.gx === gx);
  if (exact.length) return exact.length === 1 ? exact[0] : null;
  const pids = Object.prototype.hasOwnProperty.call(pmap, gx) ? [pmap[gx]]
    : [...names].filter(([, name]) => name === gx).map(([id]) => id);
  if (pids.length !== 1 || !pids[0]) return null;
  const mapped = stages.filter(s => s.p === pids[0]);
  return mapped.length === 1 ? mapped[0] : null;
}

function historicalStageResult(order, stage, orphanedLedger){
  const issues = new Set([...order.issues, ...stage.issues]);
  if (stage.old.size && (stage.manual || stage.current > stage.allSynced))
    issues.add('看板這道工序已有手工報工或未標明來源的累計，舊掃票可能重複');
  if (stage.current < stage.allSynced) issues.add('看板工序累計與已同步紀錄不一致');
  let counted = 0, candidates = 0;
  const details = new Map();
  for (const [key, scan] of stage.old) {
    const posted = stage.posted.get(key);
    counted += scan.q;
    if (posted && posted.q !== scan.q) issues.add('同日期、員工、顏色尺碼的已同步件數和舊掃票不一致');
    candidates += posted ? 0 : scan.q;
    const detailKey = historicalKey(scan.day, scan.color, scan.size);
    historicalGroup(details, detailKey, { day:scan.day, size:historicalSpec(scan.color, scan.size), synced:0 }, scan.q);
    details.get(detailKey).synced += posted?.q || 0;
  }
  for (const [key, posted] of stage.posted) {
    if (!stage.old.has(key)) {
      issues.add('看板有同期間的同步紀錄，但無法對上本次查到的舊掃票');
      const detailKey = historicalKey(posted.day, posted.color, posted.size);
      historicalGroup(details, detailKey, { day:posted.day, size:historicalSpec(posted.color, posted.size), synced:0 }, 0);
      details.get(detailKey).synced += posted.q;
    }
  }
  if (candidates && orphanedLedger) issues.add('此期間部分已同步紀錄的任務已缺失，請人工排除重複');
  const status = issues.size ? 'review' : candidates ? 'ready' : counted ? 'applied' : 'empty';
  const reason = issues.size ? [...issues].join('；') :
    status === 'ready' ? '裁剪單和工序均可對應，未發現重複入帳或手工報工。' :
      status === 'applied' ? '按原掃票日期、員工及顏色尺碼核對，件數與看板同步紀錄一致。' : '此日期區間未查到這道工序的掃票。';
  const scans = [...details.values()].sort((a, b) => a.day.localeCompare(b.day) || a.size.localeCompare(b.size));
  return {
    id:historicalKey(order.id, stage.id, stage.index), order:order.label, cut:order.nos.join('、'), step:stage.label,
    current:stage.current, counted:stage.uncertain ? null : counted, synced:stage.unknownSynced ? null : stage.periodSynced,
    status, unlinked:false, reason, scans,
  };
}

async function historicalScan({ dataDir, q, db, method }, readScans = readHistoricalScans){
  if (method !== 'GET') return { ok:false, message:'歷史掃票核對僅支援唯讀查詢' };
  const since = q.get('since'), until = q.get('until');
  if (!historicalDay(since) || !historicalDay(until) || since > until || until >= dayStr(new Date()) ||
      Date.parse(until) - Date.parse(since) > 365 * 864e5)
    return { ok:false, message:'請選擇有效的歷史日期，截止日要早於今天，單次最多查 366 天' };
  const docs = db.docs;
  const cfg = docs['config/main'] || {};
  const syncSince = str(cfg.hxScanSince);
  const names = new Map((cfg.processes || []).map(p => [p.id, p.name]));
  const workerIds = new Set((cfg.workers || []).map(w => w.id));
  const workerNames = new Map();
  for (const w of cfg.workers || []) {
    const name = str(w.name);
    if (name) workerNames.set(name, workerNames.has(name) ? null : w.id);
  }
  const wmap = { ...cfg.hxWorkerMap }, pmap = { ...cfg.hxProcMap };
  const byCut = new Map(), orders = new Map(), resultRows = [];
  for (const [key, o] of Object.entries(docs)) {
    if (!key.startsWith('orders/')) continue;
    const id = key.slice(7), color = str(o.color);
    const label = [str(o.style) || str(o.customer) || '未命名訂單', color].filter(Boolean).join(' · ');
    const nos = orderBedNos(o);
    for (const no of nos) {
      const cutKey = no.toUpperCase(); // SQL 比對可能不分大小寫，避免兩個寫法被當成兩張確定單
      if (!byCut.has(cutKey)) byCut.set(cutKey, []);
      byCut.get(cutKey).push(id);
    }
    if (o.status === 'archived' || o.kind === 'stock') continue;
    orders.set(id, { id, label, color, nos, stages:historicalSteps(o, names), issues:new Set(), unmatched:new Map() });
  }
  const known = new Map();
  for (const order of orders.values()) {
    const invalid = order.nos.some(no => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(no));
    const conflicts = order.nos.filter(no => byCut.get(no.toUpperCase()).length !== 1);
    const reason = !order.nos.length ? '這張訂單還沒有對應的裁剪單號。請先核對確切單號。' : invalid ? '訂單的裁剪單號格式需核對' :
      conflicts.length ? '裁剪單號同時關聯到多張訂單，需核對：' + conflicts.join('、') :
        !order.stages.length ? '看板這張單沒有可對應的工序路線' : '';
    if (reason) {
      resultRows.push({ id:historicalKey(order.id), order:order.label, cut:order.nos.join('、') || '未關聯裁剪單',
        step:'待對應', counted:null, synced:null, current:null, status:'review', unlinked:!order.nos.length, reason, scans:[] });
      continue;
    }
    order.nos.forEach(no => known.set(no.toUpperCase(), order));
  }
  const queriedOrders = new Set(known.values()).size;

  const taskRefs = new Map();
  for (const [key, task] of Object.entries(docs)) {
    if (!key.startsWith('tasks/')) continue;
    const order = orders.get(task.orderId);
    if (!order) continue;
    const stage = historicalRouteStep(order.stages, task);
    if (!stage) {
      if (Number(task.done)) order.issues.add('部分看板任務無法唯一對應到工序');
      continue;
    }
    stage.current += Number(task.done) || 0;
    if (!historicalQty(task.done || 0)) stage.issues.add('看板工序累計件數需核對');
    taskRefs.set(key.slice(6), { order, stage, worker:task.workerId });
  }
  let orphanedLedger = false;
  for (const [key, log] of Object.entries(docs)) {
    if (!key.startsWith('hxlog/')) continue;
    const day = key.slice(6);
    for (const [tid, entry] of Object.entries(log.tasks || {})) {
      const ref = taskRefs.get(tid);
      if (!ref) {
        if (day >= since && day <= until && Number(entry.q) && !docs['tasks/' + tid]) orphanedLedger = true;
        continue;
      }
      const { stage, worker } = ref;
      stage.allSynced += Number(entry.q) || 0;
      if (day < since || day > until) continue;
      if (historicalQty(entry.q)) stage.periodSynced += Number(entry.q);
      else stage.unknownSynced = true;
      const lines = Object.entries(entry.lines || {});
      if (!worker || !historicalQty(entry.q) || lines.some(([spec, qty]) => spec.split('|').length !== 2 || !historicalQty(qty)) ||
          lines.reduce((sum, [, qty]) => sum + Number(qty), 0) !== Number(entry.q)) {
        stage.issues.add('看板舊同步紀錄缺少可核對的員工或顏色尺碼');
        continue;
      }
      for (const [spec, qty] of lines) {
        const [color, size] = spec.split('|').map(str);
        if (Number(qty)) historicalGroup(stage.posted, historicalKey(day, worker, color, size), { day, color, size }, Number(qty));
      }
    }
  }
  for (const [key, log] of Object.entries(docs)) {
    if (!key.startsWith('logs/')) continue;
    for (const [tid, qty] of Object.entries(log.entries || {})) {
      const ref = taskRefs.get(tid);
      if (ref && Number(qty) > (Number(docs['hxlog/' + key.slice(5)]?.tasks?.[tid]?.q) || 0)) ref.stage.manual = true;
    }
    for (const [tid, lines] of Object.entries(log.lines || {})) {
      const ref = taskRefs.get(tid);
      if (ref && Array.isArray(lines) && lines.some(line => !line.hx && Number(line.q) > 0)) ref.stage.manual = true;
    }
  }

  let queriedRows = 0;
  const cutNumbers = [...new Set([...known.values()].flatMap(order => order.nos))];
  for (let i = 0; i < cutNumbers.length; i += 80) {
    const batch = cutNumbers.slice(i, i + 80);
    const batchKeys = new Set(batch.map(no => no.toUpperCase()));
    const reply = await readScans(dataDir, since, until, batch);
    if (!reply.ok) return reply;
    if (reply.truncated || queriedRows + reply.rows.length > 60000)
      return { ok:false, message:'掃票筆數超過查詢上限，請縮短日期區間後再核對' };
    queriedRows += reply.rows.length;
    for (const record of reply.rows) {
      const cutKey = str(record.no).toUpperCase(), day = str(record.day);
      if (!batchKeys.has(cutKey) || !historicalDay(day) || day < since || day > until)
        return { ok:false, message:'宏翔返回的單號或日期超出查詢範圍，無法可靠核對' };
      const order = known.get(cutKey);
      const { color:scanColor, size, gx } = { color:str(record.color), size:str(record.size), gx:str(record.gx) };
      const stage = historicalSourceStage(order.stages, gx, pmap, names);
      const qty = Number(record.q);
      if (!stage || (order.color && scanColor && order.color !== scanColor)) {
        order.issues.add('部分掃票的顏色或工序無法唯一對應，需人工核對');
        if (historicalQty(qty) && qty) {
          const spec = historicalSpec(scanColor, size) + (gx ? ' · ' + gx : '');
          historicalGroup(order.unmatched, historicalKey(day, spec), { day, size:spec, synced:0 }, qty);
        }
        continue;
      }
      if (!historicalQty(qty) || !qty) { stage.issues.add('宏翔掃票件數需核對'); stage.uncertain = true; continue; }
      const workerName = str(record.name), workerKey = workerName || str(record.bh);
      const wid = Object.prototype.hasOwnProperty.call(wmap, workerKey) ? wmap[workerKey] : workerNames.get(workerName);
      if (!wid || !workerIds.has(wid)) stage.issues.add('部分掃票的員工尚未對應');
      const worker = wid && workerIds.has(wid) ? wid : null;
      const color = order.color || scanColor, bag = str(record.bag), bed = str(record.bed);
      const item = { day, worker, workerKey, color, size, q:qty, bed };
      if (!bag || bag === '0') {
        stage.issues.add('部分掃票缺少可去重的包號');
        stage.uncertain = true;
        stage.packs.set(Symbol(), item);
        continue;
      }
      const key = historicalKey(cutKey, bag, color, size);
      const previous = stage.packs.get(key);
      if (!previous) stage.packs.set(key, item);
      else if (previous.day !== day || (previous.worker || previous.workerKey) !== (worker || workerKey) ||
          previous.q !== qty || (previous.bed && bed && previous.bed !== bed)) {
        stage.issues.add('同包有跨日、換人或件數不一致的掃票，需按原票核對');
        stage.uncertain = true;
        stage.packs.set(Symbol(), item);
      }
      else if (!previous.bed) previous.bed = bed;
    }
  }
  for (const order of new Set(known.values())) {
    for (const stage of order.stages) {
      for (const scan of stage.packs.values()) {
        const key = historicalKey(scan.day, scan.worker, scan.color, scan.size);
        historicalGroup(stage.old, key, scan, scan.q);
      }
      resultRows.push(historicalStageResult(order, stage, orphanedLedger));
    }
    if (order.unmatched.size) {
      resultRows.push({ id:historicalKey(order.id, 'unmatched'), order:order.label, cut:order.nos.join('、'),
        step:'未對應的掃票', counted:null, synced:null, current:null, status:'review', unlinked:false,
        reason:'以下是無法對應到唯一工序或顏色的原始掃票，件數尚未按包去重。', scans:[...order.unmatched.values()] });
    }
  }
  return { ok:true, since, until, syncSince, queriedOrders, queriedRows, rows:resultRows };
}

const api = {
  styles: ctx => hxStyles(ctx),
  scanplan: ctx => { ctx.q.set('dry', '1'); return scanSync(ctx); },
  scansync: ctx => { ctx.q.delete('dry'); return scanSync(ctx); },
  scans: ({ dataDir, q }) => scans(dataDir, q.get('since'), q.get('until')),
  historicalscan: ctx => historicalScan(ctx),
  status: ({ dataDir }) => status(dataDir),
  test: ({ dataDir }) => test(dataDir),
  rows: ({ dataDir, q }) => rows(dataDir, q.get('since')),
  bedplan: ctx => ctx.method === 'GET' ? backfillBeds(ctx, false) : { ok:false, message:'请用 GET 预览' },
  bedfill: ctx => ctx.method === 'POST' ? backfillBeds(ctx, true) : { ok:false, message:'请用 POST 回填' },
};
module.exports = { test, rows, status, api, bedBreakdown, completeBedBreakdown, bedPlanForOrder, backfillBeds, historicalScan };
