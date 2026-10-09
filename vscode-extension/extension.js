const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { packMod } = require('./packer');
const { startServer, pushZip, hasClient } = require('./server');
const { gameSource, setProjectActive } = require('./gamedata');

let bootInfo = null;
let outputChannel;

function getChannel() {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel('ATools4DoL');
  }
  return outputChannel;
}

// 工作区里可能有几十个模组的 boot.json：优先用 atools4dol.bootPath 指定的，否则取最近改动的那个
async function resolveBootPath() {
  const v = String(vscode.workspace.getConfiguration('atools4dol').get('bootPath') || '').trim();
  if (v && path.isAbsolute(v) && fs.existsSync(v)) return v;
  const uris = await vscode.workspace.findFiles(v || '**/boot.json', '**/node_modules/**', 30);
  let best = null, bestT = -1;
  for (const u of uris) { try { const t = fs.statSync(u.fsPath).mtimeMs; if (t > bestT) { bestT = t; best = u.fsPath; } } catch (_) {} }
  return best;
}

async function updateBootJsonContext() {
  const bootPath = await resolveBootPath();
  await vscode.commands.executeCommand('setContext', 'bootJsonPresent', !!bootPath);
  // 没有 boot.json 就不是（也不是）要开发的 DoL 项目：搜索 / 游戏源码面板与所有模组相关功能全部禁用
  setProjectActive(!!bootPath);

  if (!bootPath) {
    bootInfo = null;
    return;
  }

  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(bootPath, 'utf-8'));
  } catch {}

  bootInfo = {
    bootPath,
    baseDir: path.dirname(bootPath),
    modName: data.name || 'DoLMod',
    packName: data.packName || '',
    version: data.version || 'unknown',
    minify: data.minify === true,
  };
}

function getWorkspaceRoot() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || !folders.length) throw new Error('未打开工作区');
  return folders[0].uri.fsPath;
}

function buildConfig(workspaceRoot) {
  if (!bootInfo) throw new Error('未找到 boot.json');
  return {
    source: bootInfo.baseDir,                       // 绝对路径
    output: workspaceRoot,
    modName: bootInfo.modName,
    imgDir: 'img',                                  // 固定 img
    minify: bootInfo.minify,                        // 由 boot.json 决定
    updateBoot: true,                               // 始终更新
  };
}

// 纯打包逻辑（不含弹窗），返回打包结果供打包/推送复用
async function doPack(channel) {
  const cfg = buildConfig(getWorkspaceRoot());
  channel.appendLine("version: " + bootInfo.version);
  channel.appendLine("minify : " + cfg.minify);
  channel.appendLine("filenam: " + (bootInfo.packName || `${cfg.modName}-v${bootInfo.version}.mod.zip`));   // packName 是模板，实际文件名以 packMod 输出为准
  channel.appendLine("==================");

  const result = await packMod(cfg, getWorkspaceRoot(), (m) => channel.appendLine(m));

  channel.appendLine("");
  channel.appendLine("  ███╗   ██╗███████╗███████╗██████╗ ███╗   ███╗███████╗███████╗████████╗");
  channel.appendLine("  ████╗  ██║██╔════╝██╔════╝██╔══██╗████╗ ████║██╔════╝██╔════╝╚══██╔══╝");
  channel.appendLine("  ██╔██╗ ██║█████╗  █████╗  ██║  ██║██╔████╔██║█████╗  █████╗     ██║   ");
  channel.appendLine("  ██║╚██╗██║██╔══╝  ██╔══╝  ██║  ██║██║╚██╔╝██║██╔══╝  ██╔══╝     ██║   ");
  channel.appendLine("  ██║ ╚████║███████╗███████╗██████╔╝██║ ╚═╝ ██║███████╗███████╗   ██║   ");
  channel.appendLine("  ╚═╝  ╚═══╝╚══════╝╚══════╝╚═════╝ ╚═╝     ╚═╝╚══════╝╚══════╝   ╚═╝   ");
  channel.appendLine("");
  return result;
}

async function runPack() {
  const channel = getChannel();
  channel.clear();
  channel.show(true);

  try {
    const result = await doPack(channel);
    const action = await vscode.window.showInformationMessage(
      `打包完成: ${path.basename(result.zipPath)}`,
      '打开输出目录'
    );
    if (action === '打开输出目录') {
      vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(result.zipPath));
    }
  } catch (e) {
    channel.appendLine(`错误: ${e.message}`);
    vscode.window.showErrorMessage(`打包失败: ${e.message}`);
  }
}

async function openGame() {
  const v = String(vscode.workspace.getConfiguration('atools4dol').get('gameSourcePath') || '').trim();
  let p = v && path.isAbsolute(v) && fs.existsSync(v) ? v : null;
  if (!p) {
    const uris = await vscode.workspace.findFiles(v || '**/Degrees of Lewdity.html', '**/node_modules/**', 5);
    if (uris.length) p = uris[0].fsPath;
  }
  if (!p) {
    vscode.window.showWarningMessage('ATool：未找到游戏 HTML，请先设置 atools4dol.gameSourcePath');
    return;
  }
  await vscode.env.openExternal(vscode.Uri.file(p));
}

async function runPush() {
  const channel = getChannel();
  channel.clear();
  channel.show(true);

  try {
    if (!hasClient()) {
      const action = await vscode.window.showWarningMessage(
        '游戏未连接，请先打开游戏并确认 ATools4DoL 接收模组已加载',
        '打开游戏'
      );
      if (action === '打开游戏') await openGame();
      return;
    }

    const result = await doPack(channel);
    channel.appendLine(`推送到游戏: ${path.basename(result.zipPath)}`);
    await pushZip(result.zipPath, { name: bootInfo.modName, version: bootInfo.version });
    channel.appendLine('已推送，等待游戏安装并自动重载');
    vscode.window.showInformationMessage('已推送到游戏，游戏将自动重载');
  } catch (e) {
    channel.appendLine(`推送失败: ${e.message}`);
    vscode.window.showErrorMessage(`推送失败: ${e.message}`);
  }
}

