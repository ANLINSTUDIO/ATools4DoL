/** ATool 推送接收端：连接 VSCode 扩展，接收 .mod.zip 并交给 ModLoader 安装；并提供一个可拖动的 SugarCube 调试面板。 */
(function () {
  'use strict';

  const PORT_MIN = 38471;
  const PORT_MAX = 38480;      // 扩展端每个 VSCode 窗口从 38471 起取第一个空闲端口，所以占用的一定是连续前缀
  const KNOWN_KEY = 'atools4dol-ports';
  const POS_KEY = 'atools4dol-panel-pos';

  const conns = new Map();     // port -> WebSocket
  let scanning = false;
  let panel = null;
  let dotEl = null;
  let textEl = null;
  let outEl = null;
  let srcEl = null;
  let selEl = null;
  let hlEl = null;
  let acEl = null;
  let acOwner = null;          // 候选下拉当前挂在哪个输入框上（代码框 or selector 框）
  let acBusy = false;          // execCommand 会同步再触发一次 input，用它挡住重入
  let lastRun = 0;             // 上一次 Shift+Enter 执行的时间，用于判断「连按两次」
  let macroNames = [];         // 扩展下发的宏名（内置宏 + 扫描到的原版宏），供代码框补全

  function log(...args) {
    console.log('[ATool-Push]', ...args);
  }

  function connectedCount() {
    let n = 0;
    for (const ws of conns.values()) if (ws.readyState === 1) n++;
    return n;
  }

  // ---------------- WebSocket ----------------

  // 上次成功连过的端口：推送后游戏重载，先按这些端口静默重连，不再盲扫整段（否则每次重载都刷一屏报错）
  function knownPorts() {
    try {
      const a = JSON.parse(localStorage.getItem(KNOWN_KEY) || '[]');
      return Array.isArray(a) ? a.filter((p) => Number.isInteger(p) && p >= PORT_MIN && p <= PORT_MAX) : [];
    } catch (_) { return []; }
  }
  function rememberPort(port) {
    try {
      const a = knownPorts();
      if (!a.includes(port)) { a.push(port); localStorage.setItem(KNOWN_KEY, JSON.stringify(a)); }
    } catch (_) {}
  }

  function connectPort(port) {
    if (conns.has(port)) return null;

    let ws;
    try {
      ws = new WebSocket(`ws://127.0.0.1:${port}`);
    } catch (e) {
      return null;
    }

    conns.set(port, ws);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => { log('已连接 VSCode 扩展 :' + port); rememberPort(port); setStatus(); };
    ws.onclose = () => {
      conns.delete(port);
      setStatus();
      // 刻意不自动重连：连接被拒时浏览器必定打印 "WebSocket connection to ... failed"，JS 拦不掉，
      // 周期重连会一直刷控制台。新窗口靠「页面加载」或面板「重扫」来发现。
    };
    ws.onerror = () => { /* onclose 会处理 */ };

    ws.onmessage = (event) => onMessage(ws, event);
    return ws;
  }

  // 从 38471 起顺序探测，一旦某个端口连不上就立即收手。
  // 依据：扩展端每个窗口都是「取第一个空闲端口」，所以有窗口的端口一定是 38471 开始的连续前缀，
  // 不存在「38471 空着而 38472 有窗口」的情况 —— 因此只需 1 次失败的探测就能确认后面没有窗口了，
  // 控制台最多留 1 条 ERR_CONNECTION_REFUSED，而不是整段扫下来 9 条。
  function scanAll() {
    if (scanning) return;
    scanning = true;

    let p = PORT_MIN;
    const step = () => {
      while (p <= PORT_MAX && conns.has(p)) p++;      // 已连上的跳过
      if (p > PORT_MAX) { scanning = false; return; }

      const port = p++;
      const ws = connectPort(port);
      if (!ws) { setTimeout(step, 0); return; }

      let settled = false;
      const finish = (alive) => {
        if (settled) return;
        settled = true;
        if (alive) setTimeout(step, 0);
        else { scanning = false; log(`端口 ${port} 没有窗口，停止扫描`); }
      };
      ws.addEventListener('open', () => finish(true));
      ws.addEventListener('close', () => finish(false));
    };

    step();
  }

  // 包头 / 分片状态挂在各自 socket 上，避免多端口之间串味
  function onMessage(ws, event) {
    if (typeof event.data === 'string') {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'mod-update') {
          ws._hdr = msg;
          ws._chunks = [];
          log('收到包头:', msg.name, msg.version, msg.size, '字节');
        } else if (msg.type === 'atools-index') {
          macroNames = Array.isArray(msg.macros) ? msg.macros : [];
          log('补全名单已更新：宏 ' + macroNames.length + ' 个');
        }
      } catch (e) {
        log('包头解析失败:', e.message);
      }
      return;
    }

    if (!ws._hdr) return;

    ws._chunks.push(event.data);
    const received = ws._chunks.reduce((n, c) => n + c.byteLength, 0);

    if (received >= ws._hdr.size) {
      const header = ws._hdr;
      const chunks = ws._chunks;
      ws._hdr = null;
      ws._chunks = [];
      handleZip(header, chunks);
    }
  }

  async function handleZip(header, chunks) {
    log('包接收完成，准备安装:', header.name);

    try {
      const blob = new Blob(chunks, { type: 'application/zip' });
      const fileName = `${header.name}-v${header.version}.mod.zip`;

      const installed = await installZip(blob, fileName);

      log('安装成功:', installed.modName, '，准备重载游戏');
      window.modHubShowToast?.('ATool 推送安装完成，正在重载游戏…', 'success');
      setTimeout(() => location.reload(), 800);
    } catch (e) {
      log('处理包失败:', e.message);
      window.modHubShowToast?.('ATool 推送安装失败: ' + e.message, 'error');
    }
  }

  /**
   * 把 zip 交给 ModLoader 落盘。
   * 优先用 ModHub 的封装接口（含启用列表校验）；否则回退 ModLoader 原生控制器。
   */
  async function installZip(blob, fileName) {
    // 方案 A：ModHub 封装接口
    if (typeof window.modHubInstallModZip === 'function') {
      return await window.modHubInstallModZip(blob, fileName);
    }

    // 方案 B：ModLoader 原生 ModLoadController（游戏自带，必然存在）
    const controller = window.modSC2DataManager?.getModLoadController?.();
    if (!controller || typeof controller.addModIndexDB !== 'function') {
      throw new Error('未找到 ModLoader 存储接口 modSC2DataManager.getModLoadController()');
    }

    const u8 = new Uint8Array(await blob.arrayBuffer());

    // 校验并读取 boot.json：失败时返回字符串（或抛错），此时绝不能落盘
    let bootJson = null;
    if (typeof controller.checkModZipFileIndexDB === 'function') {
      bootJson = await controller.checkModZipFileIndexDB(u8);
      if (bootJson && (typeof bootJson !== 'object' || Array.isArray(bootJson))) {
        throw new Error('安装包校验失败: ' + String(bootJson));
      }
    }

    const modName = String(bootJson?.name || fileName.replace(/\.mod\.zip$/i, '')).trim();
    if (!modName) throw new Error('无法从安装包中解析模组名称');

    await controller.addModIndexDB(modName, u8);

    // 保证不在禁用列表，否则重载后不会加载
    try {
      const hidden = await controller.loadHiddenModList() || [];
      const key = modName.toLowerCase();
      if (hidden.some(n => String(n).trim().toLowerCase() === key)) {
        await controller.overwriteModIndexDBHiddenModList(
          hidden.filter(n => String(n).trim().toLowerCase() !== key)
        );
      }
    } catch (_) { /* 旧加载器无此接口时忽略 */ }

    return { modName, bootJson };
  }

  // ---------------- 悬浮调试面板 ----------------

  // 定位用「锚点 + 像素偏移」而不是绝对坐标：窗口大小一变，绝对坐标可能把面板留在屏幕外
  const ANCHORS = ['tl', 'tc', 'tr', 'ml', 'mr', 'bl', 'bc', 'br'];   // 上/中/下 × 左/中/右，去掉正中
  let pos = { a: 'tr', dx: 12, dy: 12 };   // a 首字母是纵向（t/m/b），第二个是横向（l/c/r）

  function setStatus() {
    if (!dotEl) return;
    const n = connectedCount();
    dotEl.style.background = n ? '#3fb950' : '#888';
    textEl.textContent = (n ? '已连接'+(n > 1 ? ` (${n}个编辑器)` : '') : '未连接') + '  | ATools4DoL';
  }

  // 按当前像素坐标摆放；拖出视口就拉回来
  function place(left, top) {
    const w = panel.offsetWidth, h = panel.offsetHeight;
    left = Math.min(Math.max(0, left), Math.max(0, window.innerWidth - w));
    top = Math.min(Math.max(0, top), Math.max(0, window.innerHeight - h));
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
    panel.style.right = 'auto';
  }

  // 按锚点算现在该落在哪：贴边的保持边距，居中的跟着窗口中线走，所以改窗口大小不会丢面板
  function applyAnchor() {
    if (!panel) return;
    const w = panel.offsetWidth, h = panel.offsetHeight;
    const W = window.innerWidth, H = window.innerHeight;
    const v = pos.a[0], hz = pos.a[1];
    const left = hz === 'l' ? pos.dx : hz === 'r' ? W - pos.dx - w : W / 2 + pos.dx - w / 2;
    const top = v === 't' ? pos.dy : v === 'b' ? H - pos.dy - h : H / 2 + pos.dy - h / 2;
    place(left, top);
  }

  // 拖动松手后：在 8 个锚点里挑离面板当前位置最近的那个，换算成「锚点 + 偏移」存下来
  function snapAnchor() {
    const r = panel.getBoundingClientRect();
    const W = window.innerWidth, H = window.innerHeight;
    let best = null;
    for (const a of ANCHORS) {
      // 面板上与锚点对应的那个把手点（左上角 / 上边中点 / 右边中点 …）
      const px = a[1] === 'l' ? r.left : a[1] === 'r' ? r.right : r.left + r.width / 2;
      const py = a[0] === 't' ? r.top : a[0] === 'b' ? r.bottom : r.top + r.height / 2;
      const dx = a[1] === 'l' ? px : a[1] === 'r' ? W - px : px - W / 2;
      const dy = a[0] === 't' ? py : a[0] === 'b' ? H - py : py - H / 2;
      const d = Math.hypot(dx, dy);          // 该把手点到对应锚点的距离
      if (!best || d < best.d) best = { a, dx, dy, d };
    }
    pos = { a: best.a, dx: Math.round(best.dx), dy: Math.round(best.dy) };
    try { localStorage.setItem(POS_KEY, JSON.stringify(pos)); } catch (_) {}
    applyAnchor();
  }

  function restorePos() {
    try {
      const p = JSON.parse(localStorage.getItem(POS_KEY) || 'null');
      if (!p) return;
      if (ANCHORS.includes(p.a)) { pos = { a: p.a, dx: p.dx || 0, dy: p.dy || 0 }; applyAnchor(); }
      // 旧版本存的是绝对坐标：先按原样摆好，再吸附成锚点
      else if (Number.isFinite(p.left) && Number.isFinite(p.top)) { place(p.left, p.top); snapAnchor(); }
    } catch (_) {}
  }

  // 面板头：按住拖动；没拖动（原地松手）则折叠 / 展开
  function makeHeadInteractive(head) {
    head.style.touchAction = 'none';   // 触屏拖动时不要顺带滚动页面
    let dx = 0, dy = 0, sx = 0, sy = 0, dragging = false, moved = false;

    head.addEventListener('pointerdown', (e) => {
      const r = panel.getBoundingClientRect();
      dx = e.clientX - r.left;
      dy = e.clientY - r.top;
      sx = e.clientX;
      sy = e.clientY;
      dragging = true;
      moved = false;
      try { head.setPointerCapture(e.pointerId); } catch (_) {}
      e.preventDefault();
    });

    head.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      if (!moved && Math.abs(e.clientX - sx) + Math.abs(e.clientY - sy) < 4) return;
      moved = true;
      place(e.clientX - dx, e.clientY - dy);
    });

    const end = (e) => {
      if (!dragging) return;
      dragging = false;
      try { head.releasePointerCapture(e.pointerId); } catch (_) {}

      if (!moved) {
        panel.classList.toggle('at-collapsed');   // 箭头靠 CSS 旋转过渡，不再换字符
        hideAc();                                 // 收起时 textarea 不会失焦，得手动收掉候选下拉
        return;
      }
      snapAnchor();   // 松手后吸附到最近的锚点并记住
    };
    head.addEventListener('pointerup', end);
    head.addEventListener('pointercancel', end);
  }

  function createPanel() {
    if (panel) return;

    const style = document.createElement('style');
    style.textContent =
      '#atools4dol-panel{position:fixed;top:12px;right:12px;z-index:2147483647;width:340px;max-width:calc(100vw - 24px);' +
        'font:12px/1.4 "Microsoft YaHei",system-ui,sans-serif;color:#e8e8e8;' +
        'background:rgba(20,20,24,.92);border:1px solid #444;border-radius:6px;' +
        'box-shadow:0 4px 16px rgba(0,0,0,.5);text-align:left}' +   // 不用 overflow:hidden，否则候选下拉出不了面板
      '#atools4dol-panel .at-head{display:flex;align-items:center;gap:6px;padding:6px 8px;border-radius:5px 5px 0 0;' +
        'background:rgba(255,255,255,.06);cursor:move;user-select:none}' +
      '#atools4dol-panel .at-dot{width:9px;height:9px;border-radius:50%;background:#888;flex:none}' +
      '#atools4dol-panel .at-text{flex:1}' +
      '#atools4dol-panel .at-fold{opacity:.7;transition:transform .22s ease; scale: 2;}' +
      // 折叠动画：外层的 grid-template-rows 从 1fr 收到 0fr，高度随内容自适应，不需要写死最大高度
      '#atools4dol-panel .at-anim{display:grid;grid-template-rows:1fr;overflow:hidden;transition:grid-template-rows .25s ease}' +
      '#atools4dol-panel .at-body{min-height:0;padding:8px;display:flex;flex-direction:column;gap:6px;transition:opacity .25s ease}' +
      '#atools4dol-panel .at-body>*{min-width:0;max-width:100%}' +
      '#atools4dol-panel.at-collapsed .at-anim{grid-template-rows:0fr}' +
      '#atools4dol-panel.at-collapsed .at-body{opacity:0}' +
      '#atools4dol-panel.at-collapsed .at-fold{transform:rotate(-90deg)}' +
      // 面板宽 340px，但游戏自带的全局 CSS 会把输入框撑出面板：这里用 !important 压住
      '#atools4dol-panel input,#atools4dol-panel textarea{display:block;width:100%!important;max-width:100%!important;' +
        'min-width:0!important;box-sizing:border-box!important;background:#111;color:#e8e8e8;border:1px solid #444;' +
        'border-radius:4px;padding:4px 6px;font:inherit}' +
      '#atools4dol-panel textarea{height:64px;resize:vertical}' +
      '#atools4dol-panel .at-row{display:flex;align-items:center;gap:6px}' +
      '#atools4dol-panel .at-row .at-sel{flex:1}' +
      '#atools4dol-panel .at-row button{background:#2d5a3d;color:#e8e8e8;border:1px solid #3fb950;' +
        'border-radius:4px;padding:4px 10px;font:inherit;cursor:pointer;flex:none;white-space:nowrap}' +
      '#atools4dol-panel .at-row button{padding:4px 7px}' +
      '#atools4dol-panel .at-row button:hover{background:#356b48}' +
      '#atools4dol-panel .at-row button.at-refresh{background:#333;border-color:#555}' +
      '#atools4dol-panel .at-row button.at-refresh:hover{background:#444}' +
      '#atools4dol-panel .at-out{min-height:18px;max-height:160px;overflow:auto;padding:4px 6px;' +
        'background:rgba(0,0,0,.35);border:1px solid #3a3a3a;border-radius:4px;word-break:break-word}' +
      // ---- 代码框：透明 textarea 叠在 <pre> 上做高亮。两层字体/内边距/边框/换行规则必须完全一致 ----
      '#atools4dol-panel .at-code{position:relative}' +
      '#atools4dol-panel .at-code>pre,#atools4dol-panel .at-code>textarea{display:block;width:100%!important;max-width:100%!important;' +
        'min-width:0!important;box-sizing:border-box!important;margin:0;padding:4px 6px;border:1px solid #444;border-radius:4px;' +
        'font:13px/1.5 Consolas,Menlo,monospace;white-space:pre-wrap;overflow-wrap:break-word}' +
      '#atools4dol-panel .at-code>pre{position:absolute;left:0;top:0;right:0;bottom:0;overflow:hidden;pointer-events:none;' +
        'background:#111;color:#e8e8e8}' +
      '#atools4dol-panel .at-code>textarea{position:relative;z-index:1;height:64px;resize:vertical;background:transparent;' +
        'color:transparent;caret-color:#e8e8e8}' +
      '#atools4dol-panel .at-code>textarea::placeholder{color:#777}' +
      '#atools4dol-panel .at-c{color:#6a9955}' +
      '#atools4dol-panel .at-m{color:#c586c0}' +
      '#atools4dol-panel .at-l{color:#4fa3d1}' +
      '#atools4dol-panel .at-s{color:#ce9178}' +
      '#atools4dol-panel .at-v{color:#9cdcfe}' +
      '#atools4dol-panel .at-p{color:#dcdcaa}' +
      // 候选下拉：用 fixed 定位（位置由 JS 按代码框算），这样不会被折叠动画的 overflow:hidden 裁掉
      '#atools4dol-panel .at-ac{position:fixed;z-index:2147483647;max-height:132px;overflow:auto;display:none;' +
        'background:#181818;border:1px solid #444;border-radius:4px;box-shadow:0 4px 12px rgba(0,0,0,.5)}' +
      '#atools4dol-panel .at-ac.on{display:block}' +
      '#atools4dol-panel .at-ac>div{padding:2px 6px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
      '#atools4dol-panel .at-ac>div.on{background:#2d5a3d}' +
      '#atools4dol-panel .at-log{font-size:11px;color:#8b949e;margin-top:3px}';
    document.head.appendChild(style);

    panel = document.createElement('div');
    panel.id = 'atools4dol-panel';
    panel.innerHTML =
      '<div class="at-head"><span class="at-dot"></span><span class="at-text">未连接</span><span class="at-fold">▾</span></div>' +
      '<div class="at-anim"><div class="at-body">' +
        '<div class="at-row">' +
          '<input class="at-sel" placeholder="执行位置">' +
          '<button class="at-run">执行</button>' +
          '<button class="at-refresh" title="重新渲染当前 passage，让改动立即生效">刷新</button>' +
        '</div>' +
        '<div class="at-code">' +
          '<pre class="at-hl" aria-hidden="true"></pre>' +
          '<textarea class="at-src" spellcheck="false" placeholder="执行SugarCube段"></textarea>' +
          '<div class="at-ac"></div>' +
        '</div>' +
        '<div class="at-out"></div>' +
      '</div></div>';
    document.body.appendChild(panel);

    dotEl = panel.querySelector('.at-dot');
    textEl = panel.querySelector('.at-text');
    outEl = panel.querySelector('.at-out');
    srcEl = panel.querySelector('.at-src');
    selEl = panel.querySelector('.at-sel');
    hlEl = panel.querySelector('.at-hl');
    acEl = panel.querySelector('.at-ac');

    // execCommand 插入文本时会同步再触发一次 input，嵌套那层只同步高亮，别再弹候选
    srcEl.addEventListener('input', () => { syncHl(); if (acBusy) return; refreshAc(); });
    srcEl.addEventListener('scroll', syncHl);
    srcEl.addEventListener('blur', hideAc);
    srcEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); runHotkey(); return; }
      if (pairKey(e)) return;
      acNav(e);
    });
    selEl.addEventListener('input', () => { if (!acBusy) refreshSelAc(); });
    selEl.addEventListener('blur', hideAc);
    selEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); runHotkey(); return; }   // 单行输入框里回车没别的用途
      acNav(e);
    });
    acEl.addEventListener('mousedown', (e) => {
      const hit = e.target.closest('div');
      e.preventDefault();                 // 不 preventDefault 的话输入框会先失焦，下拉被关掉就选不中了
      if (hit) { acIdx = Array.prototype.indexOf.call(acEl.children, hit); acceptAc(); }
    });
    syncHl();

    makeHeadInteractive(panel.querySelector('.at-head'));
    panel.querySelector('.at-run').addEventListener('click', run);
    panel.querySelector('.at-refresh').addEventListener('click', refreshPassage);

    applyAnchor();   // 先摆到默认锚点（右上），有记忆位置再被 restorePos 覆盖
    restorePos();
    setStatus();
  }

  // ---------------- 代码框：twee 语法高亮 ----------------
  // textarea 本身没法着色，所以让它整块透明（只留光标），底下垫一层同步滚动的 <pre>。
  const HL = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|(<<\/?[\w-]+|<<|>>)|(\[\[[^\]]*\]\])|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(\$\w+)|(\bsetup\b)/g;

  function esc(s) {
    return s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
  }

  function syncHl() {
    const src = srcEl.value;
    let out = '', last = 0, m;
    HL.lastIndex = 0;
    while ((m = HL.exec(src))) {
      out += esc(src.slice(last, m.index));
      const k = m[1] ? 'c' : m[2] ? 'm' : m[3] ? 'l' : m[4] ? 's' : m[5] ? 'v' : 'p';
      out += '<span class="at-' + k + '">' + esc(m[0]) + '</span>';
      last = m.index + m[0].length;
    }
    hlEl.innerHTML = out + esc(src.slice(last)) + '\n';   // 末尾补换行，让 <pre> 的行高与 textarea 对齐
    hlEl.scrollTop = srcEl.scrollTop;
    hlEl.scrollLeft = srcEl.scrollLeft;
  }

  // ---------------- 代码框：候选补全 ----------------
  let acItems = [], acIdx = -1, acStart = 0, acEnd = 0;

  function hideAc() { acIdx = -1; acEl.classList.remove('on'); }

  // 下拉是 fixed 定位，得按它所属输入框在视口里的位置摆（面板本身也是 fixed，页面滚动不影响它）
  function placeAc() {
    const r = acOwner.getBoundingClientRect();
    acEl.style.left = r.left + 'px';
    acEl.style.top = (r.bottom + 2) + 'px';
    acEl.style.width = r.width + 'px';
  }

  // owner = 候选替换哪个输入框里的内容
  function showAc(owner, list, start, end) {
    acOwner = owner; acItems = list; acStart = start; acEnd = end;
    if (!list.length) { hideAc(); return; }
    acIdx = 0;
    acEl.innerHTML = list.map((w, i) => '<div' + (i ? '' : ' class="on"') + '>' + esc(w) + '</div>').join('');
    placeAc();
    acEl.classList.add('on');
  }

  function moveAc(d) {
    if (acIdx < 0) return;
    acIdx = (acIdx + d + acItems.length) % acItems.length;
    for (let i = 0; i < acEl.children.length; i++) acEl.children[i].className = i === acIdx ? 'on' : '';
    acEl.children[acIdx].scrollIntoView({ block: 'nearest' });
  }

  // 下拉打开时的方向键 / 回车 / Esc 导航；返回 true 表示这次按键已被吃掉
  function acNav(e) {
    if (!acEl.classList.contains('on')) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); moveAc(e.key === 'ArrowDown' ? 1 : -1); return true; }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); acceptAc(); return true; }
    if (e.key === 'Escape') { e.preventDefault(); hideAc(); return true; }
    return false;
  }

  function acceptAc() {
    const w = acItems[acIdx];
    if (!w) return;
    const box = acOwner;
    const pos = acStart + w.length;
    box.focus();
    box.setSelectionRange(acStart, acEnd);
    acBusy = true;                                         // 挡住 execCommand 触发的嵌套 input 再弹一次下拉
    document.execCommand('insertText', false, w);          // 走原生输入管线，Ctrl+Z 才能撤销这次补全
    acBusy = false;
    box.setSelectionRange(pos, pos);
    hideAc();
  }

  // 光标前那段 token 决定该出哪类候选
  function ctxOf() {
    const caret = srcEl.selectionStart;
    const before = srcEl.value.slice(0, caret);
    const set = (type, word, base) => ({ type, word, base, start: caret - word.length, end: caret });
    let m;
    if ((m = /<<\/?([\w-]*)$/.exec(before))) return set('macro', m[1]);
    // 成员访问：$player. / $player.clothes. / V.money / setup.clo / State.variables.x
    if ((m = /((?:\$?[A-Za-z_$][\w$]*)(?:\.[\w$]*)*)\.([\w$]*)$/.exec(before))) {
      // 根只认 $变量 / V / setup / State，别的一律当普通文本，不瞎猜
      if (/^(\$[\w$]+|V|setup|State)$/.test(m[1].split('.')[0])) return set('member', m[2], m[1]);
    }
    if ((m = /(?:^|[^\w$])\$(\w*)$/.exec(before))) return set('var', m[1]);
    return null;
  }

  // 把 $player.clothes 这类路径丢给运行时求值，像控制台一样即时拿到对象
  function resolveObj(path) {
    const seg = path.split('.');
    const head = seg.shift();
    let o;
    try {
      if (head[0] === '$') o = State.variables[head.slice(1)];
      else if (head === 'V') o = State.variables;
      else if (head === 'setup') o = setup;
      else if (head === 'State') o = State;
      else return null;
    } catch (_) { return null; }
    for (const s of seg) { if (o == null) return null; o = o[s]; }
    return o;
  }

  function candidates(ctx) {
    let all;
    if (ctx.type === 'macro') {
      all = macroNames;                                   // 来自扩展（内置宏 + 扫描到的原版宏）
    } else if (ctx.type === 'var') {
      try { all = Object.keys(State.variables); } catch (_) { all = []; }   // 存档变量：实时取，最准
    } else {
      const o = resolveObj(ctx.base);
      all = o && typeof o === 'object' ? Object.keys(o) : [];               // 对象成员：即时解析出键
    }
    const w = ctx.word.toLowerCase();
    const hit = all.filter((n) => n && (!w || n.toLowerCase().startsWith(w)));
    hit.sort();
    return hit.length > 60 ? hit.slice(0, 60) : hit;
  }

  function refreshAc() {
    const ctx = ctxOf();
    if (!ctx) { hideAc(); return; }
    showAc(srcEl, candidates(ctx), ctx.start, ctx.end);
  }

  // ---------------- selector 框：元素候选 ----------------
  // 输入 # 列 document 里所有 id，输入 . 列所有类名；候选带上前缀一起替换
  function selCtx() {
    const caret = selEl.selectionStart;
    const before = selEl.value.slice(0, caret);
    let m;
    if ((m = /#([\w-]*)$/.exec(before))) return { cls: false, word: m[1], start: caret - m[1].length - 1, end: caret };
    if ((m = /\.([\w-]*)$/.exec(before))) return { cls: true, word: m[1], start: caret - m[1].length - 1, end: caret };
    return null;
  }

  function refreshSelAc() {
    const ctx = selCtx();
    if (!ctx) { hideAc(); return; }
    const seen = new Set();
    for (const el of document.querySelectorAll(ctx.cls ? '[class]' : '[id]')) {
      if (ctx.cls) { for (const c of el.classList) seen.add(c); }
      else if (el.id) seen.add(el.id);
    }
    const w = ctx.word.toLowerCase();
    const hit = [...seen].filter((n) => !w || n.toLowerCase().startsWith(w)).sort();
    showAc(selEl, hit.slice(0, 60).map((n) => (ctx.cls ? '.' : '#') + n), ctx.start, ctx.end);
  }

  // 尖括号配对：输入 < 且右侧是 >、空格或文末时补一个 > 并把光标放中间（否则按普通 < 插入）；
  // 光标在 <|> 时按 Backspace 两个一起删。
  // 全程走 execCommand，Ctrl+Z 仍能一步撤销。e.ctrlKey / metaKey 不拦截（保留撤销重做等组合键）。
  function pairKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    const pos = srcEl.selectionStart;
    if (pos !== srcEl.selectionEnd) return false;

    if (e.key === '<') {
      // 只在光标右侧是 >、空格或空（文末）时才补 >，否则按普通 < 插入
      const next = srcEl.value[pos];
      if (next !== undefined && next !== '>' && next !== ' ') return false;
      e.preventDefault();
      acBusy = true;
      document.execCommand('insertText', false, '<>');
      acBusy = false;
      srcEl.setSelectionRange(pos + 1, pos + 1);         // 光标落在 < 和 > 中间
      refreshAc();                                       // 与直接敲一手 < 的下拉行为保持一致
      return true;
    }
    if (e.key === 'Backspace' && srcEl.value[pos - 1] === '<' && srcEl.value[pos] === '>') {
      e.preventDefault();
      acBusy = true;
      srcEl.setSelectionRange(pos - 1, pos + 1);
      document.execCommand('delete');                    // 一并删掉左右尖括号
      acBusy = false;
      srcEl.setSelectionRange(pos - 1, pos - 1);
      refreshAc();
      return true;
    }
    return false;
  }

  // Shift+Enter / selector 回车：执行一次；短时间内连按两次则再刷新一遍当前 passage
  function runHotkey() {
    const now = Date.now();
    // 第二次按：只刷新，不再执行一遍命令
    if (now - lastRun < 400) { lastRun = 0; refreshPassage(); return; }
    lastRun = now;
    run();
  }

  function run() {
    const src = srcEl.value;
    const selText = selEl.value.trim();
    const dest = selText ? document.querySelector(selText) : outEl;
    if (!dest) { outEl.textContent = '选择器未匹配到元素: ' + selText; return; }

    outEl.innerHTML = '';      // 输出区当「本次执行结果」用，执行前清空避免和上次堆在一起
    hideAc();
    const t0 = performance.now();
    new Wikifier(dest, src);
    const ms = performance.now() - t0;

    const line = document.createElement('div');
    line.className = 'at-log';
    line.textContent = `${new Date().toLocaleTimeString()} Wikifier, spent ${ms.toFixed(1)}ms${(selText ? ', selector: ' + selText : '')}`;
    outEl.appendChild(line);
  }

  // 重新渲染当前 passage：面板里改的变量 / 样式不刷新这一屏是看不出来的
  function refreshPassage() {
    try {
      const E = typeof Engine !== 'undefined' ? Engine : window.SugarCube?.Engine;
      const title = typeof passage === 'function' ? passage() : window.SugarCube?.State?.passage;
      if (!E || !title) throw new Error('Engine / passage 不可用');
      // history:'replace' 表示刷新不往历史栈里压新的一步；老版本不认这个选项时会退化成普通重播
      E.play(title, { history: 'replace' });
    } catch (e) {
      outEl.textContent = '刷新失败: ' + e.message;
    }
  }

  // 等游戏框架就绪后再建面板并连端口（此时 document.body 与 SugarCube 的 Wikifier 都已存在）
  function boot() {
    createPanel();
    const known = knownPorts();
    if (known.length) known.forEach(connectPort);   // 上次连过的窗口：静默重连
    else scanAll();                                  // 首次加载：扫一遍端口段

    // 从失焦回到获焦（切走再切回来）时补扫一次：可能新开了 VSCode 窗口，而它不会主动通知我们。
    // 用 blurred 标记，避免首次加载时 focus 又被算一次、重复扫出多余的连接报错。
    let blurred = false;
    window.addEventListener('blur', () => { blurred = true; });
    window.addEventListener('focus', () => { if (blurred) { blurred = false; scanAll(); } });
    // 改窗口大小时按锚点重摆，避免面板被留在屏幕外；顺带收掉会错位的候选下拉
    window.addEventListener('resize', () => { hideAc(); applyAnchor(); });
  }

  if (document.readyState === 'complete') boot();
  else window.addEventListener('load', boot, { once: true });
})();