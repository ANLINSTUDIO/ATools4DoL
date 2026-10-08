/** ATool 推送接收端：连接 VSCode 扩展，接收 .mod.zip 并交给 ModLoader 安装。 */
(function () {
  'use strict';

  const PORT = 38471;
  const RECONNECT_DELAY = 3000;

  let ws = null;
  let pendingHeader = null;
  let pendingChunks = [];

  function log(...args) {
    console.log('[ATool-Push]', ...args);
  }

  function connect() {
    try {
      ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    } catch (e) {
      log('创建 WebSocket 失败:', e.message);
      setTimeout(connect, RECONNECT_DELAY);
      return;
    }

    ws.binaryType = 'arraybuffer';

    ws.onopen = () => log('已连接 VSCode 扩展');
    ws.onclose = () => {
      log('连接断开，稍后重连');
      ws = null;
      setTimeout(connect, RECONNECT_DELAY);
    };
    ws.onerror = () => { /* onclose 会处理 */ };

    ws.onmessage = (event) => {
      if (typeof event.data === 'string') {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'mod-update') {
            pendingHeader = msg;
            pendingChunks = [];
            log('收到包头:', msg.name, msg.version, msg.size, '字节');
          }
        } catch (e) {
          log('包头解析失败:', e.message);
        }
        return;
      }

      // 二进制体
      if (!pendingHeader) return;

      pendingChunks.push(event.data);
      const received = pendingChunks.reduce((n, c) => n + c.byteLength, 0);

      if (received >= pendingHeader.size) {
        const header = pendingHeader;
        const chunks = pendingChunks;
        pendingHeader = null;
        pendingChunks = [];
        handleZip(header, chunks);
      }
    };
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

  // 等游戏框架就绪后再连
  if (document.readyState === 'complete') connect();
  else window.addEventListener('load', connect, { once: true });
})();