// 右下角连接状态：游戏连上且当前是模组项目才显示；点击 = 打包并推送（runPush 内部已做「已连接」判断）
function registerConnStatus(context) {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  item.command = 'atools4dol.push';
  item.text = '$(circle-filled) 已连接';
  item.tooltip = 'ATools4DoL：游戏已连接，点击打包并推送';
  item.color = new vscode.ThemeColor('charts.green');
  context.subscriptions.push(item);

  // hasClient() 是同步的，轮询最省事；1s 一次开销可忽略
  const sync = () => { if (bootInfo && hasClient()) item.show(); else item.hide(); };
  const timer = setInterval(sync, 1000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
  sync();
}

// ---------------- boot.json 可视化编辑（活动栏 Webview） ----------------
let bootView = null;

// 依赖表自动补全：已知插件模组 → addonName（统计自工作区各模组的 boot.json）
const KNOWN_PLUGINS = {
  TweeReplacer: 'TweeReplacerAddon',
  ReplacePatcher: 'ReplacePatcherAddon',
  I18nTweeReplacer: 'I18nTweeReplacerAddon',
  'ModLoader DoL ImageLoaderHook': 'ImageLoaderAddon',
  BeautySelectorAddon: 'BeautySelectorAddon',
  DoLTimeWrapperAddon: 'DoLTimeWrapperAddon',
  ModdedFeatsAddon: 'ModdedFeatsAddon',
  maplebirch: 'maplebirchAddon',
  ModLoader: '',
  GameVersion: '',
  SweetAlert2Mod: '',
};

// 各列表的自动扫描后缀；scriptFileList_inject_early 等交给用户手填
const SCANS = { img: /\.(png|jpe?g|gif|webp|bmp|psd|svg|avif)$/i, css: /\.css$/i, js: /\.js$/i, twee: /\.twee$/i, all: /./ };
const SCAN_OF = { styleFileList: 'css', scriptFileList: 'js', tweeFileList: 'twee', imgFileList: 'img' };
// 「文件替换」路径补全：只列 twee / txt
const FILE_COMPLETION = /\.(twee|txt)$/i;

function scanFiles(dir, re) {
  const out = [];
  const walk = (d) => {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '.git') walk(path.join(d, e.name)); }
      else if (re.test(e.name)) out.push(path.relative(dir, path.join(d, e.name)).split(path.sep).join('/'));
    }
  };
  walk(dir);
  return out.sort();
}

// 工作区里没有 boot.json 时用来创建一个含全部默认键的文件
const DEFAULT_BOOT = {
  name: '', nickName: '', packName: '', version: '1.0.0', minify: false,
  styleFileList: [], scriptFileList: [], scriptFileList_earlyload: [], scriptFileList_inject_early: [],
  scriptFileList_preload: [], tweeFileList: [], imgFileList: [], additionFile: [],
  addonPlugin: [
    { modName: 'BeautySelectorAddon', addonName: 'BeautySelectorAddon', modVersion: '^2.0.0', params: { type: '(请确保启用此图包) 模组名称' } },
    { modName: 'ReplacePatcher', addonName: 'ReplacePatcherAddon', modVersion: '^1.0.0', params: { js: [], twee: [] } },
  ],
  dependenceInfo: [
    { modName: 'GameVersion', version: '^0.5.10.12' },
    { modName: 'ModLoader', version: '^2.31.2' },
    { modName: 'BeautySelectorAddon', version: '^2.0.0' },
    { modName: 'ReplacePatcher', version: '^1.0.0' },
  ],
};

async function createBoot() {
  let root;
  try { root = getWorkspaceRoot(); } catch (e) { vscode.window.showErrorMessage('ATool：' + e.message); return; }
  const p = path.join(root, 'boot.json');
  if (fs.existsSync(p)) { vscode.window.showWarningMessage('ATool：已存在 ' + p); return; }
  try { fs.writeFileSync(p, JSON.stringify(DEFAULT_BOOT, null, 2)); } catch (e) { vscode.window.showErrorMessage('创建失败：' + e.message); return; }
  await vscode.workspace.getConfiguration('atools4dol').update('bootPath', p, vscode.ConfigurationTarget.Workspace);
  await updateBootJsonContext();
  refreshBootView();
}

async function loadBootForView() {
  const p = await resolveBootPath();
  if (!p) return { ok: false, none: true, path: '工作区里没有 boot.json（点标题栏的「选择 boot」或直接创建）', data: {} };
  try { return { ok: true, path: p, data: JSON.parse(fs.readFileSync(p, 'utf8')) }; }
  catch (e) { return { ok: false, path: p + '（解析失败：' + e.message + '）', data: {} }; }
}

function refreshBootView() {
  if (!bootView) return;
  loadBootForView().then((r) => {
    if (!bootView) return;
    bootView.webview.options = { enableScripts: true, localResourceRoots: bootRoots(r.ok ? path.dirname(r.path) : null) };
    bootView.webview.postMessage({ type: 'load', ok: r.ok, none: r.none, path: r.path, data: r.data });
  });
}

// 校验 TweeReplacer / ReplacePatcher 的锚点能否命中游戏源码；返回 {键路径: 提示}，命中为红框
// 键路径与 webview 里 data-k 一致：addonPlugin.<i>.params[…].<字段>
async function validateBoot(data) {
  const errs = {};
  const plugins = Array.isArray(data && data.addonPlugin) ? data.addonPlugin : [];
  if (!plugins.some((p) => p && (p.addonName === 'TweeReplacerAddon' || p.addonName === 'ReplacePatcherAddon'))) return errs;
  const acc = gameSource();
  if (!acc) return errs;
  try { await acc.ensure(); } catch (_) { return errs; }
  const bootPath = await resolveBootPath();
  const baseDir = bootPath ? path.dirname(bootPath) : '';
  // 只校验 twee / txt 两类替换文件；其它后缀一律不检查
  const missingFile = (rel) => baseDir && rel && /\.(twee|txt)$/i.test(rel) && !fs.existsSync(path.join(baseDir, rel));

  plugins.forEach((p, i) => {
    if (!p || !p.params) return;
    if (p.addonName === 'TweeReplacerAddon') {
      (Array.isArray(p.params) ? p.params : []).forEach((it, j) => {
        if (!it || typeof it !== 'object') return;
        const base = 'addonPlugin.' + i + '.params.' + j;
        const name = String(it.passage || '').trim();
        if (!name) { errs[base + '.passage'] = '未填写 passage'; return; }
        if (!acc.has('passage', name)) { errs[base + '.passage'] = '游戏源码中找不到该 passage'; return; }
        const body = acc.content('passage', name);
        // 按「键是否存在」判定匹配方式（与界面上的切换开关一致），空值即报未填写
        if ('findRegex' in it) {
          if (!it.findRegex) { errs[base + '.findRegex'] = '未填写正则锚点'; return; }
          let re; try { re = new RegExp(it.findRegex, it.regexFlag || ''); }
          catch (e) { errs[base + '.findRegex'] = '正则语法错误：' + e.message; return; }
          if (!re.test(body)) errs[base + '.findRegex'] = '在该 passage 中未匹配到';
        } else {
          if (!it.findString) { errs[base + '.findString'] = '未填写锚点'; return; }
          if (!body.includes(it.findString)) errs[base + '.findString'] = '在该 passage 中未找到该锚点';
        }
        if (missingFile(it.replaceFile)) errs[base + '.replaceFile'] = '替换文件不存在：' + it.replaceFile;
      });
    }
    if (p.addonName === 'ReplacePatcherAddon' && typeof p.params === 'object' && !Array.isArray(p.params)) {
      const check = (kind, list, nameField, tag) => {
        (Array.isArray(list) ? list : []).forEach((it, j) => {
          if (!it || typeof it !== 'object') return;
          const base = 'addonPlugin.' + i + '.params.' + tag + '.' + j;
          const name = String(it[nameField] || '').trim();
          if (!name) { errs[base + '.' + nameField] = '未填写' + (kind === 'js' ? '文件名' : ' passage'); return; }
          if (!acc.has(kind, name)) { errs[base + '.' + nameField] = '游戏源码中找不到该' + (kind === 'js' ? ' js 文件' : ' passage'); return; }
          if (!it.from) { errs[base + '.from'] = '未填写锚点 from'; return; }
          if (!acc.content(kind, name).includes(it.from)) errs[base + '.from'] = '在该' + (kind === 'js' ? '文件中' : ' passage 中') + '未找到该锚点';
        });
      };
      check('js', p.params.js, 'fileName', 'js');
      check('twee', p.params.twee, 'passageName', 'twee');
    }
  });
  return errs;
}

