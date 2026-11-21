// 把 ../board.html 包装成 NAS 用的 app/index.html
// 用法：node build.js     （改完 board.html 后重新运行，再把 app 文件夹复制到 NAS）
const fs = require('fs');
const path = require('path');
const board = fs.readFileSync(path.join(__dirname, '..', 'board.html'), 'utf8');
const adapter = fs.readFileSync(path.join(__dirname, 'nas-adapter.js'), 'utf8');
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<style>:root{color-scheme:light}body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style>
</head><body>
<script>
${adapter}
</script>
${board}
</body></html>
`;
fs.writeFileSync(path.join(__dirname, 'app', 'index.html'), html);
console.log('已生成 app/index.html');
