// ATool 游戏源码工具集：源码切分 / 索引 / 补全 / 跳转定义 / 汉化反查 / 锚点生成
// 纯逻辑（切分、索引、锚点、i18n 检索）不依赖 vscode，可用 node 直接验证。
const fs = require('fs');
const path = require('path');
const readline = require('readline');

let vscode = null;
try { vscode = require('vscode'); } catch (_) { /* node 测试环境 */ }

const SCHEME = 'atools-src';

// ==================== 纯逻辑 ====================

function decodeEnt(s) {
  return String(s || '')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

// 部分版本的编译源码会把 passage 正文里的 < > & " ' 写成 HTML 实体（&lt; 等）。
// 游戏运行时拿到的是浏览器解码后的文本，所以这里做一次防御式解码（有则解、无则不动）；
// <script> 是 CDATA，浏览器不解码，故保持原样。
function decodeSource(html) {
  return html.replace(/(<tw-passagedata\b[^>]*>)([\s\S]*?)(<\/tw-passagedata>)/g,
    (m, open, body, close) => open + decodeEnt(body) + close);
}

function normPath(raw) {
  return String(raw || '').replace(/\\\\/g, '/').replace(/\\/g, '/');
}

// 取 offset 所在行的原文（用于候选详情展示初始化/赋值代码）
function srcLine(html, pos) {
  let s = pos; while (s > 0 && html[s - 1] !== '\n') s--;
  let e = pos; while (e < html.length && html[e] !== '\n') e++;
  return html.slice(s, e).trim().slice(0, 200);
}

// 取 offset 附近若干行做悬停预览：定义行前 before 行 + 定义行 + 定义行后 after 行
// atChar=true 时从 offset 处（而非所在行行首）开始，用于定义紧跟 <tw-passagedata …> 标签的场景
function sliceAround(text, offset, before, after, atChar) {
  if (!text || typeof offset !== 'number' || offset < 0) return '';
  let s = offset;
  if (!atChar) while (s > 0 && text[s - 1] !== '\n') s--;
  for (let i = 0; i < before && s > 0; i++) { s--; while (s > 0 && text[s - 1] !== '\n') s--; }
  let e = offset, n = 0;
  while (e < text.length) { if (text[e] === '\n') { if (n >= after) break; n++; } e++; }
  return text.slice(s, e).replace(/[ \t]+$/gm, '').slice(0, 1200);
}

// 悬停预览按 mtime 缓存工作区文件内容，避免鼠标移动时反复读盘
const previewCache = new Map();
function readText(fsPath) {
  try {
    const mt = fs.statSync(fsPath).mtimeMs;
    const c = previewCache.get(fsPath);
    if (c && c.mt === mt) return c.text;
    const text = fs.readFileSync(fsPath, 'utf8');
    if (previewCache.size > 40) previewCache.delete(previewCache.keys().next().value);
    previewCache.set(fsPath, { mt, text });
    return text;
  } catch (_) { return ''; }
}

// SugarCube 链接取段落名：[[显示文本|段落名]] / [[段落名<-显示]] / [[显示->段落名]] / [[段落名]] / [[显示][Setter]]
// 显示文本里可能自带 | 或 ->，故 | 和 -> 取最后一个
function linkTarget(inner) {
  let name = inner;
  if (inner.includes('->')) name = inner.slice(inner.lastIndexOf('->') + 2);
  else if (inner.includes('<-')) name = inner.slice(0, inner.indexOf('<-'));
  else if (inner.includes('|')) name = inner.slice(inner.lastIndexOf('|') + 1);
  return name.split('][')[0].trim();
}

// 注释、字符串、<<script>> 段里的 << >> [[ ]] 不参与识别（抹成等长空格，保证下标不变）
function maskTwee(text) {
  return text
    .replace(/<<\s*script\b[^>]*>>[\s\S]*?<<\/\s*script\s*>>/gi, (s) => s.replace(/[^\n]/g, ' '))
    .replace(/<!--[\s\S]*?-->/g, (s) => s.replace(/[^\n]/g, ' '))
    .replace(/"[^"\n]*"/g, (s) => ' '.repeat(s.length))
    // 单引号字符串（如 <<run>> 里的 JS）：仅当引号前不是字母/数字/下划线时才算字符串，
    // 否则正文里的撇号（Don't、It's）会被当成字符串起点，把真正的宏屏蔽掉
    .replace(/(^|[^\w])'([^'\\\n]|\\.)*'/g, (s, pre) => pre + ' '.repeat(s.length - pre.length));
}

// JS 源码里的注释 / 字符串。等长替换成空格后再跑定义正则，
// 否则注释里的「... to function and store ...」会被当成函数声明索引出一个 funcDef['and']，
// 跳转/悬浮卡片就会指到注释里。等长 + 保留换行，所以偏移不变，srcLine 仍指向正确位置。
const JS_LEX = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;
const blank = (s) => s.replace(/[^\n]/g, ' ');
// 只屏蔽注释：宏名写在字符串里（Macro.add("x")），连字符串一起屏蔽就读不到名字了
const maskJsComment = (t) => t.replace(JS_LEX, (s) => (s[0] === '/' ? blank(s) : s));
// 注释和字符串一起屏蔽：函数 / setup 的判定不能再被字符串里的文字骗到
const maskJsCode = (t) => t.replace(JS_LEX, blank);
// JS 关键字不是函数名，但 `if (x) {` 这类行会被「方法简写」那条规则当成函数声明
const JS_KEYWORD = new Set('if else for while do switch case default try catch finally return throw new delete typeof instanceof in of void yield await class extends super this function var let const debugger'.split(' '));

// setup 补全/跳转上下文：line 为光标前的文本
// setup.clothes.  → base='clothes'   ; setup.clothes.up → base='clothes', path='clothes.up'
function setupCtx(line) {
  const re = /setup((?:\.[A-Za-z_$][\w$]*)*)\.([A-Za-z_$][\w$]*|$)/g;
  let m, last = null;
  while ((m = re.exec(line))) { last = m; re.lastIndex = m.index + m[0].length; }
  if (!last) return null;
  const base = last[1].slice(1);
  const tail = last[2];
  return { base, path: tail ? (base ? base + '.' + tail : tail) : null };
}

// 用翻译条目把源码中的英文原文替换为中文
function applyTx(body, pairs) {
  if (!pairs) return body;
  let out = body;
  for (const [f, t] of pairs) if (f && t) out = out.split(f).join(t);
  return out;
}

// JS 原始文件：以 /* twine-user-script #N: "path" */ 标记分隔，标记之间为可读源码
function splitJsFiles(html) {
  const reM = /\/\* twine-user-script #(\d+): "([^"]*)" \*\//g;
  const marks = [];
  let m;
  while ((m = reM.exec(html))) marks.push({ idx: m.index, end: reM.lastIndex, raw: m[2] });
  // 最后一个脚本块到 </script> 为止，否则会把它后面的所有 passage 吞进最后一个 js 文件
  let stop = html.length;
  if (marks.length) {
    const q = html.slice(marks[marks.length - 1].end).search(/<\/script\s*>/i);
    if (q !== -1) stop = marks[marks.length - 1].end + q;
  }
  const files = [];
  for (let i = 0; i < marks.length; i++) {
    const p = normPath(marks[i].raw);
    files.push({
      path: p,
      base: path.posix.basename(p),
      start: marks[i].end,
      end: i + 1 < marks.length ? marks[i + 1].idx : stop,
    });
  }
  return files;
}

function buildIndex(html, meta) {
  const passages = [];
  const reP = /<tw-passagedata\b([^>]*)>([\s\S]*?)<\/tw-passagedata>/gd;
  let m;
  while ((m = reP.exec(html))) {
    const attrs = m[1];
    const g = (n) => { const r = new RegExp(n + '="([^"]*)"').exec(attrs); return r ? r[1] : ''; };
    passages.push({
      name: decodeEnt(g('name')), tags: decodeEnt(g('tags')),
      bodyStart: m.indices[2][0], bodyEnd: m.indices[2][1],
    });
  }
  const jsFiles = splitJsFiles(html);

  const macroDef = {};
  const macroNames = new Set();
  const addMacros = [];
  const varCount = new Map();
  const funcDef = {};
  // setup 全层级：setup.clothes.upper 这类任意深度的赋值路径
  const setupAssign = {};
  const setupTree = { '': new Set() };
  const addSetup = (full, pos, file) => {
    let cur = '';
    for (const s of full.split('.')) {
      (setupTree[cur] || (setupTree[cur] = new Set())).add(s);
      cur = cur ? cur + '.' + s : s;
    }
    // 同一路径多次赋值时保留最后一次（文档顺序：passage 在前，js 在后）
    setupAssign[full] = { file, offset: pos, src: srcLine(html, pos) };
  };
  const reSetup = /setup\.((?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$][\w$]*)\s*=/g;

  // 1) passage 正文：widget 宏定义 + $存档变量 + setup 赋值
  for (const p of passages) {
    const body = html.slice(p.bodyStart, p.bodyEnd);
    let w; const rw = /<<widget\s+["']([^"']+)["']/g;
    while ((w = rw.exec(body))) {
      macroNames.add(w[1]);
      if (!macroDef[w[1]]) {
        const off = p.bodyStart + w.index;
        macroDef[w[1]] = { type: 'passage', key: p.name, offset: off, src: srcLine(html, off) };
      }
    }
    let v; const rv = /\$([A-Za-z_]\w*)/g;
    while ((v = rv.exec(body))) varCount.set(v[1], (varCount.get(v[1]) || 0) + 1);
    let sd;
    reSetup.lastIndex = 0;
    while ((sd = reSetup.exec(body))) addSetup(sd[1], p.bodyStart + sd.index, p.name);
  }

  // 2) JS 文件：Macro.add / DefineMacro / statDisplay.create / setup.x = / function
  for (const f of jsFiles) {
    const body = html.slice(f.start, f.end);
    // 注释里的文字一律不算定义；函数 / setup 连字符串里的文字也不算
    const noCmt = maskJsComment(body), code = maskJsCode(body);
    let a; const ra = /(?:Macro\.add|DefineMacroS?|statDisplay\.create)\(\s*(\[[^\]]*\]|"[^"]*"|'[^']*')/g;
    while ((a = ra.exec(noCmt))) {
      const list = a[1].startsWith('[') ? a[1].slice(1, -1).split(',') : [a[1]];
      for (const x of list) {
        const name = x.trim().replace(/^["']|["']$/g, '');
        if (!name) continue;
        addMacros.push(name);
        if (!macroDef[name]) {
          const off = f.start + a.index;
          macroDef[name] = { type: 'js', key: f.base, offset: off, src: srcLine(html, off) };
        }
      }
    }
    let sd; reSetup.lastIndex = 0;
    while ((sd = reSetup.exec(code))) addSetup(sd[1], f.start + sd.index, f.base);
    // <<run Obj.fn()>> 要能定位：function 声明、xxx: function、xxx() { 方法简写、Obj = { 命名空间
    let fn; const rf = /(?:function\s+([A-Za-z_$][\w$]*)|([A-Za-z_$][\w$]*)\s*[:=]\s*(?:function\b|\([^)]*\)\s*=>)|^[ \t]*(?!function\b)([A-Za-z_$][\w$]*)\s*\([^;{}]*\)\s*\{|^[ \t]*(?:window\.)?([A-Za-z_$][\w$]*)\s*=\s*(?:\{|Object\.assign))/gm;
    while ((fn = rf.exec(code))) {
      const nm = fn[1] || fn[2] || fn[3] || fn[4];
      if (!nm || funcDef[nm] || JS_KEYWORD.has(nm)) continue;
      const off = f.start + fn.index;
      funcDef[nm] = { file: f.base, offset: off, src: srcLine(html, off) };
    }
  }

  const tree = {};
  for (const k of Object.keys(setupTree)) tree[k] = [...setupTree[k]].sort();

  return Object.assign({
    schema: 7,
    generatedAt: new Date().toISOString(),
    macros: [...macroNames].sort(),
    addMacros: [...new Set(addMacros)].filter((n) => !macroNames.has(n)).sort(),
    variables: [...varCount.entries()].filter(([n, c]) => c >= 2 && !n.startsWith('_')).map(([n]) => n).sort(),
    macroDef, setupAssign, setupTree: tree, funcDef,
    passages: passages.map((p) => ({ name: p.name, tags: p.tags, bodyStart: p.bodyStart, bodyEnd: p.bodyEnd })),
    jsFiles: jsFiles.map((f) => ({ path: f.path, base: f.base, start: f.start, end: f.end })),
  }, meta || {});
}

// 锚点优先落在「不会被翻译覆盖」的位置，但也不宜为躲翻译把锚点撑得过大：超过这个长度就用最短唯一锚点
const SAFE_ANCHOR_CAP = 400;

// 参数是「名字/标识符」的宏：段落名、widget 名、音频 id 等，翻译文件不会覆盖它们，
// 所以整条宏都算安全区（不把里面的引号串标为不安全），否则 <<widget "gdrugged">> 这类锚点会被误判成
// 「会被翻译覆盖的文本」而无法生成。其余宏（如 <<link "显示文本" ...>>）的引号串仍按会被翻译处理。
const NAME_ARG_MACRO = new Set('widget include display goto audio cacheaudio masteraudio playlist createaudiogroup createplaylist removeaudiogroup removeplaylist'.split(' '));

// 标记 [from,to) 区间内的引号字符串（' " `）位置（twee 宏参数用）
function markQuoted(s, from, to, mark) {
  let i = from;
  while (i < to) {
    const c = s[i];
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < to && s[j] !== c) { if (s[j] === '\\') j++; j++; }
      mark(i, Math.min(j + 1, to));
      i = j + 1;
    } else i++;
  }
}

// JS 源码：只把字符串字面量标为不安全（注释、标识符、关键字视为安全）
function markJsStrings(s, mark) {
  const n = s.length;
  let i = 0;
  while (i < n) {
    const c = s[i];
    if (c === '/' && s[i + 1] === '/') { const e = s.indexOf('\n', i); i = e === -1 ? n : e; continue; }
    if (c === '/' && s[i + 1] === '*') { const e = s.indexOf('*/', i + 2); i = e === -1 ? n : e + 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n && s[j] !== c) { if (s[j] === '\\') j++; j++; }
      mark(i, Math.min(j + 1, n));
      i = j + 1;
      continue;
    }
    i++;
  }
}

// 计算「会被翻译覆盖」的位置掩码（1=不安全）：裸文本、字符串字面量，以及 i18n 里出现的英文原文。
// 锚点尽量避开这些位置，优先落在宏、HTML tag、标识符、注释上，这样汉化替换后锚点依然能命中。
// pairs 为该 passage / 文件的 i18n 英文条目（可空），为空时只用语法启发式。
function unsafeMask(content, kind, pairs) {
  const n = content.length;
  const m = new Uint8Array(n);
  const mark = (a, b) => { for (let i = Math.max(0, a); i < Math.min(n, b); i++) m[i] = 1; };
  if (kind === 'passage') {
    let i = 0;
    while (i < n) {
      if (content.startsWith('/*', i)) {              // twee 注释 → 安全
        const e = content.indexOf('*/', i + 2);
        i = e === -1 ? n : e + 2;
        continue;
      }
      if (content[i] !== '<') {                       // 裸文本（宏 / tag / 注释之外）：只有非空白算不安全（换行、空格不会被翻译覆盖）
        let j = i;
        while (j < n && content[j] !== '<' && !content.startsWith('/*', j)) {
          const c = content[j];
          if (c !== ' ' && c !== '\t' && c !== '\n' && c !== '\r') m[j] = 1;
          j++;
        }
        i = j;
        continue;
      }
      if (content.startsWith('<!--', i)) { const e = content.indexOf('-->', i + 4); i = e === -1 ? n : e + 3; continue; }
      if (content.startsWith('<<', i)) {              // 宏 → 安全，只把宏里的引号字符串标为不安全
        const e = content.indexOf('>>', i + 2);
        const end = e === -1 ? n : e + 2;
        const mn = (content.slice(i + 2, end).match(/^\s*([A-Za-z_$][\w$-]*)/) || [])[1];
        if (!NAME_ARG_MACRO.has(mn)) markQuoted(content, i, end, mark);
        i = end; continue;
      }
      const e = content.indexOf('>', i + 1);          // HTML tag → 安全
      i = e === -1 ? n : e + 1;
    }
  } else {
    markJsStrings(content, mark);
  }
  if (pairs && n <= 400000) for (const [f] of pairs) {   // i18n 精确条目：这些英文运行时会变成中文
    if (!f || f.length < 3) continue;
    let i = content.indexOf(f);
    while (i !== -1) { mark(i, i + f.length); i = content.indexOf(f, i + 1); }
  }
  return m;
}