// 列出工作区所有 boot.json 供固定选择（不弹文件选择器）
async function pickBoot() {
  const uris = await vscode.workspace.findFiles('**/boot.json', '**/node_modules/**', 300);
  const cur = String(vscode.workspace.getConfiguration('atools4dol').get('bootPath') || '');
  const items = uris.map((u) => {
    let name = '', nick = '';
    try {
      const d = JSON.parse(fs.readFileSync(u.fsPath, 'utf8'));
      name = d.name || '';
      nick = typeof d.nickName === 'string' ? d.nickName : (d.nickName && d.nickName.cn) || '';
    } catch (_) {}
    return { label: name || path.basename(path.dirname(u.fsPath)), description: vscode.workspace.asRelativePath(u), detail: nick, fsPath: u.fsPath, picked: u.fsPath === cur };
  });
  items.sort((a, b) => (b.picked ? 1 : 0) - (a.picked ? 1 : 0) || a.description.localeCompare(b.description));
  const pick = await vscode.window.showQuickPick(items, { placeHolder: '选择要编辑/打包的 boot.json', matchOnDescription: true, matchOnDetail: true });
  if (!pick) return;
  await vscode.workspace.getConfiguration('atools4dol').update('bootPath', pick.fsPath, vscode.ConfigurationTarget.Workspace);
  await updateBootJsonContext();
  refreshBootView();
}

function bootFormHtml(csp) {
  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${csp} data:; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 6px; }
.hint { opacity:.7; margin: 3px 2px; word-break: break-all; }
/* z-index 要高于开关文字（.sw-t 是 z-index:1 的定位元素），否则滚动时开关文字会浮在底栏上面 */
.foot { position: sticky; bottom: 0; z-index: 2; display: flex; gap: 6px; align-items: center; padding: 6px; margin: 6px -6px -6px; background: var(--vscode-sideBar-background, var(--vscode-editor-background)); border-top: 1px solid var(--vscode-input-border, rgba(128,128,128,.35)); }
/* 按钮文案不换行；提示占满剩余宽度，超出省略号，悬浮看完整内容 */
.foot button { flex: 0 0 auto; white-space: nowrap; }
.foot #msg { flex: 1 1 auto; min-width: 0; margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
input[type=text], input[type=number], textarea { width: 100%; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); padding: 3px 6px; font-family: inherit; font-size: inherit; outline: none; }
textarea { font-family: var(--vscode-editor-font-family, monospace); resize: vertical; min-height: 44px; tab-size: 4; -moz-tab-size: 4; }
input:focus, textarea:focus { border-color: var(--vscode-focusBorder); }
input.bad, textarea.bad { border-color: var(--vscode-errorForeground); }
input[type=checkbox] { width: auto; }
button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 3px 8px; cursor: pointer; font-family: inherit; font-size: inherit; }
button:disabled { background: var(--vscode-button-secondaryBackground, rgba(128,128,128,.4)); color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); opacity: .6; cursor: default; }
button.sec { background: var(--vscode-input-background); color: var(--vscode-foreground); border: 1px solid var(--vscode-input-border, transparent); }
button.mini { padding: 0 5px; font-size: .9em; }
details.sec { border: 1px solid var(--vscode-input-border, rgba(128,128,128,.35)); margin: 4px 0; }
details.sec > summary { display: flex; align-items: center; gap: 4px; cursor: pointer; padding: 3px 6px; font-weight: 600; }
details.sec .body { padding: 4px 6px; }
details.sec summary::-webkit-details-marker { opacity: .6; }
.cnt { opacity: .6; font-weight: 400; margin-left: auto; }
.btns { display: flex; gap: 3px; margin-left: 4px; }
.card { border: 1px solid var(--vscode-input-border, rgba(128,128,128,.35)); padding: 2px 6px 6px; margin: 4px 0; }
/* 套在卡片里的卡片加一条蓝色左侧标：一眼能看出层级深浅 */
.card .card { border-left: 2px solid var(--vscode-focusBorder, var(--vscode-button-background)); }
/* 带标签的数组分组：只留左侧竖线，不再单独套一个方框 */
.group { margin: 4px 0 2px; padding-left: 6px; border-left: 2px solid var(--vscode-input-border, rgba(128,128,128,.35)); }
.card-h { display: flex; justify-content: space-between; align-items: center; opacity: .85; font-size: .9em; margin: 2px 0 4px; }
.item { display: flex; gap: 4px; margin: 2px 0; align-items: flex-start; position: relative; }
.item input, .item textarea { flex: 1; min-width: 0; }
.item input[type=checkbox] { flex: 0 0 auto; }
/* 图片预览：缩略图高度与输入框一致，宽度按原比例自适应；悬浮在原位放大看完整图 */
.item.imgrow { align-items: center; }
.item.imgrow img { flex: 0 0 auto; height: calc(1.3em + 8px); width: auto; max-width: 160px; object-fit: contain; background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); cursor: zoom-in; }
.item.imgrow img:hover { position: absolute; left: 0; top: 0; z-index: 20; height: auto; width: auto; max-height: 320px; max-width: 100%; object-fit: contain; background: var(--vscode-editor-background); border-color: var(--vscode-focusBorder); box-shadow: 0 3px 14px rgba(0,0,0,.55); }
.k { font-weight: 600; margin: 6px 2px 2px; display: block; }
.pk { opacity: .85; min-width: 86px; padding-top: 3px; }
/* 无圆角的左右切换开关：激活侧为蓝色主题色 */
.sw { position: relative; display: inline-flex; flex: 0 0 auto; min-width: 100px; border: 1px solid var(--vscode-input-border, rgba(128,128,128,.5)); background: var(--vscode-input-background); user-select: none; }
.sw-t { flex: 1 1 0; position: relative; z-index: 1; padding: 1px 10px; text-align: center; white-space: nowrap; cursor: pointer; font-size: .9em; }
.sw-k { position: absolute; top: 0; bottom: 0; left: 0; width: 50%; background: var(--vscode-button-background); transition: left .15s ease; }
.sw.on .sw-k { left: 50%; }
.sw-a, .sw-b { color: var(--vscode-foreground); }
.sw:not(.on) .sw-a, .sw.on .sw-b { color: var(--vscode-button-foreground); }
/* 未保存草稿的恢复模态框 */
.modal { position: fixed; inset: 0; z-index: 30; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,.45); }
.modal-box { background: var(--vscode-sideBar-background, var(--vscode-editor-background)); border: 1px solid var(--vscode-input-border, rgba(128,128,128,.5)); padding: 12px; max-width: 320px; box-shadow: 0 4px 18px rgba(0,0,0,.5); }
.modal-t { font-weight: 600; margin-bottom: 6px; }
.modal-m { margin-bottom: 10px; }
.modal-b { display: flex; gap: 6px; justify-content: flex-end; }
</style>
</head>
<body>
<div class="hint" id="p"></div>
<button id="cr" style="display:none">创建默认 boot.json</button>
<div id="f"></div>
<div id="modal" class="modal" style="display:none">
  <div class="modal-box">
    <div class="modal-t">检测到上次未保存的更改</div>
    <div class="modal-m">你在上次退出 boot 面板时有未保存的修改，是否恢复？</div>
    <div class="modal-b">
      <button id="mr" class="sec">恢复未保存的更改</button>
      <button id="md" class="sec">丢弃</button>
    </div>
  </div>
