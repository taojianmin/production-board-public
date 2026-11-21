// 让看板页面把数据存到 NAS：提供和 claude.ai 一样的 claude.use('db') 接口，背后调用 NAS 服务端
(function () {
  let docs = {}, rev = -1, loaded = false;
  const subs = new Set();
  const clone = v => v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
  const merge = (a, b) => { const o = { ...a }; for (const k of Object.keys(b)) o[k] = isObj(b[k]) && isObj(a[k]) ? merge(a[k], b[k]) : b[k]; return o; };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const segs = p => p.split('/').length;

  // 断线提示
  const badge = document.createElement('div');
  badge.textContent = '和 NAS 断开连接，正在重连…（这段时间的修改可能保存不上）';
  badge.style.cssText = 'position:fixed;left:50%;top:calc(8px + env(safe-area-inset-top,0px));transform:translateX(-50%);z-index:30;background:#b3261e;color:#fff;padding:6px 14px;border-radius:6px;font:500 13px system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.25)';
  badge.hidden = true;
  const showBadge = on => { badge.hidden = !on; if (on && !badge.isConnected) document.body.appendChild(badge); };

  // 外网访问要登录：登录过期时跳到登录页
  const toLogin = () => { location.replace('login?next=' + encodeURIComponent(location.pathname + location.search)); };

  function notify() { subs.forEach(f => { try { f(); } catch (e) { console.error(e); } }); }

  async function poll() {
    for (;;) {
      try {
        const r = await fetch('api/state?rev=' + rev, { cache: 'no-store' });
        if (r.status === 401) return toLogin();
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        showBadge(false);
        if (!j.same) { docs = j.docs || {}; rev = j.rev; loaded = true; notify(); }
      } catch (e) {
        showBadge(true);
        await sleep(3000);
      }
    }
  }

  const snapDoc = p => {
    const d = docs[p];
    return { id: p.split('/').pop(), exists: d !== undefined, data: () => clone(d), metadata: { fromCache: false, hasPendingWrites: false } };
  };
  const snapCol = c => {
    const n = segs(c) + 1;
    const list = Object.keys(docs).filter(k => k.startsWith(c + '/') && segs(k) === n).sort().map(snapDoc);
    return { docs: list, size: list.length, empty: !list.length, docChanges: () => [], metadata: { fromCache: false, hasPendingWrites: false } };
  };

  async function call(method, p, body) {
    let r;
    try {
      r = await fetch('api/doc/' + p.split('/').map(encodeURIComponent).join('/'), {
        method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch (e) { throw { code: 'unavailable', message: '连不上 NAS，请检查网络' }; }
    if (r.status === 401) { toLogin(); throw { code: 'unauthenticated', message: '需要重新登录' }; }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw { code: j.code || 'unavailable', message: j.message || ('NAS 返回错误 ' + r.status) };
    // 先在本地生效，界面立刻更新；随后长轮询会带回服务器上的最新数据
    if (method === 'PUT') docs = { ...docs, [p]: clone(body) };
    else if (method === 'PATCH') docs = { ...docs, [p]: merge(docs[p] || {}, clone(body)) };
    else if (method === 'DELETE') { docs = { ...docs }; delete docs[p]; }
    notify();
  }

  const rid = () => Math.random().toString(36).slice(2, 12) + Date.now().toString(36).slice(-4);
  function docRef(p) {
    return {
      id: p.split('/').pop(), path: p,
      get: async () => snapDoc(p),
      set: data => call('PUT', p, data),
      update: data => call('PATCH', p, data),
      delete: () => call('DELETE', p),
      onSnapshot(next) { const f = () => next(snapDoc(p)); subs.add(f); if (loaded) setTimeout(f, 0); return () => subs.delete(f); },
      collection: c => colRef(p + '/' + c),
    };
  }
  function colRef(c) {
    return {
      path: c,
      doc: id => docRef(c + '/' + (id || rid())),
      add: async data => { const r = docRef(c + '/' + rid()); await r.set(data); return r; },
      get: async () => snapCol(c),
      onSnapshot(next) { const f = () => next(snapCol(c)); subs.add(f); if (loaded) setTimeout(f, 0); return () => subs.delete(f); },
    };
  }

  const api = Object.freeze({ doc: docRef, collection: colRef });
  window.claude = { use: async name => name === 'db' ? api : null };
  poll();
})();