// 以 [seedStart,seedEnd) 为种子向左右扩展，求"文件内唯一"的最短锚点。
// unsafe 非空时（安全锚点模式）：锚点内不允许出现任何不安全字符——
// 改动区间必须落在安全区；生长时某个方向一旦碰到不安全字符就立刻锁死该方向（不再越过它继续生长）；
// 两个方向都被锁死仍不唯一时报错，绝不返回含不安全内容的锚点。
function findUniqueAnchor(content, seedStart, seedEnd, unsafe, snapMacro) {
  const n = content.length;
  const seed = content.slice(seedStart, seedEnd);
  if (!seed) return { ok: false, reason: '选区为空' };
  const count = (s) => { let c = 0, i = -1; while ((i = content.indexOf(s, i + 1)) !== -1) c++; return c; };
  const total = count(seed);
  if (total === 0) return { ok: false, reason: '该文本在目标文件中不存在，无法作为锚点' };

  // 自动生成补丁时（snapMacro）把锚点对齐到宏边界：最短锚点常落在 <<widget "gdrug 这种宏中间，
  // 读起来像残片，也和界面高亮对不上。向外撑到整个 <<…>> 后必须仍全安全且全文唯一，否则保持原样。
  // 手动锚点不传 snapMacro——那里的边界就是用户选区，不能替他改。
  const done = (l, r) => {
    if (snapMacro) {
      const l0 = l, r0 = r;
      const li = content.lastIndexOf('<<', l - 1);
      if (li !== -1 && l - li <= SAFE_ANCHOR_CAP) {
        const c = content.indexOf('>>', li + 2);
        if (c !== -1 && c >= l) l = li;
      }
      const ri = content.lastIndexOf('<<', r - 1);
      if (ri !== -1 && r - ri <= SAFE_ANCHOR_CAP) {
        const c = content.indexOf('>>', ri + 2);
        if (c !== -1 && c >= r) r = c + 2;
      }
      if (l !== l0 || r !== r0) {
        let bad = false;
        if (unsafe) for (let i = l; i < r; i++) if (unsafe[i]) { bad = true; break; }
        if (!bad && count(content.slice(l, r)) !== 1) bad = true;
        if (bad) { l = l0; r = r0; }
      }
    }
    return { ok: true, anchor: content.slice(l, r), anchorStart: l, anchorEnd: r };
  };

  if (unsafe) for (let i = seedStart; i < seedEnd; i++) {   // 改动区间自身必须安全，否则锚点必然含会被翻译覆盖的文本
    if (unsafe[i]) return { ok: false, reason: '改动位于会被翻译覆盖的文本中，无法生成安全锚点' };
  }
  if (total === 1) return done(seedStart, seedEnd);

  const canR = (r) => r < n && (!unsafe || !unsafe[r]);     // 安全锚点模式下碰到不安全字符即锁死该方向
  const canL = (l) => l > 0 && (!unsafe || !unsafe[l - 1]);
  const hit = (l, r) => (count(content.slice(l, r)) === 1 ? done(l, r) : null);

  // 单向优先：只往一个方向长就能唯一时，不同时往两边长。两边都吃上下文，别的模组只要改到任一侧锚点就匹配不上了。
  for (const dir of [1, -1]) {
    let l = seedStart, r = seedEnd;
    while (dir > 0 ? canR(r) : canL(l)) {
      if (dir > 0) r++; else l--;
      const h = hit(l, r); if (h) return h;
      if (r - l > SAFE_ANCHOR_CAP) break;
    }
  }
  let l = seedStart, r = seedEnd;                           // 单向都不够唯一，才两边同时扩
  while (canL(l) || canR(r)) {
    if (canR(r)) { r++; const h = hit(l, r); if (h) return h; }
    if (canL(l)) { l--; const h = hit(l, r); if (h) return h; }
    if (r - l > SAFE_ANCHOR_CAP) break;
  }
  return { ok: false, reason: unsafe ? '锚点两侧都被会被翻译覆盖的文本截断，安全范围内找不到唯一锚点' : '无法在该文件内构造唯一锚点（重复度过高）', occurrences: total };
}

// 逐行流式检索 i18n（57MB / 198k 条，不整体 JSON.parse）
// 注意：pN 在 JSON 中位于 fileName 之后，必须等条目闭合（} 行）再取键
function searchI18n(jsonPath, query, limit = 200) {
  return new Promise((resolve) => {
    const out = [];
    let cur = null;
    const field = /^\s*"(\w+)":\s*(.*?)(,?)\s*$/;
    const flush = () => {
      if (cur && cur.f && cur.t && (String(cur.t).includes(query) || String(cur.f).includes(query))) {
        out.push({ t: cur.t, f: cur.f, fileName: cur.fileName, pN: cur.pN, pos: cur.pos });
      }
      cur = null;
    };
    const rl = readline.createInterface({ input: fs.createReadStream(jsonPath, 'utf8'), crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (out.length >= limit) { rl.close(); return; }
      const mm = field.exec(line);
      if (!mm) { if (/^\s*[\]{}]/.test(line)) flush(); return; }
      const k = mm[1];
      let v = mm[2].replace(/,$/, '').trim();
      if (v.startsWith('"')) { try { v = JSON.parse(v); } catch (_) { v = v.slice(1, -1); } }
      if (k === 'f') cur = { f: v };
      else if (cur) cur[k] = v;
    });
    rl.on('close', () => resolve(out));
    rl.on('error', () => resolve(out));
  });
}

// 逐行流式读取 i18n，构建「条目键(pN/fileName) → [[英文, 中文], ...]」
function loadI18nMap(jsonPath) {
  return new Promise((resolve) => {
    const map = {};
    let cur = null;
    const field = /^\s*"(\w+)":\s*(.*?)(,?)\s*$/;
    const flush = () => {
      if (cur && cur.f && cur.t) {
        const k = cur.pN !== undefined ? cur.pN : cur.fileName;
        if (k) (map[k] || (map[k] = [])).push([cur.f, cur.t]);
      }
      cur = null;
    };
    const rl = readline.createInterface({ input: fs.createReadStream(jsonPath, 'utf8'), crlfDelay: Infinity });
    rl.on('line', (line) => {
      const mm = field.exec(line);
      if (!mm) { if (/^\s*[\]{}]/.test(line)) flush(); return; }
      const k = mm[1];
      let v = mm[2].replace(/,$/, '').trim();
      if (v.startsWith('"')) { try { v = JSON.parse(v); } catch (_) { v = v.slice(1, -1); } }
      if (k === 'f') cur = { f: v };
      else if (cur) cur[k] = v;
    });
    rl.on('close', () => resolve(map));
    rl.on('error', () => resolve(map));
  });
}

// 活动栏搜索面板（WebviewView）：类 VSCode 搜索 UI，仅搜索、无替换
function searchHtml() {
  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 0; }
