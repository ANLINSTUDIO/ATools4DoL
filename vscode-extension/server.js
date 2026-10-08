const { WebSocketServer } = require('ws');

const PORT_BASE = 38471;
const PORT_SPAN = 10;            // 38471 ~ 38480：多开 VSCode 窗口时每个窗口占一个

let wss = null;
let client = null;

// 端口段自动占用：每个 VSCode 窗口是独立扩展宿主进程，都去绑 38471 时第二个会 EADDRINUSE，
// 于是从基址开始逐个探到第一个空闲端口；游戏模组那边同时尝试连接这一整段。
function startServer(basePort = PORT_BASE, onLog = console.log, onConnect = null) {
  if (wss) return wss;

  const max = basePort + PORT_SPAN - 1;
  const tryBind = (p) => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: p });

    server.on('connection', (socket) => {
      client = socket;
      onLog('[ATools4DoL] 游戏已连接');
      try { onConnect && onConnect(); } catch (e) { onLog('[ATools4DoL] onConnect 出错: ' + e.message); }

      socket.on('close', () => {
        if (client === socket) client = null;
        onLog('[ATools4DoL] 游戏已断开');
      });

      socket.on('error', (e) => {
        onLog('[ATools4DoL] socket 错误: ' + e.message);
      });
    });

    server.on('listening', () => {
      wss = server;
      onLog(`[ATools4DoL] WebSocket 已监听 127.0.0.1:${p}`);
    });

    server.on('error', (e) => {
      if (e.code === 'EADDRINUSE' && p < max) { tryBind(p + 1); return; }
      onLog('[ATools4DoL] server 错误: ' + e.message);
    });
  };

  tryBind(basePort);
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

// 向已连接的游戏下发一条 JSON（用于补全名单等控制消息）
function sendJSON(obj) {
  if (!hasClient()) return false;
  try { client.send(JSON.stringify(obj)); return true; } catch (e) { return false; }
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

module.exports = { startServer, pushZip, hasClient, sendJSON, stopServer };