</div>
<div class="foot">
  <button id="sv" class="sec">保存到 boot.json</button>
  <button id="rl" class="sec">重新载入</button>
  <span class="hint" id="msg"></span>
</div>
<datalist id="dl-mod"></datalist>
<datalist id="dl-addon"></datalist>
<datalist id="dl-param"></datalist>
<datalist id="dl-file"></datalist>
<datalist id="dl-css"></datalist>
<datalist id="dl-js"></datalist>
<datalist id="dl-twee"></datalist>
<datalist id="dl-img"></datalist>
<datalist id="dl-all"></datalist>
<script>
const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
// 依赖表自动补全的候选（内置字典）
const PLUGINS = ${JSON.stringify(KNOWN_PLUGINS)};
// 可自动扫描的列表 → 文件类型（后端 SCAN_OF）
const SCANKEY = ${JSON.stringify(SCAN_OF)};
// 列表 → 补全用的 datalist 类型（与后端 SCANS 的键一致）
const KEY_FILTER = {
  styleFileList: 'css',
  scriptFileList: 'js', scriptFileList_earlyload: 'js', scriptFileList_inject_early: 'js', scriptFileList_preload: 'js',
  tweeFileList: 'twee', imgFileList: 'img', additionFile: 'all',
};
// params 里常见的键（下拉提示）
const PARAMKEYS = ['tip', 'passage', 'findString', 'findRegex', 'replace', 'replaceFile', 'regexFlag', 'all', 'js', 'twee', 'type'];
// 数组内的对象有哪些字段：field, datalist；params 单独走内嵌卡片
const OBJDEF = {
  addonPlugin: [['modName', 'dl-mod'], ['addonName', 'dl-addon'], ['modVersion', null]],
  dependenceInfo: [['modName', 'dl-mod'], ['version', null]],
};
let data = null;
let baseline = '';      // 载入/保存时的 JSON 快照，用于判断是否有修改
let errs = {};          // 锚点校验结果：键路径 → 提示
const openState = {};   // 记住每个标题的展开/收起
const imgUris = {};     // imgFileList 相对路径 → webview 可用的图片地址

// 底栏提示：超长时省略号，完整内容放 tooltip
function setMsg(t) { const m = $('msg'); m.textContent = t; m.title = t; }
// 把已拿到的图片地址贴到预览 <img> 上（地址是异步取回的，拿到后再补）
function applyImgUris() {
  document.querySelectorAll('img[data-src]').forEach((im) => { im.src = imgUris[im.getAttribute('data-src')] || ''; });
}

function el(tag, cls, txt) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt !== undefined) e.textContent = txt;
  return e;
}
// summary 里的按钮要阻止冒泡，否则点按钮会连带收起
function btn(txt, act, cls) {
  const b = el('button', cls || 'sec mini', txt);
  b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); act(); };
  return b;
}
// 新增后定位到新卡片并聚焦第一个输入框
function focusNew(node) {
  if (!node) return;
  try { node.scrollIntoView({ block: 'center' }); } catch (_) {}
  const f = node.querySelector('input:not([type=checkbox]), textarea');
  if (f) f.focus();
}
// 是否有修改 → 决定「保存」按钮的灰/蓝（无修改时仍可点击，只是与「重新载入」同色）
function markDirty() { $('sv').classList.toggle('sec', JSON.stringify(data) === baseline); }
// 把锚点校验结果贴到带 data-k 的输入框上（红框 + 悬浮提示）
function applyErrors() {
  document.querySelectorAll('[data-k]').forEach((n) => {
    const msg = errs[n.getAttribute('data-k')];
    n.classList.toggle('bad', !!msg);
    n.title = msg || '';
  });
}
let vTimer = null;
function scheduleValidate() {
  clearTimeout(vTimer);
  vTimer = setTimeout(() => vscode.postMessage({ type: 'validate', data: data }), 400);
}
// 草稿：面板一旦隐藏，webview 会被销毁，未保存的编辑会丢。这里防抖回传给扩展端存进 workspaceState，
// 下次打开面板若有差异就弹模态框问是否恢复
let dTimer = null;
function queueDraft() {
  clearTimeout(dTimer);
  dTimer = setTimeout(() => { if (data) vscode.postMessage({ type: 'draft', data }); }, 500);
}
// 任何一次编辑后统一处理：刷新保存按钮状态 + 触发锚点校验 + 记录草稿
function afterEdit() { markDirty(); scheduleValidate(); queueDraft(); }
document.addEventListener('input', afterEdit);
document.addEventListener('change', afterEdit);
// Tab 在文本框内插入制表符（显示宽度由 CSS tab-size:4 控制，保存仍是 \t）
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab' || !e.target || e.target.tagName !== 'TEXTAREA') return;
  e.preventDefault();
  const t = e.target, s = t.selectionStart, en = t.selectionEnd;
  t.value = t.value.slice(0, s) + '\t' + t.value.slice(en);
  t.selectionStart = t.selectionEnd = s + 1;
  t.dispatchEvent(new Event('input', { bubbles: true }));
});
function kindOf(v) {
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'number') return 'num';
  if (typeof v === 'string') return 'str';
  if (Array.isArray(v)) return v.every((x) => typeof x !== 'object') ? 'list' : 'objs';
  return 'json';
}
// 输入即改模型；JSON 字段解析失败时保留原值并标红
function bindJson(el, set) {
  el.oninput = () => { try { set(JSON.parse(el.value)); el.classList.remove('bad'); } catch (_) { el.classList.add('bad'); } };
}
function textInput(obj, key, dl) {
  const inp = el('input');
  inp.type = 'text';
  inp.value = obj[key] === undefined || obj[key] === null ? '' : obj[key];
  if (dl) inp.setAttribute('list', dl);
  inp.oninput = () => { obj[key] = inp.value; };
  return inp;
}
// 标题行做成可折叠卡片；cnt 与按钮都在标题一行
function section(key, cnt, btns) {
  const d = el('details', 'sec');
  d.open = openState[key] !== undefined ? openState[key] : key !== 'imgFileList';
  d.ontoggle = () => { openState[key] = d.open; };
  const s = el('summary');
  s.appendChild(el('span', null, key));
  if (cnt) s.appendChild(cnt);
  const bs = el('div', 'btns');
  for (const b of btns || []) bs.appendChild(b);
  s.appendChild(bs);
  d.appendChild(s);
  const body = el('div', 'body');
  d.appendChild(body);
  $('f').appendChild(d);
  return body;
}