/* 搜索区域固定在上方，不随结果滚动 */
.top { position:sticky; top:0; z-index:2; background: var(--vscode-sideBar-background); padding:6px 6px 0; }
#wrap { padding:0 6px 6px; }
.box { display:flex; gap:4px; align-items:center; }
input.q { flex:1; min-width:0; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border:1px solid var(--vscode-input-border, transparent); padding:3px 6px; font-family:inherit; font-size:inherit; outline:none; }
input.q:focus { border-color: var(--vscode-focusBorder); }
button { background: var(--vscode-input-background); color: var(--vscode-foreground); border:1px solid var(--vscode-input-border, transparent); padding:3px 6px; cursor:pointer; font-family:inherit; }
button.on { background: var(--vscode-inputOption-activeBackground); color: var(--vscode-inputOption-activeForeground); border-color: var(--vscode-inputOption-activeBorder); }
.sum { margin:6px 2px; opacity:.8; }
.grp { margin-bottom:6px; }
.gh { padding:2px 4px; font-weight:600; display:flex; gap:6px; overflow:hidden; white-space:nowrap; }
.gh > span:first-child { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:0 1 auto; }
.gd { opacity:.6; font-weight:400; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:0 1 auto; min-width:0; }
.it { padding:2px 4px 2px 16px; cursor:pointer; }
.it:hover { background: var(--vscode-list-hoverBackground); }
.ml { white-space:nowrap; overflow:hidden; }
.sl { opacity:.6; white-space:nowrap; overflow:hidden; }
.ln { opacity:.5; margin-right:6px; }
mark { background: var(--vscode-editor-findMatchHighlightBackground); color: inherit; }
.note { opacity:.7; padding:4px; }
.spin { display:inline-block; width:9px; height:9px; vertical-align:-1px; margin-right:5px; border:2px solid var(--vscode-progressBar-background, #0e70c0); border-top-color:transparent; border-radius:50%; animation: sp .7s linear infinite; }
@keyframes sp { to { transform: rotate(360deg); } }
#res.busy { opacity:.45; }
</style>
</head>
<body>
<div class="top">
  <div class="box">
    <input class="q" id="q" placeholder="搜索（支持中文反查源码）" />
    <button id="cs" title="区分大小写">Aa</button>
    <button id="re" title="使用正则表达式">.*</button>
  </div>
  <div class="box" style="margin-top:4px">
    <button id="tj" class="on" title="包含 JS 文件">js</button>
    <button id="tt" class="on" title="包含 Passage">twee</button>
  </div>
  <div class="sum" id="sum"></div>
</div>
<div id="wrap">
  <div id="res"></div>
  <div class="box" id="pg" style="display:none; margin-top:6px">
    <button id="prev">上一页</button>
    <span id="pinfo" class="sum" style="margin:0 6px"></span>
    <button id="next">下一页</button>
  </div>
</div>
<script>
const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
let cs = false, re = false, tj = true, tt = true, page = 1, timer = null, cn = false;
$('cs').onclick = () => { cs = !cs; $('cs').classList.toggle('on', cs); page = 1; go(); };
$('re').onclick = () => { re = !re; $('re').classList.toggle('on', re); page = 1; go(); };
$('tj').onclick = () => { tj = !tj; $('tj').classList.toggle('on', tj); page = 1; go(); };
$('tt').onclick = () => { tt = !tt; $('tt').classList.toggle('on', tt); page = 1; go(); };
$('prev').onclick = () => { if (page > 1) { page--; go(); } };
$('next').onclick = () => { page++; go(); };
$('q').oninput = () => { clearTimeout(timer); timer = setTimeout(() => { page = 1; go(); }, 300); };
$('q').onkeydown = (e) => { if (e.key === 'Enter') { clearTimeout(timer); page = 1; go(); } };
function go() {
  if (!$('q').value.trim()) { $('res').innerHTML = ''; $('sum').textContent = ''; return; }
  $('sum').innerHTML = '<span class="spin"></span>搜索中…';
  $('res').classList.add('busy');
  vscode.postMessage({ type: 'search', q: $('q').value, cs: cs, re: re, tj: tj, tt: tt, page: page });
}
function esc(s) { return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
window.addEventListener('message', (e) => {
  const d = e.data;
  if (d && d.type === 'focus') { $('q').focus(); return; }
  if (!d || d.type !== 'result') return;
  page = d.page || 1;
  cn = !!d.cn;
  $('res').classList.remove('busy');
  $('sum').textContent = d.note ? d.note : ('第 ' + page + ' 页 · 本页 ' + d.total + ' 条' + (d.more ? '（还有更多）' : ''));
  $('pg').style.display = d.total ? 'flex' : 'none';
  $('pinfo').textContent = '第 ' + page + ' 页';
  // 真的还有上一页 / 下一页时按钮亮起蓝色（沿用 Aa/.* 那组开关的 .on 配色），没有就保持灰色并禁用
  $('prev').disabled = page <= 1;
  $('next').disabled = !d.more;
  $('prev').classList.toggle('on', page > 1);
  $('next').classList.toggle('on', !!d.more);
  const box = $('res'); box.innerHTML = '';
  for (const g of d.groups) {
    const gd = document.createElement('div'); gd.className = 'grp';
    const gh = document.createElement('div'); gh.className = 'gh';
    gh.innerHTML = '<span>' + esc(g.label) + '</span><span class="gd">' + esc(g.desc || '') + '</span>';
    gd.appendChild(gh);
    for (const it of g.items) {
      const row = document.createElement('div'); row.className = 'it';
      row.innerHTML = '<div class="ml"><span class="ln">' + (it.line || '') + '</span>' + esc(it.pre) + '<mark>' + esc(it.match) + '</mark>' + esc(it.post) + '</div>'
        + (it.sub ? '<div class="sl">' + esc(it.sub) + '</div>' : '');
      row.title = it.note || '';
      row.onclick = () => vscode.postMessage({ type: 'open', g: g.g, key: g.key, label: g.label, desc: g.desc, off: it.off, len: it.len, cn: cn, find: it.find });
      gd.appendChild(row);
    }
    box.appendChild(gd);
  }
  // 命中文本靠后时把它滚到面板中间，避免被 overflow 裁掉
  for (const r of box.querySelectorAll('.ml')) {
    const mk = r.querySelector('mark');
    if (mk) r.scrollLeft = mk.offsetLeft - (r.clientWidth - mk.offsetWidth) / 2;
  }
});
vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}

// ==================== VSCode 接线 ====================

function storagePath(context, name) {
  const dir = context.globalStorageUri.fsPath;
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}

const indexPath = (context) => storagePath(context, 'gameIndex.json');
const freqPath = (context) => storagePath(context, 'freq.json');
const pickPath = (context) => storagePath(context, 'picks.json');
// registerGameData 启动后填充：供 boot 面板查询游戏源码（锚点校验）
let gameAccess = null;

// 是否已确认 DoL 项目（能定位到 boot.json）。false 时「搜索 / 游戏源码」面板与全部模组相关功能一律禁用。
let projectActive = false;
// registerGameData 激活后填充：项目状态变化时要同步的内容（状态栏按钮、诊断）
let applyProjectActive = null;
function setProjectActive(on) {
  projectActive = !!on;
  if (applyProjectActive) applyProjectActive(projectActive);
}

function registerGameData(context) {
  if (!vscode) return;

  const channel = vscode.window.createOutputChannel('ATool 源码');
  context.subscriptions.push(channel);

  let index = null;
  let htmlCache = { path: null, text: null };
  let freq = new Map();          // 标识符 → 使用次数（来自模组源码统计）
  let picks = {};                // 标识符 → { n: 用户选择次数, t: 最近选择时间戳 }
  let txMap = null;              // 翻译条目：entryKey → [[英文, 中文], ...]
  let cnMode = false;            // 源码文档是否显示中文
  let srcFilter = '';            // 游戏源码树的文件名筛选
  const cfg = () => vscode.workspace.getConfiguration('atools4dol');
  // 功能开关：默认一律开启，只有显式设为 false 才关闭
  const cfgOn = (k) => cfg().get(k) !== false;
  try { freq = new Map(JSON.parse(fs.readFileSync(freqPath(context), 'utf8'))); } catch (_) {}
  try { picks = JSON.parse(fs.readFileSync(pickPath(context), 'utf8')) || {}; } catch (_) {}
  const savePicks = () => { try { fs.writeFileSync(pickPath(context), JSON.stringify(picks)); } catch (_) {} };

  // 就绪信号：VSCode 在启动瞬间就会向我们要一次「文档链接」，而那时 boot.json 探测（异步文件搜索）
  // 还没结束、索引和工作区定义都还没载入。当场回空会被它按「文档版本」缓存下来，之后只要不编辑这个文件
  // 就永远不再重算——表现成「其他文件都有下划线，就这个文件没有、Ctrl+点击也不跳」。
  // 所以链接/跳转先等这里 resolve，等索引与工作区定义都备好再一次性答全。
  let readyResolve = null;
  const ready = new Promise((r) => { readyResolve = r; });
  const markReady = () => { if (readyResolve) { readyResolve(); readyResolve = null; } };
  // 兜底：项目探测万一异常抛错导致 startProject 没跑完，也不能让这两个功能永远挂起
  setTimeout(markReady, 15000);

  function getHtml() {
    const p = index && index.sourceHtml;
    if (!p || !fs.existsSync(p)) return '';
    if (htmlCache.path !== p) htmlCache = { path: p, text: decodeSource(fs.readFileSync(p, 'utf8')) };
    return htmlCache.text;
  }

  async function resolveByGlob(value, defGlob) {
    const v = String(value || '').trim();
    if (v && path.isAbsolute(v)) {
      if (fs.existsSync(v)) return v;
      channel.appendLine('路径不存在，改用工作区搜索: ' + v);
    }
    const uris = await vscode.workspace.findFiles(v || defGlob, '**/node_modules/**', 30);
    let best = null, bestT = -1;
    for (const u of uris) { try { const st = fs.statSync(u.fsPath); if (st.mtimeMs > bestT) { bestT = st.mtimeMs; best = u.fsPath; } } catch (_) {} }
    if (best) return best;
    // 工作区内搜不到时，退回游戏源码所在目录按文件名匹配（i18n 常与游戏 HTML 同目录）
    if (index && index.sourceHtml) {
      try {
        const dir = path.dirname(index.sourceHtml);
        const re = new RegExp('^' + defGlob.slice(defGlob.lastIndexOf('/') + 1).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i');
        const hit = fs.readdirSync(dir).find((f) => re.test(f));
        if (hit) { channel.appendLine(`工作区未匹配到 ${defGlob}，改用同目录文件: ${hit}`); return path.join(dir, hit); }
      } catch (_) {}
    }
    return null;
  }

  // 游戏源码 HTML 51MB、翻译 JSON 65MB，超出 VSCode 编辑器能打开的大小，改为在系统资源管理器里定位
  function revealFile(p, label) {
    if (!p) { vscode.window.showWarningMessage(`ATool：未找到${label}`); return; }
    vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(p));
  }

  async function scan() {
    const src = await resolveByGlob(cfg().get('gameSourcePath'), '**/Degrees of Lewdity.html');
    if (!src) { vscode.window.showWarningMessage('ATool：未找到游戏源码 HTML，请设置 atools4dol.gameSourcePath'); return; }
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'ATool：扫描游戏源码…' },
      async () => {
        const st = fs.statSync(src);
        const html = decodeSource(fs.readFileSync(src, 'utf8'));
        htmlCache = { path: src, text: html };
        const ver = (path.basename(src).match(/(\d+\.\d+\.\d+(?:\.\d+)*)/) || [])[1] || '';
        index = buildIndex(html, { gameVersion: ver, sourceHtml: src, sourceMtime: st.mtimeMs });
        try { fs.writeFileSync(indexPath(context), JSON.stringify(index)); } catch (e) { channel.appendLine('索引写入失败: ' + e.message); }
        channel.appendLine(`扫描完成 → 宏 ${index.macros.length + index.addMacros.length}｜setup ${Object.keys(index.setupAssign).length}｜$变量 ${index.variables.length}｜passage ${index.passages.length}｜js ${index.jsFiles.length}`);
        sendCompletion();   // 游戏已连着的话，把新宏名刷新过去（没连时是空操作）
      }
    );
  }

  async function ensureIndex() {
    try { index = JSON.parse(fs.readFileSync(indexPath(context), 'utf8')); } catch (_) { index = null; }
    const src = await resolveByGlob(cfg().get('gameSourcePath'), '**/Degrees of Lewdity.html');
    if (!index || index.schema !== 7 || !src || index.sourceHtml !== src || !fs.existsSync(src) || fs.statSync(src).mtimeMs !== index.sourceMtime) {
      await scan();
    }
  }

  // ---------- 虚拟文档（可写：保存即生成 ReplacePatcher 补丁写入 boot.json） ----------
  const srcUri = (kind, key) => vscode.Uri.from({ scheme: SCHEME, path: '/' + kind + '/' + key });
  const jsUri = (p) => srcUri('js', p);
  // passage 虚拟文档刻意【不】带 .twee 后缀：twee3 插件的 provider 是按 {pattern:'**/*.{tw,twee}'} 注册的，
  // 路径一旦命中，它就会和我们的 DefinitionProvider 抢答同一位置（表现为 Ctrl 悬停的手指/文本光标交替、点击点不动）。
  // 语法高亮改由「打开时 setTextDocumentLanguage(…,'twee3')」提供，与文件名无关。
  const passageUri = (name) => srcUri('passage', name.replace(/\.twee$/i, ''));
  const srcChange = new vscode.EventEmitter();
  // stat 的 etag = mtime.toString(29) + size.toString(31)（VSCode 内部算法），内容变了 etag 必须跟着变，
  // 否则 VSCode 认定「文件没被改过」而跳过重载，切中英文时正文就不刷新。
  // 但也不能用 Date.now()：每次 stat 都不同会让 VSCode 以为文件被反复外部修改，无限重载（一直转圈）。
  // 折中：只有我们主动刷新时 +1，平时恒定。
  let srcEpoch = 1;
  let patches = {};        // 'js:<fileName>' / 'passage:<name>' → { from, to }
  // TweeReplacer 的「文件替换」条目：'passage:<name>' → [{ from, re, flags, file, all }]
  let tRep = {};
  let txLoading = false;   // 后台载入 i18n（供安全锚点参考）的防重入标志
  let bootUri = null;
  // Uri.path 里的空格/中文可能是编码形式（%20 / %E4…），取出来要解码，否则 rawContent 按名字找不到内容（跳过去是空白文档）；
  // 名称本身带 % 时 decodeURIComponent 会抛，退化为原样
  const splitUri = (uri) => {
    const p = uri.path.split('/');
    const k = p.slice(2).join('/');
    try { return [p[1], decodeURIComponent(k)]; } catch (_) { return [p[1], k]; }
  };
  const txKeyOf = (kind, key) => (kind === 'js' ? path.posix.basename(key) : key.replace(/\.twee$/i, ''));

  // 游戏自带原文（不含补丁、不含翻译）
  function rawContent(kind, key) {
    const html = getHtml();
    if (!html || !index) return '';
    if (kind === 'js') {
      const f = index.jsFiles.find((x) => x.path === key) || index.jsFiles.find((x) => x.base === key);
      return f ? html.slice(f.start, f.end) : '';
    }
    const p = index.passages.find((x) => x.name === key.replace(/\.twee$/i, ''));
    return p ? html.slice(p.bodyStart, p.bodyEnd) : '';
  }

  // boot.json 所在目录：replaceFile 的相对路径以它为基准
  const bootDir = () => (bootUri ? path.dirname(bootUri.fsPath) : '');
  function readRepFile(rel) {
    const d = bootDir();
    if (!d || !rel) return null;
    try { return fs.readFileSync(path.join(d, rel), 'utf8'); } catch (_) { return null; }
  }
  // 应用一条 TweeReplacer 文件替换：把 from（字符串 / 正则）换成 replaceFile 的内容
  function applyFilePat(body, fp) {
    const rep = readRepFile(fp.file);
    if (rep == null || !fp.from) return body;
    if (fp.re) {
      try { return body.replace(new RegExp(fp.from, fp.all ? (fp.flags.includes('g') ? fp.flags : fp.flags + 'g') : fp.flags), () => rep); }
      catch (_) { return body; }
    }
    return fp.all ? body.split(fp.from).join(rep) : body.replace(fp.from, () => rep);
  }

  function entryContent(kind, key) {
    const raw = rawContent(kind, key);
    if (!raw) return '';
    const tk = txKeyOf(kind, key);
    const pt = patches[kind + ':' + tk];
    let body = pt && raw.includes(pt.from) ? raw.replace(pt.from, () => pt.to) : raw;
    for (const fp of tRep[kind + ':' + tk] || []) body = applyFilePat(body, fp);   // boot 里的文件替换也要合并显示
    return cnMode && txMap ? applyTx(body, txMap[tk]) : body;
  }

  // 游戏内调试面板要的两样东西：宏候选（内置宏 + 扫描到的原版宏）与容器宏名单（自动补闭端用）。
  // $变量 / setup / 对象成员都由游戏运行时即时解析，不必下发。
  const completionMacros = () => [...new Set([...BUILTIN_MACRO, ...(index ? index.macros : []), ...(index ? index.addMacros : [])])];
  const sendCompletion = () => require('./server').sendJSON({ type: 'atools-index', macros: completionMacros(), containers: [...CONTAINER_MACRO] });

  // 供 boot 面板校验补丁锚点：只读游戏源码原文（不含补丁/翻译）
  gameAccess = {
    ensure: ensureIndex,
    sendCompletion,
    has: (kind, key) => {
      if (!index) return false;
      if (kind === 'js') return index.jsFiles.some((f) => f.path === key || f.base === key);
      return index.passages.some((p) => p.name === String(key).replace(/\.twee$/i, ''));
    },
    content: (kind, key) => rawContent(kind, key),
  };

  async function findBoot() {
    if (bootUri) return bootUri;
    // 工作区里有几十个 boot.json，不能随便取一个：用 atools4dol.bootPath 指定（绝对路径或 glob）
    const p = await resolveByGlob(cfg().get('bootPath'), '**/boot.json');
    bootUri = p ? vscode.Uri.file(p) : null;
    return bootUri;
  }

  async function loadPatches() {
    patches = {};
    tRep = {};
    const u = await findBoot();
    if (!u) { channel.appendLine('未找到 boot.json，源码改动将无法持久化'); return; }
    let data; try { data = JSON.parse(fs.readFileSync(u.fsPath, 'utf8')); } catch (_) { return; }
    const rp = (data.addonPlugin || []).find((x) => x.modName === 'ReplacePatcher');
    const pr = (rp && rp.params) || {};
    for (const e of pr.js || []) if (e._atool) patches['js:' + (e.fileName || '')] = e;
    for (const e of pr.twee || []) if (e._atool) patches['passage:' + (e.passageName || '')] = e;
    // TweeReplacer 的文件替换条目（不论是否 ATool 生成，都要合并显示并支持同步写回）
    for (const p of data.addonPlugin || []) {
      if (p.addonName !== 'TweeReplacerAddon' && p.modName !== 'TweeReplacer') continue;
      for (const it of Array.isArray(p.params) ? p.params : []) {
        if (!it || !it.replaceFile) continue;
        const nm = String(it.passage || '').replace(/\.twee$/i, '');
        if (!nm) continue;
        (tRep['passage:' + nm] || (tRep['passage:' + nm] = [])).push({
          from: 'findRegex' in it ? it.findRegex : it.findString,
          re: 'findRegex' in it, flags: String(it.regexFlag || ''), file: String(it.replaceFile), all: it.all === true,
        });
      }
    }
    channel.appendLine(`boot.json 恢复 ATool 补丁 ${Object.keys(patches).length} 条，文件替换 ${Object.keys(tRep).length} 段`);
  }

  async function savePatches() {
    const u = await findBoot();
    if (!u) { vscode.window.showErrorMessage('ATool：工作区里没有 boot.json，改动无法保存'); return; }
    let data; try { data = JSON.parse(fs.readFileSync(u.fsPath, 'utf8')); } catch (e) { vscode.window.showErrorMessage('ATool：boot.json 解析失败 ' + e.message); return; }
    const list = (data.addonPlugin = data.addonPlugin || []);
    let rp = list.find((x) => x.modName === 'ReplacePatcher');
    if (!rp) { rp = { modName: 'ReplacePatcher', addonName: 'ReplacePatcherAddon', modVersion: '^1.0.0', params: {} }; list.push(rp); }
    rp.params = rp.params || {};
    const keep = (arr) => (arr || []).filter((x) => !x._atool);   // 保留别人手写的补丁，只重写 ATool 自己管的
    rp.params.js = keep(rp.params.js);
    rp.params.twee = keep(rp.params.twee);
    for (const [k, v] of Object.entries(patches)) (k.startsWith('js:') ? rp.params.js : rp.params.twee).push(v);
    fs.writeFileSync(u.fsPath, JSON.stringify(data, null, 2));
    channel.appendLine(`boot.json 已更新：js 补丁 ${rp.params.js.length}｜twee 补丁 ${rp.params.twee.length}`);
    vscode.commands.executeCommand('atools4dol.refreshBoot').then(undefined, () => {});
  }

  // 安全锚点掩码：force 为真时不做安全处理；txMap 未载入则先后台载入（本次先用语法启发式）
  function maskFor(kind, tk, content, force) {
    if (force) return undefined;
    if (!txMap) kickTxLoad();
    return unsafeMask(content, kind, txMap ? txMap[tk] : null);
  }

  // 需要 i18n 精确判定时后台载入一次翻译补丁（不阻塞当前动作）
  async function kickTxLoad() {
    if (txMap || txLoading) return;
    txLoading = true;
    try {
      const p = await resolveByGlob(cfg().get('i18nPath'), '**/i18n.json');
      if (p) {
        const m = await loadI18nMap(p);
        for (const kk of Object.keys(m)) m[kk].sort((a, b) => b[0].length - a[0].length);
        if (!txMap) txMap = m;
        channel.appendLine('已后台载入翻译补丁（安全锚点将参考 i18n）');
      }
    } catch (_) {} finally { txLoading = false; }
  }

  // 该 passage 若是 TweeReplacer 文件替换，且本次改动完全落在被替换区段内，就把新内容写回文件
  async function writeBackFile(kind, tk, next, raw) {
    const list = tRep[kind + ':' + tk];
    if (!list || list.length !== 1) return false;         // 只有单一「字符串型」文件替换支持写回
    const fp = list[0];
    if (fp.re || fp.all || !fp.from) return false;        // 只支持「字符串 + 单次」的文件替换写回
    const base = entryContent(kind, tk);                  // 当前显示内容（原文 + 已应用的文件替换）
    // from 是文件内唯一锚点：替换后 base 里已不含 from，所以要在原文里定位它，并确认前缀对齐
    const fi = raw.indexOf(fp.from);
    if (fi < 0 || base.slice(0, fi) !== raw.slice(0, fi)) return false;
    const rep = readRepFile(fp.file);
    if (rep == null) return false;
    const fe = fi + rep.length;
    let p = 0; const lim = Math.min(base.length, next.length);
    while (p < lim && base[p] === next[p]) p++;
    let s = 0;
    while (s < lim - p && base[base.length - 1 - s] === next[next.length - 1 - s]) s++;
    const delta = next.length - base.length;
    const end = next.length - s;
    if (p < fi || end > fe + delta) return false;         // 改动跑到替换区段之外 → 交给内联补丁
    const d = bootDir();
    if (!d) return false;
    try { fs.writeFileSync(path.join(d, fp.file), next.slice(fi, fe + delta)); }
    catch (e) { channel.appendLine('写回文件替换失败: ' + e.message); return false; }
    channel.appendLine(`已同步文件替换 ${fp.file}`);
    return true;
  }

  // 改动被完全还原成原文时：从 boot.json 删掉该条目的 ATool 内联补丁与 ATool 文件替换条目
  async function dropEntry(kind, tk) {
    delete patches[kind + ':' + tk];
    const u = await findBoot();
    if (!u) return;
    let data; try { data = JSON.parse(fs.readFileSync(u.fsPath, 'utf8')); } catch (_) { return; }
    let hit = false;
    const list = data.addonPlugin || [];
    const rp = list.find((x) => x.modName === 'ReplacePatcher');
    if (rp && rp.params && Array.isArray(kind === 'js' ? rp.params.js : rp.params.twee)) {
      const arr = kind === 'js' ? rp.params.js : rp.params.twee;
      const kept = arr.filter((e) => !(e && e._atool && String((kind === 'js' ? e.fileName : e.passageName) || '') === tk));
      if (kept.length !== arr.length) { hit = true; if (kind === 'js') rp.params.js = kept; else rp.params.twee = kept; }
    }
    for (const p of list) {
      if (p.addonName !== 'TweeReplacerAddon' && p.modName !== 'TweeReplacer') continue;
      if (Array.isArray(p.params)) {
        const kept = p.params.filter((x) => !(x && x._atool && String(x.passage || '').replace(/\.twee$/i, '') === tk));
        if (kept.length !== p.params.length) { hit = true; p.params = kept; }
      }
    }
    if (hit) {
      fs.writeFileSync(u.fsPath, JSON.stringify(data, null, 2));
      channel.appendLine('boot.json 已移除还原的条目: ' + kind + ':' + tk);
      vscode.commands.executeCommand('atools4dol.refreshBoot').then(undefined, () => {});
    }
    await loadPatches();
  }

  // 保存虚拟文档 → 与原版正文的差异写进 boot.json 的 ReplacePatcher 补丁；
  // 若该 passage 用的是 TweeReplacer 文件替换，则把改动写回那个文件
  async function saveEntry(uri, content) {
    const [kind, key] = splitUri(uri);
    const tk = txKeyOf(kind, key);
    const raw = rawContent(kind, key);
    if (!raw) return;
    let next = content.toString('utf8');
    // 中文模式下编辑：先把译文还原成英文，避免把中文写进补丁
    if (cnMode && txMap) {
      const pairs = (txMap[tk] || []).slice().sort((a, b) => b[1].length - a[1].length);
      for (const [f, t] of pairs) if (t) next = next.split(t).join(f);
    }
    if (next === entryContent(kind, key)) return;   // 与当前显示一致 → 没有任何改动
    const k = kind + ':' + tk;
    if (next === raw) {
      await dropEntry(kind, tk);
    } else if (!(await writeBackFile(kind, tk, next, raw))) {
      // 只取「本文件内最短唯一锚点」：先求公共前后缀定位改动区间，再让锚点生长到边界安全 + 全文唯一为止
      const old = patches[k];
      let p = 0; const lim = Math.min(raw.length, next.length);
      while (p < lim && raw[p] === next[p]) p++;
      let s = 0;
      while (s < lim - p && raw[raw.length - 1 - s] === next[next.length - 1 - s]) s++;
      let ss = p, se = raw.length - s;
      if (se <= ss) { if (ss > 0) ss--; else se = Math.min(ss + 1, raw.length); }
      const a = findUniqueAnchor(raw, ss, se, maskFor(kind, tk, raw, old && old._force), true);
      if (!a.ok) {   // 找不到安全锚点就不生成补丁（绝不回退到整段/含不安全文本的锚点）
        vscode.window.showWarningMessage('ATool：无法为该 passage 生成安全锚点（' + a.reason + '），本次改动未写入补丁。');
        return;
      }
      patches[k] = Object.assign({
        _atool: true,
        from: a.anchor,
        to: raw.slice(a.anchorStart, p) + next.slice(p, next.length - s) + raw.slice(raw.length - s, a.anchorEnd),
      }, old && old._force ? { _force: true } : {}, kind === 'js' ? { fileName: path.posix.basename(key) } : { passageName: tk });
      await savePatches();
    }
    srcEpoch++;
    srcChange.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  }

  const FS_PROVIDER = {
    onDidChangeFile: srcChange.event,
    watch: () => new vscode.Disposable(() => {}),
    stat: async (uri) => {
      await ready;   // 启动还原虚拟文档时索引还没建好，等就绪再答，否则 VSCode 会报「由于意外错误，无法打开编辑器」
      const [k, key] = splitUri(uri);
      // mtime 用 srcEpoch（只在主动刷新时 +1，稳定期不变，避免一直转圈）；
      // size 用原文长度，不走 entryContent（中文模式下对整篇 JS 做替换很慢，而 stat 调用很频繁）
      return { type: vscode.FileType.File, ctime: 0, mtime: srcEpoch, size: Buffer.byteLength(rawContent(k, key), 'utf8'),
        permissions: cnMode ? vscode.FilePermission.Readonly : undefined };
    },
    readDirectory: () => [],
    createDirectory: () => {},
    delete: () => {},
    rename: () => {},
    readFile: async (uri) => { await ready; const [k, key] = splitUri(uri); return Buffer.from(entryContent(k, key), 'utf8'); },
    writeFile: (uri, content) => { if (cnMode) { vscode.window.showWarningMessage('中文模式下不可编辑，请先切回英文'); return; } return saveEntry(uri, content); },
  };
  context.subscriptions.push(srcChange, vscode.workspace.registerFileSystemProvider(SCHEME, FS_PROVIDER, { isCaseSensitive: true, isReadonly: false }));

  // ---------- 改动区高亮 + 「保存为文件」CodeLens ----------
  // 虚拟文档与原文的差异区间：用编辑器主题的查找高亮色，视觉与原版 UI 一致
  const changedDeco = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
    borderRadius: '2px',
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.findMatchForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Right,
  });
  const lensEmitter = new vscode.EventEmitter();
  context.subscriptions.push(changedDeco, lensEmitter);

  function diffRange(doc) {
    if (cnMode || doc.uri.scheme !== SCHEME) return null;
    const [kind, key] = splitUri(doc.uri);
    if (kind !== 'passage') return null;   // 高亮/CodeLens 只针对 passage；大 JS 文件每次按键做全文 diff 会卡
    const raw = rawContent(kind, key);
    if (!raw) return null;
    const cur = doc.getText();
    if (cur === raw) return null;
    let p = 0; const lim = Math.min(raw.length, cur.length);
    while (p < lim && raw[p] === cur[p]) p++;
    let s = 0;
    while (s < lim - p && raw[raw.length - 1 - s] === cur[cur.length - 1 - s]) s++;
    let end = cur.length - s;
    if (end <= p) return null;
    // 对齐到宏边界：最小差分常把 <<test>> 和后面的 <<widget …>> 各切掉一半，显示成
    // <<[test>>\n\n<<]widget "gdrugged">>。落在某个 <<…>> 内部时，左边界回退到该宏的 <<
    // （整条宏视作改动），右边界退回该宏的 <<（后面没改动的宏不纳入高亮）。
    const p0 = p;
    const inMacro = (pos) => {
      const i = cur.lastIndexOf('<<', pos - 1);
      if (i === -1) return -1;
      const c = cur.indexOf('>>', i + 2);
      return c === -1 || c >= pos ? i : -1;
    };
    const li = inMacro(p); if (li !== -1) p = li;
    const ri = inMacro(end);
    if (ri !== -1) { const c = cur.indexOf('>>', ri + 2); end = ri > p0 ? ri : (c === -1 ? cur.length : c + 2); }
    if (end <= p) return null;
    return { start: doc.positionAt(p), end: doc.positionAt(end) };
  }
  // 刷新所有可见源码文档的高亮与 CodeLens（改动 / 切换中英文 / 保存后都要更新）
  function refreshDecor() {
    for (const ed of vscode.window.visibleTextEditors) {
      if (ed.document.uri.scheme !== SCHEME) continue;
      const r = diffRange(ed.document);
      ed.setDecorations(changedDeco, r ? [new vscode.Range(r.start, r.end)] : []);
    }
    lensEmitter.fire();
  }
  context.subscriptions.push(
    vscode.window.onDidChangeVisibleTextEditors(() => refreshDecor()),
    vscode.workspace.onDidChangeTextDocument((e) => { if (e.document.uri.scheme === SCHEME) refreshDecor(); }),
    vscode.languages.registerCodeLensProvider({ scheme: SCHEME }, {
      onDidChangeCodeLenses: lensEmitter.event,
      provideCodeLenses(doc) {
        if (!projectActive || cnMode) return [];
        const r = diffRange(doc);
        if (!r) return [];
        return [
          new vscode.CodeLens(new vscode.Range(r.start.line, 0, r.start.line, 0), {
            title: '$(file-add) 保存为文件（改为文件替换）',
            command: 'atools4dol.saveAsFile', arguments: [doc.uri],
          }),
          new vscode.CodeLens(new vscode.Range(r.start.line, 0, r.start.line, 0), {
            title: '$(discard) 撤销更改（恢复游戏原文）',
            command: 'atools4dol.undoEdit', arguments: [doc.uri],
          }),
        ];
      },
    })
  );

  // ---------- 活动栏视图：JS / Passage 卡片 + 搜索 ----------
  // 卡片节点为纯对象 {g,key,label,desc,off?}；g='group' 为分组
  // 节点必须缓存复用：TreeView.reveal 依赖对象同一性
  let cardCache = {};
  // 收藏：卡片以 g:key 为 id 存在 workspaceState 里，条目本身仍走同一个卡片对象（reveal 依赖对象同一性）
  const FAVKEY = 'atools4dol.favorites';
  const favs = new Set(context.workspaceState.get(FAVKEY, []));
  const favId = (el) => el.g + ':' + el.key;
  const isFav = (el) => favs.has(favId(el));
  const cardsFor = (g) => {
    if (g === 'fav') return [...cardsFor('js'), ...cardsFor('passage')].filter(isFav);
    if (cardCache[g]) return cardCache[g];
    const all = g === 'js'
      ? index.jsFiles.map((f) => ({ g: 'js', key: f.path, label: f.base, desc: f.path }))
      : index.passages.map((p) => ({ g: 'passage', key: p.name, label: p.name || '(未命名 passage)', desc: p.tags }));
    // 文件名筛选（标题栏放大镜按钮设置）：按名称或路径做不区分大小写的包含匹配
    const f = srcFilter.toLowerCase();
    return (cardCache[g] = f ? all.filter((c) => String(c.label).toLowerCase().includes(f) || String(c.desc || '').toLowerCase().includes(f)) : all);
  };
  const groups = {
    fav: { g: 'group', label: '收藏', icon: 'star-full', sub: 'fav' },
    js: { g: 'group', label: 'JS 文件', icon: 'file-code', sub: 'js' },
    passage: { g: 'group', label: 'Passage', icon: 'book', sub: 'passage' },
  };

  // 游戏源码树同步展开并选中该条目（搜索面板传来的 el 是副本，需换成缓存里的同一对象）
  function revealInTree(g, key) {
    if (!index) return;
    const hit = cardsFor(g).find((x) => x.key === key);
    if (hit) treeView.reveal(hit, { select: true, focus: false, expand: true }).then(undefined, () => {});
  }

  async function openEntry(el) {
    const doc = await vscode.workspace.openTextDocument(el.g === 'js' ? jsUri(el.key) : passageUri(el.key));
    const ed = await vscode.window.showTextDocument(doc, { preview: true });
    // 中文模式下译文替换了原文，偏移已失效，按译文文本重新定位
    const at = el.find ? ed.document.getText().indexOf(el.find) : -1;
    const off = at >= 0 ? at : el.off;
    const len = at >= 0 ? el.find.length : el.len;
    if (off !== undefined) {
      const s = ed.document.positionAt(off);
      const e = ed.document.positionAt(off + (len || 0));
      ed.selection = new vscode.Selection(s, e);
      ed.revealRange(new vscode.Range(s, e), vscode.TextEditorRevealType.InCenter);
    }
    revealInTree(el.g, el.key);
    refreshDecor();   // 打开时立即按改动区间高亮 + 挂上「保存为文件」CodeLens
    return ed;
  }

  const tree = new class {
    constructor() { this._em = new vscode.EventEmitter(); this.onDidChangeTreeData = this._em.event; }
    refresh() { cardCache = {}; this._em.fire(); }
    // 只重画、不丢卡片缓存（收藏切换后卡片对象必须保持同一性）
    update() { this._em.fire(); }
    getTreeItem(el) {
      if (el.g === 'group') {
        const t = new vscode.TreeItem(el.label, vscode.TreeItemCollapsibleState.Collapsed);
        t.iconPath = new vscode.ThemeIcon(el.icon);
        t.contextValue = 'group';
        return t;
      }
      const t = new vscode.TreeItem(el.label, vscode.TreeItemCollapsibleState.None);
      t.description = el.desc;
      t.tooltip = el.desc;
      t.iconPath = new vscode.ThemeIcon(isFav(el) ? 'star-full' : (el.g === 'js' ? 'file-code' : 'book'));
      t.contextValue = isFav(el) ? 'card.fav' : 'card';
      t.command = { command: 'atools4dol.openSource', title: '打开', arguments: [el] };
      return t;
    }
    getChildren(el) {
      if (!index) return [];
      if (!el) {
        groups.fav.label = `收藏 (${cardsFor('fav').length})`;
        groups.js.label = `JS 文件 (${index.jsFiles.length})`;
        groups.passage.label = `Passage (${index.passages.length})`;
        return [groups.fav, groups.js, groups.passage];
      }
      if (el.g !== 'group') return [];
      return cardsFor(el.sub);
    }
    getParent(el) { return el.g === 'group' ? undefined : groups[el.g]; }
  };
  const treeView = vscode.window.createTreeView('atools4dol.source', { treeDataProvider: tree, showCollapseAll: true });
  context.subscriptions.push(treeView);

  // 收藏 / 取消收藏（卡片右键菜单）
  async function toggleFav(el) {
    if (!el || el.g === 'group') return;
    const id = favId(el);
    if (favs.has(id)) favs.delete(id); else favs.add(id);
    await context.workspaceState.update(FAVKEY, [...favs]);
    tree.update();
  }

  async function pickGameSource() {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: false, title: '选择游戏源码 HTML（Degrees of Lewdity.html）', filters: { HTML: ['html'] },
    });
    if (!uris || !uris.length) return;
    const target = vscode.workspace.workspaceFolders ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    await cfg().update('gameSourcePath', uris[0].fsPath, target);
  }

  async function pickI18n() {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: false, title: '选择翻译补丁 JSON（i18n.json）', filters: { JSON: ['json'] },
    });
    if (!uris || !uris.length) return;
    txMap = null;
    const target = vscode.workspace.workspaceFolders ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    await cfg().update('i18nPath', uris[0].fsPath, target);
    vscode.window.showInformationMessage('ATool：翻译补丁已设置，可用源码标签的切换按钮显示中文');
  }

  // 扫描模组源码，统计标识符使用频率 → 用于候选排序
  async function buildStats() {
    const sp = String(cfg().get('statsPath') || '').trim();
    const pattern = sp ? new vscode.RelativePattern(vscode.Uri.file(sp), '**/*.{twee,js,ts}') : '**/*.{twee,js,ts}';
    const uris = await vscode.workspace.findFiles(pattern, '**/node_modules/**', 5000);
    if (!uris.length) { vscode.window.showWarningMessage('ATool：未找到可统计的 .twee/.js 文件'); return; }
    const counts = new Map();
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'ATool：统计模组源码使用频率…' },
      async () => {
        for (const u of uris) {
          let t; try { t = fs.readFileSync(u.fsPath, 'utf8'); } catch (_) { continue; }
          let m; const re = /[A-Za-z_$][\w$]*/g;
          while ((m = re.exec(t))) counts.set(m[0], (counts.get(m[0]) || 0) + 1);
        }
      }
    );
    freq = counts;
    try { fs.writeFileSync(freqPath(context), JSON.stringify([...counts])); } catch (_) {}
    channel.appendLine(`频率统计：${uris.length} 个文件，${counts.size} 个标识符`);
    vscode.window.showInformationMessage(`ATool：已统计 ${uris.length} 个文件，候选将按使用频率排序`);
  }

  // 游戏源码树按文件名筛选（标题栏放大镜按钮 → 弹出输入框，留空显示全部）
  async function filterSource() {
    const v = await vscode.window.showInputBox({
      prompt: '按文件名筛选游戏源码（留空显示全部）',
      value: srcFilter,
      placeHolder: '例如 canvas、event',
    });
    if (v === undefined) return;
    srcFilter = v.trim();
    tree.refresh();
    channel.appendLine(srcFilter ? `游戏源码筛选：${srcFilter}` : '游戏源码筛选已清除');
  }

  // 状态栏常驻的中英切换按钮（取代原先挂在编辑器标题栏上的两个按钮；中文模式下常亮）
  const cnItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  context.subscriptions.push(cnItem);
  const syncCnItem = () => {
    cnItem.text = cnMode ? '$(globe) 中文' : '$(globe) 英文';
    cnItem.tooltip = cnMode ? 'ATools4DoL：源码显示中文（点击切回英文）' : 'ATools4DoL：源码显示英文（点击切换为中文）';
    cnItem.command = cnMode ? 'atools4dol.toEnglish' : 'atools4dol.toChinese';
    cnItem.backgroundColor = cnMode ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    // 只有确认是 DoL 项目时才显示中英切换按钮
    if (projectActive) cnItem.show(); else cnItem.hide();
  };
  syncCnItem();

  // 源码文档中英切换（用翻译补丁替换英文原文）
  async function setCn(on) {
    if (on && !txMap) {
      const p = await resolveByGlob(cfg().get('i18nPath'), '**/i18n.json');
      if (!p) { vscode.window.showWarningMessage('ATool：未找到翻译补丁 JSON，请先选择 atools4dol.pickI18n'); return; }
      channel.appendLine('加载翻译补丁: ' + p);
      txMap = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'ATool：加载翻译补丁…' },
        () => loadI18nMap(p)
      );
      for (const k of Object.keys(txMap)) txMap[k].sort((a, b) => b[0].length - a[0].length);
    }
    cnMode = on;
    syncCnItem();
    const opened = vscode.workspace.textDocuments.filter((d) => d.uri.scheme === SCHEME);
    // FileSystemProvider 的 onDidChangeFile 需要 {type, uri} 列表
    if (opened.length) {
      srcEpoch++;   // 不加这一步 etag 不变，VSCode 会跳过重载、正文不刷新
      srcChange.fire(opened.map((d) => ({ type: vscode.FileChangeType.Changed, uri: d.uri })));
    }
    refreshDecor();
    channel.appendLine(`源码显示切换 → ${on ? '中文' : '英文'}（已打开 ${opened.length} 个标签）`);
  }

  // 按路径匹配 .twee，语言 id 用 twee3（twee3 插件），避免与其它 twee 扩展抢语言
  // 注意：必须在所有 register*Provider 之前声明（否则激活时报 SELECTOR before initialization）
  const SELECTOR = [{ pattern: '**/*.twee' }, { language: 'twee3' }, { language: 'javascript' }, { language: 'typescript' }];
  const isTweeDoc = (document) => document.languageId.startsWith('twee') || /\.twee$/i.test(document.uri.path)
    // 虚拟 passage 文档不带 .twee 后缀，语言 id 又是异步挂上去的：这里按 scheme+路径兜底，避免那一瞬间问不到我们
    || (document.uri.scheme === SCHEME && document.uri.path.startsWith('/passage/'));
  // 定义/悬浮能被问到的文档类型（twee 按扩展名或语言，外加 JS/TS）
  const isSrcDoc = (document) => isTweeDoc(document) || /^(javascript|typescript)$/.test(document.languageId);
  // 「游戏源码」虚拟文档 vs 工作区模组文件：下划线与跳转按这两个范围分别开关
  const isGameSrc = (d) => d.uri.scheme === SCHEME;
  const linkOn = (d) => cfgOn(isGameSrc(d) ? 'linkSource' : 'linkProject');
  const gotoOn = (d) => cfgOn(isGameSrc(d) ? 'gotoSource' : 'gotoProject');
  // 定义/悬浮沿用 SELECTOR（pattern + language 混用），再用 isSrcDoc 过滤。
  // 之前为了兼顾「工作区外的 .twee」只写 '*'，但实测第三方扩展的 pattern 选择器连自定义 scheme 的虚拟文档都能命中，
  // 说明 pattern 是按路径匹配、不受工作区限制，所以这里可以带 language 选择器：VSCode 按选择器为 provider 打分，
  // language 比纯 pattern 更靠前，这样在 .twee 里我们的定义才排在只按 pattern 注册的扩展（如 twee3）前面
  const DEF_SELECTOR = SELECTOR;

  // 自定义 scheme 的「转到定义」要靠内容提供者才能把文档打开（只注册 FileSystemProvider 时点不动、加载条一直转）；
  // 写入仍走 FileSystemProvider（两者可共存于同一 scheme）
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
    provideTextDocumentContent: (uri) => { const [k, key] = splitUri(uri); return entryContent(k, key); },
  }));

  // passage 虚拟文档打开时统一挂到 twee3 语言上，借它的语法高亮。
  // 语言 id 与 twee3 那些 provider 的选择器无关（它们只看路径 glob），所以这么做不会把干扰引回来。
  context.subscriptions.push(vscode.workspace.onDidOpenTextDocument((doc) => {
    if (doc.uri.scheme === SCHEME && doc.uri.path.startsWith('/passage/') && !doc.languageId.startsWith('twee'))
      vscode.languages.setTextDocumentLanguage(doc, 'twee3').then(undefined, () => {});
  }));

  // ---------- 搜索（类 VSCode 搜索面板） ----------
  const bodyOf = (g, key) => {
    const html = getHtml();
    if (!html) return '';
    if (g === 'js') {
      const f = index.jsFiles.find((x) => x.path === key) || index.jsFiles.find((x) => x.base === key);
      return f ? html.slice(f.start, f.end) : '';
    }
    const p = index.passages.find((x) => x.name === key);
    return p ? html.slice(p.bodyStart, p.bodyEnd) : '';
  };

  // 命中处 → 单行结果（截断到一行）
  function lineItem(body, i, len) {
    let s = i; while (s > 0 && body[s - 1] !== '\n') s--;
    let e = i; while (e < body.length && body[e] !== '\n') e++;
    const n = len || 0;
    return {
      line: (body.slice(0, s).match(/\n/g) || []).length + 1,
      pre: body.slice(Math.max(s, i - 90), i),
      match: body.slice(i, Math.min(i + n, e)),
      post: body.slice(i + n, Math.min(e, i + n + 90)),
      off: i, len: n,
    };
  }

  async function runSearch(q, opt) {
    q = (q || '').trim();
    const PER = 100;
    const page = Math.max(1, opt.page || 1);
    const want = page * PER;
    const out = { q, page, total: 0, more: false, groups: [], note: '' };
    const html = getHtml();
    if (!html || !index || !q) return out;
    const jsOn = opt.tj !== false, twOn = opt.tt !== false;
    const flat = [];
    // 多收集 1 条用于判断「还有更多」
    const push = (g, key, label, desc, item) => { if (flat.length <= want) flat.push({ g, key, label, desc, item }); };
    const full = () => flat.length > want;
    const pack = () => {
      out.more = flat.length > want;
      const slice = flat.slice((page - 1) * PER, Math.min(flat.length, want));
      const map = new Map();
      for (const r of slice) {
        const gk = r.g + '\n' + r.key;
        let grp = map.get(gk);
        if (!grp) { grp = { g: r.g, key: r.key, label: r.label, desc: r.desc, items: [] }; map.set(gk, grp); out.groups.push(grp); }
        grp.items.push(r.item);
      }
      out.total = slice.length;
      return out;
    };

    // 中文：先用翻译补丁反查英文原文，再定位源码
    if (/[\u4e00-\u9fff]/.test(q)) {
      const i18n = await resolveByGlob(cfg().get('i18nPath'), '**/i18n.json');
      if (!i18n) { out.note = '未找到翻译补丁 JSON，请先设置 atools4dol.i18nPath'; return out; }
      channel.appendLine('中文搜索：翻译补丁 = ' + i18n);
      const found = await searchI18n(i18n, q, want + 1);
      channel.appendLine(`中文搜索「${q}」→ 翻译条目 ${found.length} 条`);
      // 主行显示中文译文、次行保留英文原句；只标出命中的词，find 供中文模式下按译文重新定位选区
      out.cn = true;
      const cnItem = (it, cn, en) => {
        const at = cn.indexOf(q);
        it.pre = at > 0 ? cn.slice(0, at) : '';
        it.match = at >= 0 ? q : cn;
        it.post = at >= 0 ? cn.slice(at + q.length) : '';
        it.sub = en; it.find = cn; return it;
      };
      for (const h of found) {
        if (full()) break;
        if (h.pN !== undefined) {
          if (!twOn) continue;
          const p = index.passages.find((x) => x.name === h.pN);
          if (!p) continue;
          const body = bodyOf('passage', p.name);
          const i = h.f ? body.indexOf(String(h.f)) : -1;
          const it = i >= 0 ? lineItem(body, i, String(h.f).length)
            : { line: 0, pre: '', match: '', post: '', note: '由翻译条目定位（源码中由宏生成）' };
          push('passage', p.name, p.name, p.tags || 'passage',
            cnItem(it, String(h.t), it.pre + it.match + it.post || String(h.f).slice(0, 120)));
        } else {
          if (!jsOn) continue;
          const f = index.jsFiles.find((x) => x.base === h.fileName);
          if (!f) continue;
          const body = bodyOf('js', f.path);
          const i = h.f ? body.indexOf(String(h.f)) : -1;
          if (i < 0) continue;
          const it = lineItem(body, i, String(h.f).length);
          push('js', f.path, f.base, f.path, cnItem(it, String(h.t), it.pre + it.match + it.post));
        }
      }
      if (!flat.length) out.note = `翻译补丁中没有包含「${q}」的条目`;
      return pack();
    }

    // 英文/代码：直接搜正文；首次无结果时退化为「空白宽松」模糊匹配
    const collect = (loose) => {
      let rx = null;
      if (opt.re || loose) {
        const src = loose ? q.split(/\s+/).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*') : q;
        try { rx = new RegExp(src, opt.cs && !loose ? 'g' : 'gi'); } catch (_) { out.note = '正则表达式无效'; return; }
      }
      const needle = opt.cs && !loose ? q : q.toLowerCase();
      const each = (g, key, label, desc, body) => {
        if (rx) {
          rx.lastIndex = 0;
          let m;
          while ((m = rx.exec(body))) {
            if (!m[0]) { rx.lastIndex++; continue; }
            push(g, key, label, desc, lineItem(body, m.index, m[0].length));
            if (full()) return;
          }
        } else {
          const hay = opt.cs ? body : body.toLowerCase();
          let from = 0, at;
          while ((at = hay.indexOf(needle, from)) !== -1) {
            push(g, key, label, desc, lineItem(body, at, q.length));
            from = at + Math.max(q.length, 1);
            if (full()) break;
          }
        }
      };
      if (jsOn) for (const f of index.jsFiles) { if (full()) break; each('js', f.path, f.base, f.path, html.slice(f.start, f.end)); }
      if (twOn) for (const p of index.passages) { if (full()) break; each('passage', p.name, p.name, p.tags || 'passage', html.slice(p.bodyStart, p.bodyEnd)); }
    };
    collect(false);
    if (!flat.length && /\s/.test(q)) { collect(true); if (flat.length) out.note = '模糊匹配（忽略空白差异）'; }
    return pack();
  }

  let lastResult = null;
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('atools4dol.search', {
    resolveWebviewView(view) {
      view.webview.options = { enableScripts: true };
      view.webview.html = searchHtml();
      // 点开侧边栏就把光标放到搜索框
      view.onDidChangeVisibility(() => { if (view.visible) view.webview.postMessage({ type: 'focus' }); });
      view.webview.onDidReceiveMessage(async (m) => {
        if (m.type === 'ready') { if (lastResult) view.webview.postMessage(Object.assign({ type: 'result' }, lastResult)); view.webview.postMessage({ type: 'focus' }); return; }
        if (m.type === 'search') {
          lastResult = await runSearch(m.q, { cs: m.cs, re: m.re, tj: m.tj, tt: m.tt, page: m.page });
          view.webview.postMessage(Object.assign({ type: 'result' }, lastResult));
          return;
        }
        if (m.type === 'open') { if (m.cn) await setCn(true); await openEntry(m); }
      });
    },
  }));

  // 定义 → 目标位置：直接在原始 HTML 的偏移上数行号
  // 不在这里生成整篇正文：中文模式下对 JS 全量做翻译替换要几秒，Ctrl 悬停每次都会调，会一直转圈
  function defTarget(def) {
    if (!def) return null;
    const html = getHtml();
    if (!html) return null;
    let uri, start, off;
    if (def.type === 'passage') {
      const p = index.passages.find((x) => x.name === def.key);
      if (!p) return null;
      uri = passageUri(p.name);
      start = p.bodyStart;
    } else {
      const f = index.jsFiles.find((x) => x.base === (def.key || def.file));
      if (!f) return null;
      uri = jsUri(f.path);
      start = f.start;
    }
    off = Math.max(0, Math.min(def.offset - start, html.length - start));
    let line = 0, last = -1;
    for (let i = 0; i < off; i++) if (html.charCodeAt(start + i) === 10) { line++; last = i; }
    const character = off - last - 1;
    const pos = new vscode.Position(line, character);
    // 目标给 1 个字符宽（而不是零宽）：自定义 scheme 下 VSCode 对零宽目标可能不画下划线、不导航
    return { uri, pos, range: new vscode.Range(pos, new vscode.Position(line, character + 1)) };
  }

  // ---------- 补全 ----------
  // 排序分 = 静态频率 * W1 + 用户选择次数 * W2 * 时间衰减（半衰期 HALFLIFE 天）。
  // 静态频率保「项目里本来常用的」基础盘；选择次数只是微调；越久以前的误选权重越低，不会永久霸榜。
  const W1 = 1, W2 = 30, HALFLIFE = 14;
  const score = (n) => {
    let s = Math.min(freq.get(n) || 0, 9999999) * W1;
    const p = picks[n];
    if (p) s += Math.min(p.n || 0, 9999) * W2 * Math.pow(0.5, ((Date.now() - (p.t || 0)) / 86400000) / HALFLIFE);
    return s;
  };
  // 分越高 sortText 越小 → 越靠前
  const rank = (n) => String(9999999 - Math.min(Math.round(score(n)), 9999999)).padStart(7, '0');
  // 采纳补全项时累计一次使用次数（CompletionItem.command 在插入后执行）
  const PICK_CMD = 'atools4dol.pickCompletion';
  const withPick = (it, n) => { it.command = { command: PICK_CMD, title: '记录选择', arguments: [n] }; return it; };
  const docOf = (src, file) => new vscode.MarkdownString('```javascript\n' + src + '\n```' + (file ? '\n`' + file + '`' : ''));
  function items(names, kind, detail, defOf) {
    return names.map((n) => {
      const it = new vscode.CompletionItem(n, kind);
      it.detail = detail;
      it.sortText = rank(n);
      withPick(it, n);
      const d = defOf && defOf(n);
      if (d && d.src) it.documentation = docOf(d.src, d.file);
      return it;
    });
  }
  // 阻止编辑器把 V. / setup. 自动纠正成 VBArray. 之类的内置候选
  function keepWord(word, detail) {
    const it = new vscode.CompletionItem(word, vscode.CompletionItemKind.Variable);
    it.detail = detail;
    it.preselect = true;
    it.sortText = '\u0000';
    return [it];
  }

  context.subscriptions.push(vscode.languages.registerCompletionItemProvider(SELECTOR, {
    provideCompletionItems(document, position) {
      if (!projectActive || !index || !cfgOn('completion')) return;
      const line = document.lineAt(position.line).text.slice(0, position.character);
      const isTwee = isTweeDoc(document);
      if (isTwee && /<<[\w-]*$/.test(line)) {
        // if / for / widget 这些是 SugarCube 引擎内置宏，游戏源码里查不到定义，只有 BUILTIN_MACRO 有名单。
        // sortText 加 \u0001 前缀压过按频率排的 rank()，让它们排在原版宏前面。
        const builtin = [...BUILTIN_MACRO].map((n) => {
          const it = new vscode.CompletionItem(n, vscode.CompletionItemKind.Keyword);
          it.detail = '内置宏';
          it.sortText = '\u0001' + n;
          return it;
        });
        return builtin.concat(items([...index.macros, ...index.addMacros], vscode.CompletionItemKind.Function, '原版宏', (n) => index.macroDef[n]));
      }
      const ctx = setupCtx(line);
      if (ctx) {
        const kids = index.setupTree[ctx.base] || [];
        return kids.map((n) => {
          const full = ctx.base ? ctx.base + '.' + n : n;
          const d = index.setupAssign[full];
          const it = new vscode.CompletionItem(n, index.setupTree[full] ? vscode.CompletionItemKind.Module : vscode.CompletionItemKind.Property);
          it.detail = 'setup.' + full;
          it.sortText = rank(n);
          withPick(it, n);
          if (d) it.documentation = docOf(d.src, d.file);
          return it;
        });
      }
      if (isTwee && /(?:^|[^\w$])\$[\w]*$/.test(line)) {
        return items(index.variables, vscode.CompletionItemKind.Variable, '存档变量');
      }
      if (/(?:^|[^\w$.])V\.$/.test(line)) {
        return items(index.variables, vscode.CompletionItemKind.Variable, '存档变量');
      }
      // 成员位置（xxx. 或 xxx.部分名）交给其它 provider，避免污染对象成员补全
      if (/\.[\w$]*$/.test(line)) return [];
      // 最高优先级基础候选：输入 set 就能看到 setup，不必打完 5 个字母
      return [...keepWord('setup', 'SugarCube setup 对象'), ...keepWord('V', 'SugarCube 存档变量对象（V.xxx）')];
    },
  }, '<', '.', '$'));

  // 悬停卡片：定义所在文件 + 附近若干行（游戏源码走缓存 HTML，不额外读盘）
  function gameCard(def, t) {
    const html = getHtml();
    // passage 起点紧跟 <tw-passagedata …> 标签之后（同一行），此时从正文起始取，避免带出标签
    const atTag = html[def.offset - 1] === '>';
    const where = def.type === 'passage' ? '段落 ' + def.key : (def.file || def.key);
    return {
      file: `游戏源码 · ${where} · 第 ${t.pos.line + 1} 行`,
      lang: def.type === 'passage' ? 'twee3' : 'javascript',
      snippet: sliceAround(html, def.offset, atTag ? 0 : 2, 4, atTag),
    };
  }
  // 悬停卡片：工作区定义 → 相对路径 + 附近若干行（按 mtime 缓存读盘）
  function wsCard(wk, isTwee) {
    let snippet = '';
    if (wk.uri.scheme === 'file') {
      const lines = readText(wk.uri.fsPath).split(/\r?\n/);
      const ln = wk.pos.line;
      snippet = lines.slice(Math.max(0, ln - 2), ln + 5).join('\n').replace(/[ \t]+$/gm, '').slice(0, 1200);
    }
    return { file: `工作区 · ${vscode.workspace.asRelativePath(wk.uri)} · 第 ${wk.pos.line + 1} 行`, lang: isTwee ? 'twee3' : 'javascript', snippet };
  }

  // 源文档侧「可点击 / 画下划线」的范围：VSCode 用它决定 Ctrl 悬停时下划线画在哪一段文字上。
  // 纯计算：只用 lineAt + 正则，不读盘、不打开文档（Ctrl 悬停每次都会调用本函数）
  function getDefinitionOriginRange(document, position) {
    const line = document.lineAt(position.line).text;
    const col = position.character;
    // [[显示|段落]] / [[段落]] / [[显示->段落]] / [[段落<-显示]]：整段 [[...]]（含方括号）都算可点击区。
    // 不能只圈段落名：用 indexOf 找名字会被显示文本里的同名首字母骗到（[[B段落|B]] 会圈到「B段落」的 B），
    // 而且只圈名字时，点显示文本或「|」都落在链接范围之外，会回落到 DefinitionProvider 又撞上 twee3。
    const rl = /\[\[[^\]]+\]\]/g;
    let m;
    while ((m = rl.exec(line))) {
      const start = m.index;
      if (col <= start || col >= start + m[0].length) continue;
      return new vscode.Range(new vscode.Position(position.line, start), new vscode.Position(position.line, start + m[0].length));
    }
    // 宏名允许连字符（如 canvas-player-base-body），JS 里不要吞掉减号
    const range = document.getWordRangeAtPosition(position, isTweeDoc(document) ? /[A-Za-z_$][\w$-]*/ : /[A-Za-z_$][\w$]*/);
    if (range) return range;
    // 兜底：光标所在的那一个字符。绝不返回零宽范围——零宽时 VSCode 没有可下划线的文字
    if (col < line.length) return new vscode.Range(new vscode.Position(position.line, col), new vscode.Position(position.line, col + 1));
    return null;
  }

  // 光标处的定义目标，返回 { uri, pos, range, label }；Ctrl+点击与悬浮卡片共用
  // preview=true 时附带 file/snippet 供悬浮卡片展示；provideDefinition 传 false，保持纯函数、不做额外读盘
  function findDefAt(document, position, preview) {
    if (!index) { channel.appendLine('跳转定义：索引未就绪'); return null; }
    const line = document.lineAt(position.line).text;
    const col = position.character;
    // 光标落在 [[...]] 内（显示文本、|、段落名都算）→ 跳到链接的目标段落
    let m, pg;
    const rl = /\[\[([^\]]+)\]\]/g;
    while ((m = rl.exec(line)))
      if (col > m.index + 1 && col < m.index + 2 + m[1].length) { pg = linkTarget(m[1]); break; }
    // 宏名允许连字符（如 canvas-player-base-body），JS 里则不要吞掉减号
    const range = document.getWordRangeAtPosition(position, isTweeDoc(document) ? /[A-Za-z_$][\w$-]*/ : /[A-Za-z_$][\w$]*/);
    if (!range && !pg) return null;
    const word = range ? document.getText(range) : '';
    const before = line.slice(0, range ? range.start.character : col);
    const ctx = pg ? null : setupCtx(before);
    if (!pg && /\bV\.$/.test(before)) return null;
    const p = pg && index.passages.find((x) => x.name === pg);
    const def = p ? { type: 'passage', key: pg, offset: p.bodyStart }
      : pg ? null
        : (ctx ? index.setupAssign[ctx.base ? ctx.base + '.' + word : word]
          : (index.macroDef[word] || index.funcDef[word]));
    const one = (pos) => new vscode.Range(pos, new vscode.Position(pos.line, pos.character + 1));
    const t = defTarget(def);
    if (t) return Object.assign({ uri: t.uri, pos: t.pos, range: t.range, label: pg || word }, preview ? gameCard(def, t) : null);
    // 工作区 .twee/.js 里的定义是真实路径（这里不读盘，保持 provideDefinition 纯函数的约定）
    const wk = pg ? wsPassages.get(pg) : (wsMacros[word] || wsFuncs[word]);
    if (wk) return Object.assign({ uri: wk.uri, pos: wk.pos, range: one(wk.pos), label: pg || word }, preview ? wsCard(wk, !!pg) : null);
    return null;
  }

  // ---------- 跳转定义 ----------
  // provideDefinition 在「按住 Ctrl 悬停」时也会被调用：只做 getHtml（命中缓存）、正则、后台预热目标文档，
  // 绝不 showTextDocument（那会在悬停时直接跳走），也不能 await 加载（会拖慢返回、和首次点击抢跑 → 虚拟文档要点两下）
  context.subscriptions.push(vscode.languages.registerDefinitionProvider(DEF_SELECTOR, {
    async provideDefinition(document, position) {
      if (!gotoOn(document) || !isSrcDoc(document)) return;
      await ready;   // 同上：启动瞬间的空结果也会被缓存，Ctrl+点击就再也不跳
      if (!projectActive) return;
      const t = findDefAt(document, position);
      if (!t) return;
      // 源范围：必须给出一段有宽度的文字，VSCode 才会在 Ctrl 悬停时画下划线、才认这是一条可点击链接
      const origin = getDefinitionOriginRange(document, position);
      if (!origin) { channel.appendLine(`跳转定义 ${t.label}：光标处取不到可点击范围`); return; }
      // 目标是自定义 scheme 的虚拟文档：后台把它加载进来，否则点击时找不到目标文档。
      // 不 await：同步把 LocationLink 交出去，让加载与点击并行
      if (t.uri.scheme === SCHEME) vscode.workspace.openTextDocument(t.uri).then(undefined, (e) => channel.appendLine('跳转定义：打开目标失败 ' + e.message));
      // 返回 LocationLink（而不是 Location）：显式给出「下划线范围 + 目标范围」
      const target = t.range || new vscode.Range(t.pos, new vscode.Position(t.pos.line, t.pos.character + 1));
      return [{
        originSelectionRange: origin,
        targetUri: t.uri,
        targetRange: target,
        targetSelectionRange: target,
      }];
    },
  }));

  // ---------- 文档链接：Ctrl+点击优先走这条通道，绕开「多家 DefinitionProvider 汇总 → 弹选择框」 ----------
  // twee3 只注册了 definition/hover/documentSymbol，没有文档链接，所以这条通道是我们独占的。
  // 只在 findDefAt 能算出我们自己定义的位置生成链接，其余位置一概不碰；不自己再解析宏/段落。
  // 只扫含 [[ 或 << 的行，候选点取「<< 后紧跟的宏名」和「[[ ]] 里的段落名」，避免整篇遍历。
  // 链接目标用 command: URI：编辑器打开文档链接时会带 allowCommands:true，于是直接执行我们的
  // gotoDef 命令（带行号）。这样同一文件内的段落也能定位——若直接给出 t.uri，打开「已在前台的文档」
  // 不触发任何事件，光标补不上，点下去毫无反应。
  // 非全局，避免 test() 的 lastIndex 残留状态。
  const SCRIPT_BEGIN = /<<\s*script\b[^>]*>>/i;
  const SCRIPT_END = /<<\/\s*script\s*>>/i;
  context.subscriptions.push(vscode.languages.registerDocumentLinkProvider(SELECTOR, {
    async provideDocumentLinks(document, token) {
      if (!linkOn(document) || !isTweeDoc(document)) return;
      await ready;   // 等索引与工作区定义就绪：启动瞬间的空结果会被 VSCode 按文档版本缓存住
      if (token.isCancellationRequested || !projectActive || !index) return;
      const links = [];
      const seen = new Set();
      const add = (line, col) => {
        const pos = new vscode.Position(line, col);
        const t = findDefAt(document, pos);
        if (!t) return;
        const r = getDefinitionOriginRange(document, pos);
        if (!r || r.isEmpty) return;
        // 同一个范围内的多个候选点（如 [[ ]] 里的显示文本、|、段落名）落在同一个 range 上，按 range 去重
        const key = `${r.start.line}:${r.start.character}-${r.end.line}:${r.end.character}`;
        if (seen.has(key)) return;
        seen.add(key);
        const args = encodeURIComponent(JSON.stringify([t.uri.toString(), t.pos.line, t.pos.character]));
        links.push(new vscode.DocumentLink(r, vscode.Uri.parse('command:atools4dol.gotoDef?' + args)));
      };
      // <<script>> 块里是 JS（注释、字符串、位运算 << ...），里面的文字都不是宏引用，整块跳过
      let inScript = false;
      for (let i = 0; i < document.lineCount && !token.isCancellationRequested; i++) {
        let text = document.lineAt(i).text;
        if (inScript) { if (SCRIPT_END.test(text)) inScript = false; continue; }
        const so = text.match(SCRIPT_BEGIN);
        if (so) {
          if (!SCRIPT_END.test(text.slice(so.index + so[0].length))) inScript = true;
          text = text.slice(0, so.index);
        }
        if (text.indexOf('[[') < 0 && text.indexOf('<<') < 0) continue;
        let m;
        // 只认宏名（<< 后紧跟的那个词），并跳过内置宏。以前把宏体里每个词都拿去问 findDefAt，
        // 于是 <<set $x to 5>> 的 to、<<if a and b>> 的 and 都被当成「定义」画上下划线
        const rm = /<<([A-Za-z_$][\w$-]*)/g;
        while ((m = rm.exec(text))) if (!BUILTIN_MACRO.has(m[1])) add(i, m.index + 2);
        // 宏体里的函数调用（<<run fn()>> / <<set $x to fn()>>）：只在去掉注释和字符串的文本上找
        // 「紧跟着 (」的那个名字——to / and / if 这类词不会被卷进来，名字在 JS 里查不到定义就不画线
        const code = maskJsCode(text);
        const rb = /<<[^>]*>>/g;
        while ((m = rb.exec(code))) {
          const rc = /([A-Za-z_$][\w$]*)\(/g;
          let c;
          while ((c = rc.exec(m[0]))) if (!BUILTIN_MACRO.has(c[1])) add(i, m.index + c.index);
        }
        const rl = /\[\[[^\]]+\]\]/g;
        while ((m = rl.exec(text))) add(i, m.index + 2);
      }
      return links;
    },
  }));

  // 悬浮卡片：可点的「转到定义」+ 定义所在文件 + 附近代码预览（单击即可跳，绕开自定义 scheme 的跳转坑）
  context.subscriptions.push(vscode.languages.registerHoverProvider(DEF_SELECTOR, {
    provideHover(document, position) {
      if (!projectActive || !gotoOn(document) || !isSrcDoc(document)) return;
      const t = findDefAt(document, position, true);
      if (!t) return;
      const args = encodeURIComponent(JSON.stringify([t.uri.toString(), t.pos.line, t.pos.character]));
      const md = new vscode.MarkdownString();
      md.isTrusted = true;
      md.supportThemeIcons = true;
      md.appendMarkdown(`[转到定义：${String(t.label).replace(/[[\]()]/g, '')}](command:atools4dol.gotoDef?${args})`);
      if (t.file) md.appendMarkdown(`\n\n---\n\n$(file) \`${t.file}\``);
      if (t.snippet) {
        const fence = t.snippet.includes('```') ? '````' : '```';
        md.appendMarkdown(`\n\n${fence}${t.lang}\n${t.snippet}\n${fence}`);
      }
      return new vscode.Hover(md);
    },
  }));

  // ---------- twee 诊断：闭端配对 / 参数 / 重名 / 未定义的宏 / 段落 ----------
  const diag = vscode.languages.createDiagnosticCollection('atools4dol');
  // SugarCube v2 内置宏（按官方文档 macros 章节完整收录），避免误报「未定义的宏」。
  // 原版宏只能从游戏本体里找到 <<widget>> / Macro.add 的定义，引擎自带的这批不在其中，必须在这里列全。
  const BUILTIN_MACRO = new Set(('actions addclass append audio back break button cacheaudio capture case checkbox choice continue copy createaudiogroup createplaylist cycle default display do done else elseif endcapture for forget goto icon if include link linkappend linkprepend linkreplace linkshow listbox masteraudio move next nobr numberbox option options optionsfrom playlist prepend print radio radiobutton redo remember remove removeaudiogroup removeclass removeplaylist repeat replace return run script set setplaylist setting silent silently stop switch textarea textbox timed toggleclass track type unset version waitforaudio widget').split(' '));
  // 必须有闭端的容器宏。闭端有两种写法：<</if>> 和 <<endif>>，下面统一按容器名 pair。
  const CONTAINER_MACRO = new Set(('if for switch widget capture nobr silent silently timed repeat append prepend replace link linkappend linkprepend linkreplace button addinlineevent cycle listbox script createaudiogroup createplaylist').split(' '));
  // 闭端 token → 它闭合的容器宏名；不是闭端返回 null（slash 表示 <</if>> 这种写法）
  const closeMacro = (nm, slash) => {
    if (slash) return CONTAINER_MACRO.has(nm) ? nm : null;
    return nm.length > 3 && nm.startsWith('end') && CONTAINER_MACRO.has(nm.slice(3)) ? nm.slice(3) : null;
  };
  // 只对 twee 语言注册，避免抢在其它扩展前面占掉 on-type 格式化的触发器
  const TWEE_SELECTOR = [{ pattern: '**/*.twee' }, { language: 'twee3' }];
  let wsMacros = {}, wsFuncs = {}, wsPassages = new Map();
  const passageSets = new WeakMap();
  // 游戏源码里的段落（虚拟文档）
  const gamePassage = (n) => {
    if (!index) return false;
    let s = passageSets.get(index);
    if (!s) passageSets.set(index, s = new Set(index.passages.map((p) => p.name)));
    return s.has(n);
  };
  const knownPassage = (n) => wsPassages.has(n) || gamePassage(n);
  // 扫描工作区自定义的宏（<<widget>> / Macro.add / DefineMacro / statDisplay.create）与段落（:: 标题）
  async function scanWorkspaceDefs() {
    if (!projectActive) return;
    const macros = {}, funcs = {}, passages = new Map();
    const uris = await vscode.workspace.findFiles('**/*.{twee,js}', '**/node_modules/**', 3000);
    const defPos = (t, u, idx) => {
      const pre = t.slice(0, idx);
      return { uri: u, pos: new vscode.Position(pre.split('\n').length - 1, idx - pre.lastIndexOf('\n') - 1) };
    };
    // 记录定义所在文件与位置，供 Ctrl+点击跳转（同名只保留第一次出现的）
    const note = (map, t, u, nm, idx) => { if (nm && !map[nm]) map[nm] = defPos(t, u, idx); };
    for (const u of uris) {
      let t; try { if (fs.statSync(u.fsPath).size > 2e6) continue; t = fs.readFileSync(u.fsPath, 'utf8'); } catch (_) { continue; }
      let m;
      const rw = /<<widget\s+["']([^"']+)["']/g;
      while ((m = rw.exec(t))) note(macros, t, u, m[1], m.index);
      if (/\.js$/i.test(u.fsPath)) {
        // 同 buildIndex：注释里的文字不算定义，函数连字符串里的文字也不算
        const noCmt = maskJsComment(t), code = maskJsCode(t);
        const ra = /(?:Macro\.add|DefineMacroS?|statDisplay\.create)\(\s*["']([^"']+)["']/g;
        while ((m = ra.exec(noCmt))) note(macros, t, u, m[1], m.index);
        // <<run Obj.fn()>> 里的 Obj / fn 要能跳转：function 声明、xxx: function、xxx() { 方法简写、以及 Obj = { 命名空间赋值
        const rf = /(?:function\s+([A-Za-z_$][\w$]*)|([A-Za-z_$][\w$]*)\s*[:=]\s*(?:function\b|\([^)]*\)\s*=>)|^[ \t]*(?!function\b)([A-Za-z_$][\w$]*)\s*\([^;{}]*\)\s*\{|^[ \t]*(?:window\.)?([A-Za-z_$][\w$]*)\s*=\s*(?:\{|Object\.assign))/gm;
        while ((m = rf.exec(code))) {
          const nm = m[1] || m[2] || m[3] || m[4];
          if (!JS_KEYWORD.has(nm)) note(funcs, t, u, nm, m.index);
        }
      } else {
        const rp = /^::\s*([^\[\n]+)/gm;
        while ((m = rp.exec(t))) { const nm = m[1].trim(); if (nm && !passages.has(nm)) passages.set(nm, defPos(t, u, m.index)); }
      }
    }
    wsMacros = macros; wsFuncs = funcs; wsPassages = passages;
    channel.appendLine(`工作区定义：宏 ${Object.keys(macros).length}｜函数 ${Object.keys(funcs).length}｜段落 ${passages.size}`);
    for (const d of vscode.workspace.textDocuments) checkTwee(d);
  }

  function checkTwee(doc) {
    // 非 DoL 项目或关掉了语法检查时，清掉已有诊断并直接返回
    if (!projectActive || !cfgOn('diagnostics')) { if (doc) diag.delete(doc.uri); return; }
    // 虚拟源码文档是只读的已知正确内容，一律不做错误检查
    if (!doc || !isTweeDoc(doc) || doc.uri.scheme === SCHEME) return;
    // 用户自定义排除：命中的文件不做任何错误检查
    if (cfg().get('excludeGlobs').some((g) => vscode.languages.match({ pattern: g }, doc))) { diag.delete(doc.uri); return; }
    const raw = doc.getText();
    // 屏蔽后的文本：字符串 / 注释 / <<script>> 里的内容不参与识别，但下标与原文一一对应
    const text = maskTwee(raw);
    const ds = [];
    const R = (a, b) => new vscode.Range(doc.positionAt(a), doc.positionAt(b));
    const lineOf = (a) => doc.positionAt(a).line + 1;
    let m, m2;

    // 1) << 与 >> 是否配对
    const re = /<<|>>/g;
    let depth = 0, openAt = -1;
    while ((m = re.exec(text))) {
      if (m[0] === '<<') { if (depth === 0) openAt = m.index; depth++; }
      else if (depth > 0) depth--;
      else ds.push(new vscode.Diagnostic(R(m.index, m.index + 2), '多余的 >>：缺少与之配对的 <<', vscode.DiagnosticSeverity.Warning));
    }
    if (depth > 0) ds.push(new vscode.Diagnostic(R(openAt, openAt + 2), '未闭合的 <<：缺少与之配对的 >>', vscode.DiagnosticSeverity.Warning));

    // 2) 容器宏闭端配对 + 参数检查
    const stack = [];
    const ownW = new Set(), ownP = new Set(), seenP = new Map(), seenW = new Map();
    const tk = /<<\s*(\/?)\s*([A-Za-z_$][\w$-]*)[\s\S]*?>>/g;
    while ((m = tk.exec(text))) {
      const slash = m[1] === '/', nm = m[2];
      const at = m.index + m[0].indexOf(nm);
      // 参数检查必须看原文：屏蔽后的文本把字符串抹成了空格，<<widget "名">> 会读不出名称
      const tok = raw.slice(m.index, m.index + m[0].length);
      const body = tok.slice(tok.indexOf(nm) + nm.length, tok.length - 2);
      const close = closeMacro(nm, slash);
      if (close) {
        const top = stack.pop();
        if (!top) ds.push(new vscode.Diagnostic(R(at, at + nm.length), `多余的闭端 <<${slash ? '/' : ''}${nm}>>：没有与之配对的容器宏`, vscode.DiagnosticSeverity.Error));
        else if (top.macro !== close) ds.push(new vscode.Diagnostic(R(at, at + nm.length), `闭端不匹配：这里是关闭 ${close} 的闭端，但当前还没闭合的是 <<${top.macro}>>`, vscode.DiagnosticSeverity.Error));
        continue;
      }
      // <<else>> / <<elseif>> 必须在 <<if>> 结构里
      if (nm === 'else' || nm === 'elseif') {
        if (!stack.some((s) => s.macro === 'if')) ds.push(new vscode.Diagnostic(R(at, at + nm.length), `<<${nm}>> 不在 <<if>> 结构里`, vscode.DiagnosticSeverity.Error));
        else if (nm === 'elseif' && !body.trim()) ds.push(new vscode.Diagnostic(R(at, at + nm.length), '<<elseif>> 缺少条件表达式', vscode.DiagnosticSeverity.Error));
        continue;
      }
      // 参数检查：空条件 / 缺参数
      const arg = body.trim();
      if (nm === 'set') {
        if (!/\bto\b|[+\-*/%]?=|\+\+|--/.test(body)) ds.push(new vscode.Diagnostic(R(at, at + nm.length), '<<set>> 缺少赋值，应为 <<set $变量 to 值>>', vscode.DiagnosticSeverity.Warning));
      } else if (nm === 'widget') {
        const q = /^["']([^"']+)["']/.exec(arg);
        if (!q) ds.push(new vscode.Diagnostic(R(at, at + nm.length), '<<widget>> 缺少名称，应为 <<widget "名称">>', vscode.DiagnosticSeverity.Error));
        else {
          ownW.add(q[1]);
          if (seenW.has(q[1])) ds.push(new vscode.Diagnostic(R(at, at + nm.length), `widget 重名：<<widget "${q[1]}">> 已在本文件第 ${seenW.get(q[1])} 行定义`, vscode.DiagnosticSeverity.Warning));
          else seenW.set(q[1], lineOf(at));
        }
      } else if (!arg && (nm === 'if' || nm === 'switch')) {
        ds.push(new vscode.Diagnostic(R(at, at + nm.length), `无法找到 <<${nm}>> 的条件表达式`, vscode.DiagnosticSeverity.Error));
      } else if (!arg && nm === 'for') {
        ds.push(new vscode.Diagnostic(R(at, at + nm.length), '无法找到 <<for>> 的循环参数', vscode.DiagnosticSeverity.Error));
      }
      if (CONTAINER_MACRO.has(nm)) stack.push({ macro: nm, at, len: nm.length });
    }
    for (const s of stack) {
      const d = new vscode.Diagnostic(R(s.at, s.at + s.len), `无法找到 <<${s.macro}>> 的结束标签，可能需要 "<</${s.macro}>>"`, vscode.DiagnosticSeverity.Error);
      d.code = 'atools4dol.missingClose:' + s.macro; // 供快速修复取宏名
      ds.push(d);
    }

    // 3) 段落重名（widget 的重名与收集在上一轮 token 里一起做了）
    const rp = /^::\s*([^\[\n]+)/gm;
    while ((m2 = rp.exec(text))) {
      const nm = m2[1].trim();
      if (!nm) continue;
      const at = m2.index + m2[0].indexOf(nm);
      ownP.add(nm);
      if (seenP.has(nm)) ds.push(new vscode.Diagnostic(R(at, at + nm.length), `段落重名：${nm} 已在本文件第 ${seenP.get(nm)} 行定义`, vscode.DiagnosticSeverity.Warning));
      else seenP.set(nm, lineOf(at));
    }

    // 4) 未定义的宏 / 不存在的段落（需要游戏源码索引才判断）
    if (index) {
      const rx = /<<\s*([A-Za-z_$][\w$-]*)/g;
      while ((m2 = rx.exec(text))) {
        const n = m2[1];
        // 闭端名（endif / endfor …）不是「被调用的宏」，单独跳过，否则会被误报成未定义
        if (BUILTIN_MACRO.has(n) || closeMacro(n, false) || ownW.has(n) || wsMacros[n] || index.macroDef[n]) continue;
        const at = m2.index + m2[0].length - n.length;
        ds.push(new vscode.Diagnostic(R(at, at + n.length), `未定义的宏 <<${n}>>（原版宏和 <<widget>> 里都没有找到）`, vscode.DiagnosticSeverity.Error));
      }

      const rl = /\[\[([^\]]+)\]\]/g;
      while ((m2 = rl.exec(text))) {
        const t = linkTarget(m2[1]);
        if (!t || /^(https?:|mailto:|javascript:|#|[\$_])/i.test(t) || ownP.has(t) || knownPassage(t)) continue;
        ds.push(new vscode.Diagnostic(R(m2.index, m2.index + m2[0].length), `段落不存在：${t}`, vscode.DiagnosticSeverity.Error));
      }
    }
    diag.set(doc.uri, ds);
  }

  // 缺少闭端的快速修复：插入点取「本段落末尾」= 下一个 :: 段落头之前，没有就文件末尾
  const paraEnd = (doc, line) => {
    for (let i = line + 1; i < doc.lineCount; i++) if (/^::/.test(doc.lineAt(i).text)) return i;
    return doc.lineCount;
  };
  context.subscriptions.push(vscode.languages.registerCodeActionsProvider(TWEE_SELECTOR, {
    provideCodeActions(document, range, ctx) {
      if (!projectActive || !cfgOn('diagnostics')) return;
      const out = [];
      for (const d of ctx.diagnostics) {
        const code = d.code && typeof d.code === 'object' ? d.code.value : d.code;
        if (typeof code !== 'string' || !code.startsWith('atools4dol.missingClose:')) continue;
        const nm = code.slice('atools4dol.missingClose:'.length);
        // 用 <</if>> 这种写法：SugarCube 对任何容器宏都认，<<endif>> 只是部分宏的别名
        const txt = `<</${nm}>>`;
        const end = paraEnd(document, d.range.start.line);
        const atEnd = end >= document.lineCount;
        const pos = atEnd ? document.lineAt(document.lineCount - 1).range.end : new vscode.Position(end, 0);
        const act = new vscode.CodeAction(`补上 ${txt}（加在本段落末尾）`, vscode.CodeActionKind.QuickFix);
        act.diagnostics = [d];
        act.isPreferred = true;
        act.edit = new vscode.WorkspaceEdit();
        act.edit.insert(document.uri, pos, atEnd ? `\n\n${txt}` : `${txt}\n\n`);
        out.push(act);
      }
      return out;
    },
  }));

  // 输入宏名后的空格时自动补闭端。不能再用「输入 > 触发」：VSCode / twee3 会把 << 自动配对成 <</>>，
  // 用户根本敲不到那个 >，on-type 永远不触发（且 on-type 还依赖 formatOnType 与 provider 顺序）。
  // 改成监听「<<宏名 + 空格」的输入事件，两种情况都覆盖。
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((e) => {
    if (!projectActive || !cfgOn('autoClose') || e.document.isReadOnly) return;
    if (!isTweeDoc(e.document) || e.contentChanges.length !== 1) return;
    const c = e.contentChanges[0];
    if (c.text !== ' ' || !c.range.isEmpty) return;
    const ed = vscode.window.visibleTextEditors.find((x) => x.document === e.document);
    if (!ed) return;
    const line = e.document.lineAt(c.range.start.line);
    const end = c.range.start.character + 1;               // 刚输入的这个空格之后
    // 空格必须紧跟在宏名之后：<<if $a 里那个空格不算
    const m = /<<\s*([A-Za-z_$][\w$-]*)\s$/.exec(line.text.slice(0, end));
    if (!m || !CONTAINER_MACRO.has(m[1])) return;
    const nm = m[1];
    // 行尾已有 >>（自动配对）时只补闭端；没有就顺手把开宏一起闭合，保证补完就能跑
    const closed = /^>>/.test(line.text.slice(end).trimStart());
    ed.edit((b) => b.insert(line.range.end, `${closed ? '' : '>>'}\n<</${nm}>>`));
  }));
  // 排除检查：资源管理器右键加入 excludeGlobs
  const addExclude = (uri, isDir) => {
    if (!uri) return Promise.resolve();
    const g = '**/' + vscode.workspace.asRelativePath(uri) + (isDir ? '/**' : '');
    const c = cfg(), cur = c.get('excludeGlobs') || [];
    return cur.includes(g) ? Promise.resolve()
      : c.update('excludeGlobs', [...cur, g], vscode.ConfigurationTarget.Workspace)
        .then(() => channel.appendLine('已排除检查: ' + g), (e) => vscode.window.showErrorMessage('写入设置失败: ' + e.message));
  };
  context.subscriptions.push(diag,
    vscode.commands.registerCommand('atools4dol.excludeFile', (uri) => addExclude(uri, false)),
    vscode.commands.registerCommand('atools4dol.excludeFolder', (uri) => addExclude(uri, true)),
    vscode.commands.registerCommand('atools4dol.openExcludeSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', 'atools4dol.excludeGlobs')),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('atools4dol.excludeGlobs') || e.affectsConfiguration('atools4dol.diagnostics'))
        for (const d of vscode.workspace.textDocuments) checkTwee(d);
    }),
    vscode.workspace.onDidOpenTextDocument(checkTwee),
    vscode.workspace.onDidChangeTextDocument((e) => checkTwee(e.document)),
    vscode.workspace.onDidCloseTextDocument((d) => diag.delete(d.uri)),
    vscode.workspace.onDidSaveTextDocument((d) => { if (isTweeDoc(d) || /\.js$/i.test(d.uri.path)) scanWorkspaceDefs(); }),
    // 输入中文人民币符号 ￥ / ¥ 自动替换成设定的货币符号（单次输入事件、插入的正好是一个该字符才处理）
    vscode.workspace.onDidChangeTextDocument((e) => {
      const cur = cfg().get('yenTo');                       // off / gbp / usd
      const sym = cur === 'gbp' ? '£' : cur === 'usd' ? '$' : '';
      if (!projectActive || !sym || e.document.isReadOnly) return;
      if (!isSrcDoc(e.document) || e.contentChanges.length !== 1) return;
      const c = e.contentChanges[0];
      if (c.text !== '￥' && c.text !== '¥') return;
      const ed = vscode.window.visibleTextEditors.find((x) => x.document === e.document);
      if (!ed) return;
      const p = c.range.start;
      ed.edit((b) => b.replace(new vscode.Range(p, new vscode.Position(p.line, p.character + 1)), sym));
    })
  );

  // ---------- 汉化反查 ----------
  async function findInSource() {
    const ed = vscode.window.activeTextEditor;
    let q = ed && !ed.selection.isEmpty ? ed.document.getText(ed.selection) : undefined;
    if (!q) q = await vscode.window.showInputBox({ prompt: '输入中文（或英文）片段，反查游戏源码位置' });
    q = (q || '').trim();
    if (!q) return;
    const i18n = await resolveByGlob(cfg().get('i18nPath'), '**/i18n.json');
    if (!i18n) { vscode.window.showWarningMessage('ATool：未找到汉化数据 JSON，请设置 atools4dol.i18nPath'); return; }
    const hits = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'ATool：检索汉化数据…' },
      () => searchI18n(i18n, q)
    );
    if (!hits.length) { vscode.window.showInformationMessage(`未找到包含「${q}」的条目`); return; }
    const pick = await vscode.window.showQuickPick(
      hits.map((h) => ({
        label: h.t, description: h.pN !== undefined ? ('passage: ' + h.pN) : h.fileName,
        detail: '英文原文: ' + String(h.f).slice(0, 120), hit: h,
      })),
      { placeHolder: `命中 ${hits.length} 条（选择后跳到源码位置）`, matchOnDetail: true }
    );
    if (pick) await revealHit(pick.hit);
  }

  async function revealHit(h) {
    if (!index) return;
    let ed = null;
    if (h.pN !== undefined) {
      const p = index.passages.find((x) => x.name === h.pN);
      if (p) ed = await openEntry({ g: 'passage', key: p.name, label: p.name, desc: p.tags });
    } else if (h.fileName) {
      const f = index.jsFiles.find((x) => x.base === h.fileName);
      if (f) ed = await openEntry({ g: 'js', key: f.path, label: f.base, desc: f.path });
    }
    if (!ed) { channel.appendLine('未定位到源码文件：' + JSON.stringify(h)); return; }
    const text = ed.document.getText();
    let i = String(h.f) ? text.indexOf(String(h.f)) : -1;
    if (i < 0 && h.pos !== undefined && Number(h.pos) < text.length) i = Number(h.pos);
    if (i >= 0) {
      const s = ed.document.positionAt(i);
      const e = ed.document.positionAt(i + (String(h.f).length || 1));
      ed.selection = new vscode.Selection(s, e);
      ed.revealRange(new vscode.Range(s, e), vscode.TextEditorRevealType.InCenter);
    }
  }

  // ---------- 转为文件替换（TweeReplacer replaceFile） ----------
  // 撤销该 passage 的全部改动，恢复成游戏原文（同时删掉 boot.json 里该条目的 ATool 补丁 / 文件替换条目）
  async function undoEdit(uri) {
    const [kind, key] = splitUri(uri);
    const raw = rawContent(kind, key);
    if (!raw) return;
    const doc = await vscode.workspace.openTextDocument(uri);
    const we = new vscode.WorkspaceEdit();
    we.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), raw);
    await vscode.workspace.applyEdit(we);          // 先把编辑器缓冲区还原，避免脏缓冲区与外部刷新冲突
    await saveEntry(uri, Buffer.from(raw, 'utf8')); // 再落盘：命中 next === raw → dropEntry 清理条目
    refreshDecor();
  }

  // 把该 passage 当前的改动从内联补丁转成文件替换：内容写进文件，boot.json 换成 TweeReplacer 条目
  async function saveAsFile(uri) {
    const doc = await vscode.workspace.openTextDocument(uri);
    const [kind, key] = splitUri(uri);
    if (kind !== 'passage') { vscode.window.showWarningMessage('ATool：只有 passage 支持「保存为文件」'); return; }
    const tk = txKeyOf(kind, key);
    const raw = rawContent(kind, key);
    if (!raw) return;
    const next = doc.getText();
    if (next === raw) { vscode.window.showWarningMessage('ATool：该 passage 没有改动'); return; }
    let p = 0; const lim = Math.min(raw.length, next.length);
    while (p < lim && raw[p] === next[p]) p++;
    let s = 0;
    while (s < lim - p && raw[raw.length - 1 - s] === next[next.length - 1 - s]) s++;
    let ss = p, se = raw.length - s;
    if (se <= ss) { if (ss > 0) ss--; else se = Math.min(ss + 1, raw.length); }
    const a = findUniqueAnchor(raw, ss, se, maskFor(kind, tk, raw, false), true);
    if (!a.ok) { vscode.window.showWarningMessage('ATool：无法生成安全锚点（' + a.reason + '），未转为文件替换。'); return; }
    const from = a.anchor;
    const to = raw.slice(a.anchorStart, p) + next.slice(p, next.length - s) + raw.slice(raw.length - s, a.anchorEnd);

    const rel = await vscode.window.showInputBox({
      prompt: 'replaceFile 路径（相对 boot.json 目录）',
      value: 'patches/' + tk.replace(/[\\/:*?"<>|]/g, '_') + '.twee',
      validateInput: (v) => (!v || path.isAbsolute(v) ? '请填一个相对路径' : null),
    });
    if (rel === undefined) return;
    const d = bootDir();
    if (!d) { vscode.window.showErrorMessage('ATool：没有 boot.json，无法确定文件位置'); return; }
    const abs = path.join(d, rel.trim());
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, to);
    } catch (e) { vscode.window.showErrorMessage('ATool：写入失败 ' + e.message); return; }
    await convertToFileEntry(tk, from, rel.trim());
    delete patches['passage:' + tk];
    await loadPatches();
    srcEpoch++;
    srcChange.fire([{ type: vscode.FileChangeType.Changed, uri }]);
    refreshDecor();
    vscode.window.showInformationMessage(`ATool：已转为文件替换 ${rel.trim()}`);
  }

  // 写入 boot.json：删掉该 passage 的 ATool 内联补丁，改为一条 TweeReplacer 文件替换
  async function convertToFileEntry(tk, from, rel) {
    const u = await findBoot();
    if (!u) { vscode.window.showErrorMessage('ATool：没有 boot.json'); return; }
    let data; try { data = JSON.parse(fs.readFileSync(u.fsPath, 'utf8')); } catch (e) { vscode.window.showErrorMessage('ATool：boot.json 解析失败 ' + e.message); return; }
    const list = (data.addonPlugin = data.addonPlugin || []);
    const rp = list.find((x) => x.modName === 'ReplacePatcher');
    if (rp && rp.params && Array.isArray(rp.params.twee)) {
      rp.params.twee = rp.params.twee.filter((x) => !(x && x._atool && String(x.passageName || '').replace(/\.twee$/i, '') === tk));
    }
    let tr = list.find((x) => x.addonName === 'TweeReplacerAddon' || x.modName === 'TweeReplacer');
    if (!tr) { tr = { modName: 'TweeReplacer', addonName: 'TweeReplacerAddon', modVersion: '^1.0.0', params: [] }; list.push(tr); }
    if (!Array.isArray(tr.params)) tr.params = [];
    tr.params = tr.params.filter((x) => !(x && x._atool && String(x.passage || '').replace(/\.twee$/i, '') === tk));
    tr.params.push({ passage: tk, findString: from, replaceFile: rel, _atool: true });
    fs.writeFileSync(u.fsPath, JSON.stringify(data, null, 2));
    channel.appendLine(`已写入文件替换：passage ${tk} → ${rel}`);
    vscode.commands.executeCommand('atools4dol.refreshBoot').then(undefined, () => {});
  }

  // ---------- 锚点生成 ----------
  async function makeReplacePatch() {
    const ed = vscode.window.activeTextEditor;
    if (!ed || ed.document.uri.scheme !== SCHEME) {
      vscode.window.showWarningMessage('ATool：请先在游戏源文档（ATool 打开的只读源码）中选中要锚定的原文');
      return;
    }
    if (ed.selection.isEmpty) { vscode.window.showWarningMessage('ATool：请先选中要作为锚点的原文'); return; }
    const parts = ed.document.uri.path.split('/');
    const kind = parts[1];
    const key = kind === 'js' ? parts.slice(2).join('/') : parts.slice(2).join('/').replace(/\.twee$/i, '');
    const content = ed.document.getText();
    const seedStart = ed.document.offsetAt(ed.selection.start);
    const seedEnd = ed.document.offsetAt(ed.selection.end);
    // 手动锚点：由 atools4dol.safeAnchor 开关决定是否套用安全锚点（虚拟 passage 自动生成时始终套用）
    const res = findUniqueAnchor(content, seedStart, seedEnd, cfgOn('safeAnchor') ? maskFor(kind, txKeyOf(kind, key), content, false) : undefined);
    if (!res.ok) { vscode.window.showErrorMessage('ATool：' + res.reason); return; }

    const mode = await vscode.window.showQuickPick(
      [
        { label: '替换', desc: '把锚点原文整体替换为剪贴板内容' },
        { label: '插入到之后', desc: '在选区之后插入剪贴板内容' },
        { label: '插入到之前', desc: '在选区之前插入剪贴板内容' },
      ],
      { placeHolder: '补丁模式（内容取自剪贴板）' }
    );
    if (!mode) return;
    const clip = await vscode.env.clipboard.readText();

    let to;
    if (mode.label === '替换') to = clip;
    else {
      const rel = (mode.label === '插入到之后' ? seedEnd : seedStart) - res.anchorStart;
      to = res.anchor.slice(0, rel) + clip + res.anchor.slice(rel);
    }
    const patch = kind === 'js'
      ? { fileName: path.posix.basename(key), from: res.anchor, to }
      : { passageName: key, from: res.anchor, to };

    const json = JSON.stringify(patch, null, 2);
    await vscode.env.clipboard.writeText(json);
    channel.appendLine('已生成补丁（已复制到剪贴板）:\n' + json);
    const global = (getHtml().split(res.anchor).length - 1);
    vscode.window.showInformationMessage(`补丁已生成并复制：锚点 ${res.anchor.length} 字符，全局出现 ${global} 次`);
  }

  // 未确认 DoL 项目（没有 boot.json）时，命令面板里的这些操作一律拒绝
  const requireProject = () => {
    if (projectActive) return true;
    vscode.window.showWarningMessage('ATools4DoL：未检测到 boot.json，请先在 boot 面板创建或选择目标项目');
    return false;
  };
  const whenProject = (fn) => (...a) => { if (requireProject()) return fn(...a); };

  context.subscriptions.push(
    vscode.commands.registerCommand('atools4dol.scanGameSource', whenProject(() => scan().then(() => tree.refresh()))),
    vscode.commands.registerCommand('atools4dol.findInSource', whenProject(findInSource)),
    vscode.commands.registerCommand('atools4dol.makeReplacePatch', whenProject(makeReplacePatch)),
    vscode.commands.registerCommand('atools4dol.pickGameSource', whenProject(pickGameSource)),
    vscode.commands.registerCommand('atools4dol.pickI18n', whenProject(pickI18n)),
    vscode.commands.registerCommand('atools4dol.openGameFile', whenProject(async () => revealFile(await resolveByGlob(cfg().get('gameSourcePath'), '**/Degrees of Lewdity.html'), '游戏源码 HTML'))),
    vscode.commands.registerCommand('atools4dol.openI18nFile', whenProject(async () => revealFile(await resolveByGlob(cfg().get('i18nPath'), '**/i18n.json'), '翻译补丁 JSON'))),
    vscode.commands.registerCommand('atools4dol.buildStats', whenProject(buildStats)),
    vscode.commands.registerCommand('atools4dol.toChinese', whenProject(() => setCn(true))),
    vscode.commands.registerCommand('atools4dol.toEnglish', whenProject(() => setCn(false))),
    vscode.commands.registerCommand('atools4dol.openSource', openEntry),
    vscode.commands.registerCommand('atools4dol.toggleFav', toggleFav),
    vscode.commands.registerCommand('atools4dol.filterSource', whenProject(filterSource)),
    vscode.commands.registerCommand('atools4dol.saveAsFile', whenProject(saveAsFile)),
    vscode.commands.registerCommand('atools4dol.undoEdit', whenProject(undoEdit)),
    vscode.commands.registerCommand('atools4dol.openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:needmeet.atools4dol')),
    // 补全项被采纳时累计一次（CompletionItem.command 在插入后执行），供加权排序使用
    vscode.commands.registerCommand(PICK_CMD, (n) => {
      if (!n) return;
      const r = picks[n] || (picks[n] = { n: 0, t: 0 });
      r.n++; r.t = Date.now();
      savePicks();
    }),
    // 悬浮卡片「转到定义」的落点：命令路径比自定义 scheme 的 Location 跳转可靠（源码树/搜索点开走的就是它）
    vscode.commands.registerCommand('atools4dol.gotoDef', async (u, line, ch) => {
      try {
        const uri = vscode.Uri.parse(u);
        // 目标已经在编辑器里显示时直接复用那个编辑器，不再调 showTextDocument：
        // 编辑组被锁定后，showTextDocument 会把这次「打开」重定向到右侧新建的组，
        // 而文件本身仍留在原组，右边就白多出一个空组（同文件段落必现）
        const active = vscode.window.activeTextEditor;
        const shown = active && active.document.uri.toString() === uri.toString()
          ? active
          : vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri.toString());
        const ed = shown || await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
        const p = new vscode.Position(line, ch);
        ed.selection = new vscode.Selection(p, p);
        ed.revealRange(new vscode.Range(p, p), vscode.TextEditorRevealType.InCenter);
        // 与搜索面板一致：游戏源码虚拟文档在源码树里同步展开并选中
        if (ed.document.uri.scheme === SCHEME) {
          const [g, key] = splitUri(ed.document.uri);
          revealInTree(g, g === 'passage' ? key.replace(/\.twee$/i, '') : key);
        }
      } catch (e) { vscode.window.showErrorMessage('ATool：打开定义失败 ' + e.message); }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('atools4dol.gameSourcePath')) scan().then(() => tree.refresh());
      if (e.affectsConfiguration('atools4dol.bootPath')) { bootUri = null; loadPatches(); }
    })
  );

  // 确认是 DoL 项目（存在 boot.json）后才启动索引扫描等重型初始化：
