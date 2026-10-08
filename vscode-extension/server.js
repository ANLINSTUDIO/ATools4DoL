const { WebSocketServer } = require('ws');

let wss = null;
let client = null;

function startServer(port = 38471, onLog = console.log) {
  if (wss) return wss;

  wss = new WebSocketServer({ host: '127.0.0.1', port });

  wss.on('connection', (socket) => {
    client = socket;
    onLog('[ATools4DoL] 游戏已连接');

    socket.on('close', () => {
      if (client === socket) client = null;
      onLog('[ATools4DoL] 游戏已断开');
    });

    socket.on('error', (e) => {
      onLog('[ATools4DoL] socket 错误: ' + e.message);
    });
  });

  wss.on('error', (e) => {
    onLog('[ATools4DoL] server 错误: ' + e.message);
  });

  onLog(`[ATools4DoL] WebSocket 已监听 127.0.0.1:${port}`);
  return wss;
}

function hasClient() {
  return client && client.readyState === 1;
}

/**
 * 推送一个 zip。
 * 协议：先发一条 JSON 文本头，再发二进制体。
 */
function pushZip(zipPath, meta = {}) {
  return new Promise((resolve, reject) => {
    if (!hasClient()) {
      reject(new Error('游戏未连接'));
      return;
    }

    const fs = require('fs');
    const path = require('path');
    const buf = fs.readFileSync(zipPath);

    const header = JSON.stringify({
      type: 'mod-update',
      name: meta.name || path.basename(zipPath),
      version: meta.version || '',
      size: buf.length,
    });

    try {
      client.send(header, { binary: false });
      client.send(buf, { binary: true });
      resolve();
    } catch (e) {
      reject(e);
    }
  });
}

function stopServer() {
  if (client) {
    try { client.close(); } catch {}
    client = null;
  }
  if (wss) {
    try { wss.close(); } catch {}
    wss = null;
  }
}

module.exports = { startServer, pushZip, hasClient, stopServer };