// 字符串数组：每行一个输入框；imgFileList 额外带一张等高缩略图
function listSection(key) {
  const isImg = SCANKEY[key] === 'img';
  const rows = el('div');
  const nodes = [];
  const upd = () => {
    cnt.textContent = data[key].length + (isImg ? ' 张图片' : ' 项');
    // 缩略图地址由后端转换后回传，这里只请求还没拿到的
    const miss = isImg ? data[key].filter((s) => s && !(s in imgUris)) : [];
    if (miss.length) vscode.postMessage({ type: 'imgUris', list: miss });
  };
  const btns = [btn('+ 添加', () => { data[key].push(''); draw(); focusNew(nodes[data[key].length - 1]); afterEdit(); })];
  if (SCANKEY[key]) btns.push(btn('自动扫描', () => vscode.postMessage({ type: 'scan', key })));
  const cnt = el('span', 'cnt');
  const body = section(key, cnt, btns);
  body.appendChild(rows);
  const draw = () => {
    rows.textContent = '';
    nodes.length = 0;
    data[key].forEach((s, i) => {
      const row = el('div', 'item' + (isImg ? ' imgrow' : ''));
      let im = null;
      if (isImg) {
        im = el('img');
        im.setAttribute('data-src', s);
        im.src = imgUris[s] || '';
        row.appendChild(im);
      }
      const inp = el('input'); inp.type = 'text'; inp.value = s;
      if (KEY_FILTER[key]) inp.setAttribute('list', 'dl-' + KEY_FILTER[key]);
      inp.oninput = () => {
        data[key][i] = inp.value;
        if (im) { im.setAttribute('data-src', inp.value); im.src = imgUris[inp.value] || ''; }
      };
      row.append(inp, btn('×', () => { data[key].splice(i, 1); draw(); afterEdit(); }));
      rows.appendChild(row);
      nodes.push(row);
    });
    upd();
  };
  draw();
}

// 可选字段行：留空即删掉该键，保证写出的 JSON 干净；area 用多行文本框
// kp 非空时给输入框打上 data-k（键路径），供锚点校验回填红框
function fieldRow(box, obj, key, kind, kp) {
  const row = el('div', 'item');
  row.appendChild(el('span', 'pk', key));
  let fld;
  if (kind === 'bool') {
    fld = el('input'); fld.type = 'checkbox'; fld.checked = obj[key] === true;
    fld.onchange = () => { if (fld.checked) obj[key] = true; else delete obj[key]; };
  } else if (kind === 'area') {
    fld = el('textarea'); fld.value = obj[key] == null ? '' : obj[key];
    fld.oninput = () => { if (fld.value) obj[key] = fld.value; else delete obj[key]; };
  } else if (kind === 'file') {
    // 文件路径：带 dl-file 补全下拉
    fld = el('input'); fld.type = 'text'; fld.setAttribute('list', 'dl-file');
    fld.value = obj[key] == null ? '' : obj[key];
    fld.oninput = () => { if (fld.value) obj[key] = fld.value; else delete obj[key]; };
  } else {
    fld = el('input'); fld.type = 'text'; fld.value = obj[key] == null ? '' : obj[key];
    fld.oninput = () => { if (fld.value) obj[key] = fld.value; else delete obj[key]; };
  }
  if (kp) fld.setAttribute('data-k', kp);
  row.appendChild(fld);
  box.appendChild(row);
}

// 一行：标签 + 无圆角的左右切换开关（激活侧蓝色）。opts=[{label,value},{label,value}]
function segRow(host, label, opts, value, onPick) {
  const row = el('div', 'item');
  row.appendChild(el('span', 'pk', label));
  const sw = el('div', 'sw');
  opts.forEach((o, k) => {
    const t = el('span', 'sw-t ' + (k ? 'sw-b' : 'sw-a'), o.label);
    t.onclick = (e) => { e.preventDefault(); if (value !== o.value) onPick(o.value); };
    sw.appendChild(t);
  });
  sw.appendChild(el('i', 'sw-k'));
  if (value === opts[1].value) sw.classList.add('on');
  row.appendChild(sw);
  host.appendChild(row);
}

// 对象数组编辑器：adds=[{label,tpl}] 决定新增按钮与初始对象
// fields 可以是 [[键名, 类型, 显示条件?]] 列表，也可以是 (card, item, i, kp, draw) => {} 自定义渲染
// kp 为键路径前缀（如 addonPlugin.0.params），逐项拼成 …<index>.<字段> 供校验定位
// host 非空时：新增按钮直接放进 host（插件卡片标题行），条目平铺进一个无色无框容器，视觉上不再有 params 层
function objArrayEditor(box, arr, fields, adds, title, kp, host) {
  const nodes = [];
  const addBtn = (a) => btn(a.label, () => { arr.push(JSON.parse(JSON.stringify(a.tpl))); draw(); focusNew(nodes[arr.length - 1]); afterEdit(); });
  let body;
  if (host) {
    // 无外壳模式：新增按钮进标题行，条目放进一个无色无框的容器（视觉上不再有 params 层）
    for (const a of adds) host.appendChild(addBtn(a));
    body = el('div');
    box.appendChild(body);
  } else {
    const g = el('div', 'group');
    const h = el('div', 'card-h');
    h.appendChild(el('span', null, title || ''));
    const bar = el('div', 'btns');
    for (const a of adds) bar.appendChild(addBtn(a));
    h.appendChild(bar);
    g.appendChild(h);
    body = el('div');
    g.appendChild(body);
    box.appendChild(g);
  }
  const draw = () => {
    body.textContent = '';
    nodes.length = 0;
    arr.forEach((it, i) => {
      if (!it || typeof it !== 'object') it = arr[i] = {};
      const c = el('div', 'card');
      const ch = el('div', 'card-h');
      ch.appendChild(el('span', null, '#' + (i + 1) + (it.tip ? '  ' + it.tip : '')));
      ch.appendChild(btn('删除', () => { arr.splice(i, 1); draw(); afterEdit(); }));
      c.appendChild(ch);
      if (typeof fields === 'function') {
        fields(c, it, i, kp, draw);
      } else {
        for (const f of fields) {
          if (f[2] && !f[2](it)) continue;
          fieldRow(c, it, f[0], f[1], kp ? kp + '.' + i + '.' + f[0] : null);
        }
      }
      body.appendChild(c);
      nodes.push(c);
    });
  };
  draw();
}