// 没有 boot.json 时这些功能全部禁用，也不该去读几十 MB 的游戏源码、更不该弹「未找到游戏源码」警告。
  let started = false;
  async function startProject() {
    if (started) return;
    started = true;
    try {
      await ensureIndex();
      // 预热游戏源码：索引命中磁盘缓存时 htmlCache 是冷的，第一次悬停/跳转才去读 54MB 并整篇解码，
      // 会同步卡住几秒 →「第一次 Ctrl 悬停没下划线、第一次点击不跳，第二次才生效」。
      // 放在任何 await 之前：这样即使后面某一步失败，预热也一定会发生。
      setTimeout(() => { try { getHtml(); } catch (_) {} }, 0);
      await loadPatches();
      tree.refresh();
      await scanWorkspaceDefs();
      // 频率字典为空时自动建立一次：这就是候选排序「内置字典」的数据来源
      if (!freq.size) await buildStats();
    } catch (e) { channel.appendLine('初始化失败: ' + e.message); }
    finally { markReady(); }
  }

  // extension.js 检测到 boot.json 后会调用 setProjectActive；这里同步状态栏按钮并在首次确认时启动初始化
  applyProjectActive = (on) => {
    syncCnItem();
    if (on) startProject();
    else { diag.clear(); markReady(); }
  };
}

module.exports = { registerGameData, setProjectActive, SCHEME, gameSource: () => gameAccess, _pure: { splitJsFiles, buildIndex, findUniqueAnchor, unsafeMask, searchI18n, loadI18nMap, normPath, srcLine, sliceAround, setupCtx, decodeSource } };