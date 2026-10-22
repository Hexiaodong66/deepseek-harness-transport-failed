#!/usr/bin/env node
/**
 * dsh-diag check-proxy — 判定「哪些端口真的能当 HTTPS 代理用」。
 *
 *   node.exe check-proxy.cjs 8080 7890 1080 ...
 *   → stdout 输出一行 JSON 数组，每个端口一条结论。
 *
 * 关键点：端口在监听 ≠ 它能代理。判定标准是一次真实的
 *   CONNECT api.deepseek.com:443 → TLS 握手 → HTTP 请求 → 收到任意 4xx/2xx
 * 才算通过。所以 SOCKS 端口、残留的半死进程、被规则拦掉的端口都会自动落选。
 */
'use strict';

const net = require('node:net');
const tls = require('node:tls');

const HOST = 'api.deepseek.com';
const PORT = 443;
const TIMEOUT = 6000;

function check(proxyPort) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const out = { port: proxyPort, ok: false, elapsedMs: 0 };
    let settled = false;
    let socket;
    let tlsSocket;

    const done = (patch) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { tlsSocket?.destroy(); } catch {}
      try { socket?.destroy(); } catch {}
      resolve({ ...out, ...patch, elapsedMs: Date.now() - t0 });
    };

    const timer = setTimeout(() => done({ error: 'timeout' }), TIMEOUT);

    socket = net.connect({ host: '127.0.0.1', port: proxyPort });
    socket.once('error', (e) => done({ error: e.code || e.message, stage: 'tcp' }));
    socket.once('connect', () => {
      socket.write(`CONNECT ${HOST}:${PORT} HTTP/1.1\r\nHost: ${HOST}:${PORT}\r\n\r\n`);
      let head = Buffer.alloc(0);
      const onHead = (chunk) => {
        head = Buffer.concat([head, chunk]);
        const end = head.indexOf('\r\n\r\n');
        if (end === -1) {
          if (head.length > 8192) done({ error: 'header too large', stage: 'connect' });
          return;
        }
        socket.off('data', onHead);
        const status = Number((/^HTTP\/\d\.\d\s+(\d{3})/.exec(head.subarray(0, end).toString('latin1')) || [])[1] || 0);
        out.connectStatus = status;
        if (status !== 200) {
          return done({ error: `CONNECT ${status || 'malformed'}`, stage: 'connect' });
        }
        tlsSocket = tls.connect({ socket, servername: HOST, ALPNProtocols: ['http/1.1'] });
        tlsSocket.once('error', (e) => done({ error: e.code || e.message, stage: 'tls' }));
        tlsSocket.once('secureConnect', () => {
          if (!tlsSocket.authorized) {
            return done({ error: String(tlsSocket.authorizationError || 'certificate rejected'), stage: 'tls' });
          }
          tlsSocket.write(
            `GET /anthropic/v1/messages HTTP/1.1\r\nHost: ${HOST}\r\nConnection: close\r\nAccept: */*\r\nUser-Agent: dsh-diag/1\r\n\r\n`,
          );
        });
        tlsSocket.once('data', (buf) => {
          const status = Number((/^HTTP\/\d\.\d\s+(\d{3})/.exec(buf.toString('latin1')) || [])[1] || 0);
          // 401/403/404 都算传输成功：TCP、隧道、TLS、HTTP 全通了。
          done({ ok: status >= 200 && status < 500, httpStatus: status, stage: 'http' });
        });
      };
      socket.on('data', onHead);
    });
  });
}

(async () => {
  const ports = process.argv.slice(2).map(Number).filter((n) => Number.isInteger(n) && n > 0 && n < 65536);
  const unique = [...new Set(ports)];
  const results = [];
  for (const p of unique) results.push(await check(p));
  process.stdout.write(JSON.stringify(results));
})();