// BeautySelectorAddon：params 固定只有 type，不提供增删参数
function beautyParams(card, o) {
  if (typeof o.params !== 'object' || !o.params || Array.isArray(o.params)) o.params = {};
  if (o.params.type === undefined) o.params.type = '';
  fieldRow(card, o.params, 'type', 'str');
}

// TweeReplacerAddon：params 是对象数组，每项用两个开关决定形态
//   匹配方式：字符串(findString) / 正则(findRegex+regexFlag)
//   替换方式：直接替换(replace) / 文件替换(replaceFile)
// 两种形态各只保留一个键，切换时删掉另一侧
// host 为插件卡片标题行：「+ 替换」放在那里，替换项直接平铺进卡片（不再有 params 层）
function tweeParams(card, host, o, kp) {
  if (!Array.isArray(o.params)) o.params = [];
  objArrayEditor(card, o.params, (c, it, i, base, draw) => {
    const b = base ? base + '.' + i : null;
    const k = (n) => (b ? b + '.' + n : null);
    fieldRow(c, it, 'tip', 'str');
    fieldRow(c, it, 'passage', 'str', k('passage'));
    const re = 'findRegex' in it;
    segRow(c, '匹配方式', [{ label: '字符串', value: false }, { label: '正则', value: true }], re, (v) => {
      if (v) { delete it.findString; if (it.findRegex === undefined) it.findRegex = ''; }
      else { delete it.findRegex; delete it.regexFlag; if (it.findString === undefined) it.findString = ''; }
      draw(); afterEdit();
    });
    if (re) {
      fieldRow(c, it, 'findRegex', 'area', k('findRegex'));
      fieldRow(c, it, 'regexFlag', 'str', k('regexFlag'));
    } else {
      fieldRow(c, it, 'findString', 'area', k('findString'));
    }
    const file = 'replaceFile' in it;
    segRow(c, '替换方式', [{ label: '直接替换', value: false }, { label: '文件替换', value: true }], file, (v) => {
      if (v) { delete it.replace; if (it.replaceFile === undefined) it.replaceFile = ''; }
      else { delete it.replaceFile; if (it.replace === undefined) it.replace = ''; }
      draw(); afterEdit();
    });
    if (file) fieldRow(c, it, 'replaceFile', 'file', k('replaceFile'));
    else fieldRow(c, it, 'replace', 'area', k('replace'));
    fieldRow(c, it, 'all', 'bool');
  }, [{ label: '+ 替换', tpl: { passage: '', findString: '', replace: '' } }], '', kp, host);
}

// ReplacePatcherAddon：params = { js:[对象], twee:[对象] }
function replacePatcherParams(card, o, kp) {
  if (typeof o.params !== 'object' || !o.params || Array.isArray(o.params)) o.params = {};
  const p = o.params;
  if (!Array.isArray(p.js)) p.js = [];
  if (!Array.isArray(p.twee)) p.twee = [];
  objArrayEditor(card, p.js, [['tip', 'str'], ['fileName', 'str'], ['from', 'area'], ['to', 'area']],
    [{ label: '+ 添加', tpl: { fileName: '' } }], 'js', kp + '.js');
  objArrayEditor(card, p.twee, [['tip', 'str'], ['passageName', 'str'], ['from', 'area'], ['to', 'area']],
    [{ label: '+ 添加', tpl: { passageName: '' } }], 'twee', kp + '.twee');
}

// I18nTweeReplacerAddon：语言配置 + findLanguageFile / replaceLanguageFile 两个 {language,file} 数组
function i18nParams(card, o) {
  if (typeof o.params !== 'object' || !o.params || Array.isArray(o.params)) o.params = {};
  const p = o.params;
  fieldRow(card, p, 'mainFindLanguage', 'str');
  fieldRow(card, p, 'mainReplaceLanguage', 'str');
  fieldRow(card, p, 'replaceIndexFile', 'str');
  if (!Array.isArray(p.findLanguageFile)) p.findLanguageFile = [];
  if (!Array.isArray(p.replaceLanguageFile)) p.replaceLanguageFile = [];
  objArrayEditor(card, p.findLanguageFile, [['language', 'str'], ['file', 'str']],
    [{ label: '+ 添加', tpl: { language: '' } }], 'findLanguageFile');
  objArrayEditor(card, p.replaceLanguageFile, [['language', 'str'], ['file', 'str']],
    [{ label: '+ 添加', tpl: { language: '' } }], 'replaceLanguageFile');
}

// 按 addonName 分派到专用编辑器，其余插件走通用编辑器；kp 为该项目在 boot.json 里的键路径
// bar 为插件卡片标题行的按钮容器，需要把「新增」按钮放进标题行的编辑器用它
function paramsEditor(card, bar, o, kp) {
  const an = o.addonName || '';
  if (an === 'BeautySelectorAddon') return beautyParams(card, o);
  if (an === 'TweeReplacerAddon') return tweeParams(card, bar, o, kp + '.params');
  if (an === 'ReplacePatcherAddon') return replacePatcherParams(card, o, kp + '.params');
  if (an === 'I18nTweeReplacerAddon') return i18nParams(card, o);
  return genericParams(card, o);
}

