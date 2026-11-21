// 设置看板登录密码：在群晖上运行
//   sudo docker exec -it production-board node set-password.js
// 输入的密码不会显示在屏幕上，也不会存明文，只存加密后的结果到 /data/auth.json
// 取消登录验证：删掉 /data/auth.json 即可
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const AUTH_FILE = path.join(DATA_DIR, 'auth.json');

function ask(q) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = s => { if (s.includes(q)) process.stdout.write(s); else if (s.trim()) process.stdout.write('*'); };
    rl.question(q, a => { rl.close(); process.stdout.write('\n'); resolve(a); });
  });
}

(async () => {
  const a = await ask('新密码（至少 8 位）：');
  if (a.length < 8) { console.log('太短了，至少 8 位。没有修改。'); process.exit(1); }
  const b = await ask('再输一遍：');
  if (a !== b) { console.log('两次不一样。没有修改。'); process.exit(1); }
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(a, Buffer.from(salt, 'hex'), 32).toString('hex');
  let old = {}; try { old = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')); } catch (e) {}
  fs.writeFileSync(AUTH_FILE, JSON.stringify({ lanFree: old.lanFree !== false, salt, hash, setAt: new Date().toISOString() }, null, 1));
  // 换了密码，以前登录过的设备都要重新登录
  // 看板服务会发现密码变了，自动让以前登录的设备重新登录
  console.log('密码已设置，马上生效。设为局域网免登录时，局域网内仍可直接打开看板。');
})();