// params 内嵌行：数组→子列表，布尔→勾选，对象→JSON，其它→文本框
function genericParams(card, o) {
  if (typeof o.params !== 'object' || !o.params || Array.isArray(o.params)) o.params = {};
  const p = o.params;
  // 需要一个可整体重画的容器，但不额外套方框，只留左侧竖线
  const box = el('div', 'group');
  card.appendChild(box);
  const draw = () => {
    box.textContent = '';
    for (const k of Object.keys(p)) {
      const v = p[k];
      const row = el('div', 'item');
      row.appendChild(el('span', 'pk', k));
      if (Array.isArray(v)) {
        const sub = el('div'); sub.style.flex = '1'; sub.style.minWidth = '0';
        const sdraw = () => {
          sub.textContent = '';
          v.forEach((x, i) => {
            const r2 = el('div', 'item');
            const inp = el('input'); inp.type = 'text'; inp.value = x;
            inp.oninput = () => { v[i] = inp.value; };
            r2.append(inp, btn('×', () => { v.splice(i, 1); sdraw(); afterEdit(); }));
            sub.appendChild(r2);
          });
          sub.appendChild(btn('+ 项', () => { v.push(''); sdraw(); focusNew(sub.children[v.length - 1]); afterEdit(); }));
        };
        sdraw();
        row.appendChild(sub);
      } else if (typeof v === 'boolean') {
        const inp = el('input'); inp.type = 'checkbox'; inp.checked = v;
        inp.onchange = () => { p[k] = inp.checked; };
        row.appendChild(inp);
      } else if (v && typeof v === 'object') {
        const ta = el('textarea'); ta.value = JSON.stringify(v, null, 2);
        bindJson(ta, (x) => { p[k] = x; });
        row.appendChild(ta);
      } else {
        const inp = el('input'); inp.type = 'text'; inp.value = v == null ? '' : v;
        inp.oninput = () => { p[k] = inp.value; };
        row.appendChild(inp);
      }
      row.appendChild(btn('×', () => { delete p[k]; draw(); afterEdit(); }));
      box.appendChild(row);
    }
    const add = el('div', 'item');
    const nin = el('input'); nin.setAttribute('list', 'dl-param'); nin.placeholder = '新参数名';
    add.append(nin, btn('+ 参数', () => { const n = nin.value.trim(); if (n) { if (p[n] === undefined) p[n] = ''; draw(); focusNew(box.children[Object.keys(p).length - 1]); afterEdit(); } }));
    box.appendChild(add);
  };
  draw();
}

// 对象数组（addonPlugin / dependenceInfo）
function objSection(key) {
  const defs = OBJDEF[key];
  const wraps = el('div');
  const nodes = [];
  const cnt = el('span', 'cnt');
  const body = section(key, cnt, [btn('+ 添加一项', () => { data[key].push({}); draw(); focusNew(nodes[data[key].length - 1]); afterEdit(); })]);
  body.appendChild(wraps);
  const draw = () => {
    wraps.textContent = '';
    nodes.length = 0;
    cnt.textContent = data[key].length + ' 项';
    data[key].forEach((o, i) => {
      const c = el('div', 'card');
      const h = el('div', 'card-h');
      h.appendChild(el('span', null, '#' + (i + 1) + (o.modName ? '  ' + o.modName : '')));
      // 标题行的按钮容器：删除按钮，以及各编辑器自己追加的「新增」按钮
      const bar = el('div', 'btns');
      bar.appendChild(btn('删除', () => { data[key].splice(i, 1); draw(); afterEdit(); }));
      h.appendChild(bar);
      c.appendChild(h);
      if (!defs) {
        const ta = el('textarea'); ta.value = JSON.stringify(o, null, 2);
        bindJson(ta, (v) => { for (const kk of Object.keys(o)) delete o[kk]; Object.assign(o, v); });
        c.appendChild(ta);
      } else {
        for (const [f, dl] of defs) {
          const row = el('div', 'item');
          row.appendChild(el('span', 'pk', f));
          const inp = textInput(o, f, dl);
          // 依赖表规则：填了已知 modName 就自动补上 addonName
          if (f === 'modName') inp.onchange = () => { if (key === 'addonPlugin' && !o.addonName && PLUGINS[o.modName]) { o.addonName = PLUGINS[o.modName]; draw(); afterEdit(); } };
          // 改 addonName 后按新插件重画 params 编辑器（切换专用/通用编辑界面）
          if (f === 'addonName') inp.onchange = () => { draw(); afterEdit(); };
          row.appendChild(inp);
          c.appendChild(row);
        }
        if (key === 'addonPlugin') paramsEditor(c, bar, o, key + '.' + i);
      }
      wraps.appendChild(c);
      nodes.push(c);
    });
  };
  draw();
}

function render() {
  $('f').textContent = '';
  if (!data || !Object.keys(data).length) { $('f').textContent = '（没有可编辑的内容）'; markDirty(); return; }
  for (const k of Object.keys(data)) {
    const kd = kindOf(data[k]);
    if (kd === 'list') listSection(k);
    else if (kd === 'objs') objSection(k);
    else if (kd === 'json') {
      const cm = el('textarea'); cm.value = JSON.stringify(data[k], null, 2);
      bindJson(cm, (v) => { data[k] = v; });
      section(k, null, []).appendChild(cm);
    } else {
      const inp = kd === 'str' ? textInput(data, k) : el('input');
      if (kd === 'bool') { inp.type = 'checkbox'; inp.checked = data[k]; inp.onchange = () => { data[k] = inp.checked; }; }
      if (kd === 'num') { inp.type = 'number'; inp.value = data[k]; inp.oninput = () => { data[k] = Number(inp.value); }; }
      section(k, null, []).appendChild(inp);
    }
  }
  applyErrors();
  afterEdit();
}
$('dl-mod').innerHTML = Object.keys(PLUGINS).map((m) => '<option value="' + m + '">').join('');
$('dl-addon').innerHTML = [...new Set(Object.keys(PLUGINS).map((m) => PLUGINS[m]).filter(Boolean))].map((m) => '<option value="' + m + '">').join('');
$('dl-param').innerHTML = PARAMKEYS.map((m) => '<option value="' + m + '">').join('');

$('sv').onclick = () => {
  setMsg(document.querySelector('.bad') ? '有字段不是合法 JSON，已保持原值' : '正在保存…');
  vscode.postMessage({ type: 'save', data: data });
};
// 重新载入等于放弃当前编辑，同时丢掉草稿，避免下次打开又弹恢复框
$('rl').onclick = () => { vscode.postMessage({ type: 'dropDraft' }); vscode.postMessage({ type: 'ready' }); };
$('cr').onclick = () => vscode.postMessage({ type: 'create' });
let draft = null;
$('mr').onclick = () => {
  $('modal').style.display = 'none';
  if (draft) { data = draft; render(); setMsg('已恢复上次未保存的更改（尚未写入 boot.json）'); }
  draft = null;
};
$('md').onclick = () => { $('modal').style.display = 'none'; draft = null; vscode.postMessage({ type: 'dropDraft' }); };
window.addEventListener('message', (e) => {
  const m = e.data;
  if (m.type === 'load') {
    data = m.data || {};
    baseline = JSON.stringify(data);
    errs = {};
    $('p').textContent = m.path || '';
    $('cr').style.display = m.none ? '' : 'none';
    for (const k of Object.keys(openState)) delete openState[k];
    render();
    setMsg(m.ok || m.none ? '' : '读取失败');
    vscode.postMessage({ type: 'listFiles' });   // 供「文件替换」路径补全
    if (m.draft) { draft = m.draft; $('modal').style.display = 'flex'; }
  }
  if (m.type === 'files') {
    const cur = Array.isArray(data[m.key]) ? data[m.key] : (data[m.key] = []);
    const have = new Set(cur);
    let n = 0;
    for (const f of m.list) if (!have.has(f)) { cur.push(f); n++; }
    openState[m.key] = true;
    render();
    setMsg('扫描到 ' + m.list.length + ' 个文件，新增 ' + n + ' 条（保存后写入 boot.json）');
  }
  if (m.type === 'modfiles') {
    // 各类文件清单分别灌进对应 datalist：file→replaceFile，css/js/twee/img/all→各列表
    for (const k of Object.keys(m.lists || {})) {
      const dl = $('dl-' + k);
      if (dl) dl.innerHTML = m.lists[k].map((f) => '<option value="' + f.replace(/"/g, '&quot;') + '">').join('');
    }
  }
  if (m.type === 'imgUris') { Object.assign(imgUris, m.map || {}); applyImgUris(); }
  if (m.type === 'saved') { baseline = JSON.stringify(data); markDirty(); setMsg('已写入 ' + m.path); }
  if (m.type === 'valid') { errs = m.errors || {}; applyErrors(); }
  if (m.type === 'error') setMsg(m.msg);
});
vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}

// boot.json 目录可能在工作区之外，缩略图需要把它加进 webview 的允许根目录
function bootRoots(baseDir) {
  const roots = (vscode.workspace.workspaceFolders || []).map((f) => f.uri);
  if (baseDir) roots.push(vscode.Uri.file(baseDir));
  return roots;
}

// 未保存草稿：webview 被销毁后编辑会丢，存在 workspaceState 里，下次打开面板时提示恢复
const BOOT_DRAFT = 'atools4dol.bootDraft';

function registerBootView(context) {
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('atools4dol.boot', {
      resolveWebviewView(view) {
        bootView = view;
        view.onDidDispose(() => { if (bootView === view) bootView = null; });
        view.webview.options = { enableScripts: true, localResourceRoots: bootRoots(bootInfo && bootInfo.baseDir) };
        view.webview.html = bootFormHtml(view.webview.cspSource);
        view.webview.onDidReceiveMessage(async (m) => {
          if (m.type === 'ready') {
            const r = await loadBootForView();
            view.webview.options = { enableScripts: true, localResourceRoots: bootRoots(r.ok ? path.dirname(r.path) : null) };
            // 上次留下的草稿：路径一致且与文件内容有差异才提示恢复
            const d = context.workspaceState.get(BOOT_DRAFT);
            let draft;
            if (d && d.path && r.ok && d.path === r.path) {
              if (JSON.stringify(d.data) !== JSON.stringify(r.data)) draft = d.data;
              else context.workspaceState.update(BOOT_DRAFT, undefined);
            } else if (d && d.path && r.ok) {
              context.workspaceState.update(BOOT_DRAFT, undefined);
            }
            view.webview.postMessage({ type: 'load', ok: r.ok, none: r.none, path: r.path, data: r.data, draft });
            return;
          }
          if (m.type === 'draft') {
            const p = await resolveBootPath();
            if (p) context.workspaceState.update(BOOT_DRAFT, { path: p, data: m.data });
            return;
          }
          if (m.type === 'dropDraft') { context.workspaceState.update(BOOT_DRAFT, undefined); return; }
          if (m.type === 'pick') { await pickBoot(); return; }
          if (m.type === 'create') { await createBoot(); return; }
          if (m.type === 'validate') { view.webview.postMessage({ type: 'valid', errors: await validateBoot(m.data) }); return; }
          if (m.type === 'listFiles') {
            // 一次回传各类文件清单：replaceFile 用 file(只有 twee/txt)，各列表用各自的类型
            const r = await resolveBootPath();
            const dir = r ? path.dirname(r) : '';
            const lists = {};
            if (dir) {
              lists.file = scanFiles(dir, FILE_COMPLETION);
              for (const t of Object.keys(SCANS)) lists[t] = scanFiles(dir, SCANS[t]);
            }
            view.webview.postMessage({ type: 'modfiles', lists });
            return;
          }
          if (m.type === 'imgUris') {
            // 把 imgFileList 里的相对路径转成 webview 可加载的地址（CSP + localResourceRoots 放行后方可显示）
            const r = await resolveBootPath();
            const base = r ? path.dirname(r) : '';
            const map = {};
            for (const rel of (Array.isArray(m.list) ? m.list : [])) {
              if (!rel || !base) continue;
              const abs = path.resolve(base, rel);
              if (fs.existsSync(abs)) map[rel] = view.webview.asWebviewUri(vscode.Uri.file(abs)).toString();
            }
            view.webview.postMessage({ type: 'imgUris', map });
            return;
          }
          if (m.type === 'scan') {
            const r = await resolveBootPath();
            if (!r) { view.webview.postMessage({ type: 'error', msg: '没有可用的 boot.json，请先创建' }); return; }
            view.webview.postMessage({ type: 'files', key: m.key, list: scanFiles(path.dirname(r), SCANS[SCAN_OF[m.key]]) });
            return;
          }
          if (m.type === 'save') {
            const r = await loadBootForView();
            if (!r.ok) { view.webview.postMessage({ type: 'error', msg: '没有可写的 boot.json' }); return; }
            try {
              fs.writeFileSync(r.path, JSON.stringify(m.data, null, 2));
              context.workspaceState.update(BOOT_DRAFT, undefined);   // 已落盘，草稿作废
              view.webview.postMessage({ type: 'saved', path: r.path });
              updateBootJsonContext();
            } catch (e) { view.webview.postMessage({ type: 'error', msg: e.message }); }
          }
        });
      },
    }),
    vscode.commands.registerCommand('atools4dol.refreshBoot', () => refreshBootView()),
    vscode.commands.registerCommand('atools4dol.pickBoot', () => pickBoot()),
    vscode.commands.registerCommand('atools4dol.createBoot', () => createBoot())
  );
}

function activate(context) {
  // 游戏连上就下发一次宏候选，供其调试面板代码框的补全下拉使用
  startServer(38471, (m) => getChannel().appendLine(m), () => gameSource()?.sendCompletion?.());
  require('./gamedata').registerGameData(context);
  registerBootView(context);
  updateBootJsonContext();
  registerConnStatus(context);

  const watcher = vscode.workspace.createFileSystemWatcher('**/boot.json');
  watcher.onDidCreate(updateBootJsonContext);
  watcher.onDidDelete(updateBootJsonContext);
  watcher.onDidChange(updateBootJsonContext);
  context.subscriptions.push(watcher);

  context.subscriptions.push(
    vscode.commands.registerCommand('atools4dol.pack', () => runPack())
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('atools4dol.push', () => runPush())
  );
}

function deactivate() {}

module.exports = { activate, deactivate };