#!/usr/bin/env node
/**
 * dsh-diag probe 鈥?phase-level transport diagnosis for DeepSeek Harness.
 *
 * Zero dependencies. Runs on the Harness' own bundled Node:
 *   node.exe probe.cjs [--json out.jsonl] [--host api.deepseek.com] [--port 443]
 *
 * What it measures (each phase separately, with ms timestamps):
 *   1. proxy TCP reachability
 *   2. proxy CONNECT tunnel (status line as the proxy answered it)
 *   3. TLS handshake through that tunnel (protocol, cipher, authorized, CA error)
 *   4. first byte of the HTTP response (status only; no body read beyond headers)
 *   5. the same request sent directly, bypassing the proxy
 *
 * It never sends credentials, never sends a prompt, and never prints a header value.
 */
'use strict';

const net = require('node:net');
const tls = require('node:tls');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');

// ---------------------------------------------------------------- env layers

/** Parse a dotenv file the way the harness does: KEY=VALUE, # comments, no export keyword support needed. */
function parseEnvFile(file) {
  const out = {};
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return out; }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const name = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[name] = value;
  }
  return out;
}

/** Precedence mirrors dsh-app-boot: process > project(cwd) > harness-home .env. */
function layeredEnv(cwd, opts = {}) {
  const processValues = { ...process.env };
  if (opts.noProcessProxy) {
    // Model a plain Explorer/Start-menu launch, where no proxy variable is
    // inherited and only the harness-home `.env` can supply one.
    for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy']) {
      delete processValues[name];
    }
  }
  const layers = [
    { source: 'process', values: processValues },
    { source: 'project-env', path: path.join(cwd, '.env'), values: parseEnvFile(path.join(cwd, '.env')) },
    { source: 'user-env', path: path.join(DSH_HOME, '.env'), values: parseEnvFile(path.join(DSH_HOME, '.env')) },
  ];
  const get = (name) => {
    const want = process.platform === 'win32' ? name.toUpperCase() : name;
    for (const layer of layers) {
      for (const [k, v] of Object.entries(layer.values)) {
        const key = process.platform === 'win32' ? k.toUpperCase() : k;
        if (key === want && v !== undefined && String(v).trim() !== '') {
          return { value: String(v).trim(), source: layer.source, path: layer.path };
        }
      }
    }
    return undefined;
  };
  return { get, layers };
}

const LOOPBACK = ['localhost', '127.0.0.1', '::1', '[::1]'];

/** Mirror of dsh-http-proxy's bypass matcher for the entries this machine actually uses. */
function bypasses(noProxy, host) {
  const h = host.toLowerCase();
  for (const raw of String(noProxy || '').split(/[,\s]+/)) {
    const e = raw.trim().toLowerCase();
    if (e === '') continue;
    if (e === '*') return true;
    if (e.includes('/')) { // CIDR: only v4, best-effort
      const [base, bitsRaw] = e.split('/');
      const bits = Number(bitsRaw);
      if (!Number.isInteger(bits) || !net.isIPv4(base) || !net.isIPv4(h)) continue;
      const toInt = (ip) => ip.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      if ((toInt(base) & mask) === (toInt(h) & mask)) return true;
      continue;
    }
    const bare = e.replace(/^\[|\]$/g, '');
    if (h === bare) return true;
    if (bare.startsWith('.') && h.endsWith(bare)) return true;
    if (bare.startsWith('*.') && h.endsWith(bare.slice(1))) return true;
    if (h.endsWith('.' + bare) && !bare.includes(':')) return true;
  }
  return false;
}

const now = () => Date.now();
const iso = (t) => new Date(t).toISOString();
const ms = (a, b) => b - a;

function errorRecord(err, phase) {
  if (!err) return undefined;
  const chain = [];
  let cur = err;
  for (let depth = 0; cur && depth < 8; depth++) {
    chain.push({
      name: cur.name,
      message: cur.message,
      code: cur.code,
      errno: cur.errno,
      syscall: cur.syscall,
      hostname: cur.hostname,
      address: cur.address,
      port: cur.port,
      library: cur.library,
      reason: cur.reason,
      // TLS / DF-specific
      cert: cur.code === 'CERT_HAS_EXPIRED' || cur.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ? cur.code : undefined,
    });
    cur = cur.cause;
  }
  return { phase, chain };
}

// ---------------------------------------------------------------- phases

function tcpProbe(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const started = now();
    const sock = net.connect({ host, port });
    let settled = false;
    const done = (record) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve({ ...record, elapsedMs: ms(started, now()) });
    };
    sock.setTimeout(timeoutMs, () => done({ ok: false, phase: 'tcp', timedOut: true, error: { phase: 'tcp', chain: [{ name: 'TimeoutError', message: `no TCP response within ${timeoutMs}ms` }] } }));
    sock.once('connect', () => done({ ok: true, phase: 'tcp', localPort: sock.localPort, remote: sock.remoteAddress }));
    sock.once('error', (error) => done({ ok: false, phase: 'tcp', error: errorRecord(error, 'tcp') }));
  });
}

/**
 * One HTTP(S) exchange, optionally tunnelled through an HTTP proxy via CONNECT.
 * Reports every phase boundary independently so a failure is attributable.
 */
function exchange(options) {
  const {
    label, host, port, targetPath, method = 'GET', proxy, timeoutMs = 8000,
    extraHeaders = {}, body,
  } = options;

  return new Promise((resolve) => {
    const t0 = now();
    const phases = {};
    let settled = false;
    let transport = null;
    let tlsSocket = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try { tlsSocket?.destroy(); } catch {}
      try { transport?.destroy(); } catch {}
      resolve({ label, host, port, proxied: proxy !== undefined, at: iso(t0), phases, elapsedMs: ms(t0, now()), ...result });
    };
    const fail = (phase, error) => finish({ ok: false, failedAt: phase, error: errorRecord(error, phase) });
    const timer = setTimeout(() => {
      const e = new Error(`phase "${Object.keys(phases).pop() || 'connect'}" exceeded ${timeoutMs}ms`);
      e.name = 'TimeoutError';
      fail('timeout', e);
    }, timeoutMs);

    const onTlsReady = () => {
      phases.tlsDone = now();
      const cert = tlsSocket.getPeerCertificate?.() || {};
      phases.tls = {
        protocol: tlsSocket.getProtocol(),
        cipher: tlsSocket.getCipher?.()?.name,
        authorized: tlsSocket.authorized,
        authorizationError: tlsSocket.authorizationError ? String(tlsSocket.authorizationError) : undefined,
        alpn: tlsSocket.alpnProtocol,
        subjectCN: cert.subject?.CN,
        issuer: cert.issuer?.CN,
        validFrom: cert.valid_from,
        validTo: cert.valid_to,
      };
      const headerLines = [
        `${method} ${targetPath} HTTP/1.1`,
        `Host: ${host}`,
        'Connection: close',
        'Accept: */*',
        'User-Agent: dsh-diag/1',
        'Content-Length: ' + (body ? Buffer.byteLength(body) : 0),
        ...Object.entries(extraHeaders).map(([k, v]) => `${k}: ${v}`),
        '', body ?? '',
      ];
      phases.requestSent = now();
      tlsSocket.write(headerLines.join('\r\n'));
    };

    const onData = (buf) => {
      if (phases.firstByte === undefined) {
        phases.firstByte = now();
        const text = buf.toString('latin1');
        const statusLine = text.split('\r\n')[0];
        const m = /^HTTP\/(\d\.\d)\s+(\d{3})\s*(.*)$/.exec(statusLine);
        clearTimeout(timer);
        if (!m) return finish({ ok: false, failedAt: 'status', statusLine: statusLine.slice(0, 120), note: 'non-HTTP bytes from the peer' });
        const status = Number(m[2]);
        phases.statusLine = statusLine.slice(0, 120);
        return finish({
          ok: true,
          status,
          httpVersion: m[1],
          // 401/403 is a *transport success*: the socket, TLS, and HTTP all worked.
          transportOk: true,
          reachedOrigin: status !== 407,
          proxyAuthRequired: status === 407,
          headerBytes: buf.length,
        });
      }
    };

    transport = net.connect({ host: proxy ? proxy.host : host, port: proxy ? proxy.port : port });
    transport.setNoDelay(true);
    transport.once('connect', () => {
      phases.tcpConnected = now();
      if (!proxy) {
        tlsSocket = tls.connect({ socket: transport, servername: host, ALPNProtocols: ['http/1.1'] });
        tlsSocket.once('secureConnect', onTlsReady);
        tlsSocket.once('error', (e) => { clearTimeout(timer); fail('tls', e); });
        tlsSocket.on('data', onData);
        return;
      }
      // CONNECT tunnel: the proxy answers with its own status line before TLS starts.
      transport.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
      let head = Buffer.alloc(0);
      const onHead = (chunk) => {
        head = Buffer.concat([head, chunk]);
        const end = head.indexOf('\r\n\r\n');
        if (end === -1) {
          if (head.length > 8192) { clearTimeout(timer); fail('proxy-connect', new Error('proxy CONNECT header exceeded 8 KiB')); }
          return;
        }
        phases.proxyConnectResponded = now();
        transport.off('data', onHead);
        const text = head.subarray(0, end).toString('latin1');
        const statusLine = text.split('\r\n')[0];
        const m = /^HTTP\/(\d\.\d)\s+(\d{3})/.exec(statusLine);
        const status = m ? Number(m[2]) : 0;
        phases.proxyConnect = { status, statusLine: statusLine.slice(0, 160), headerBytes: end };
        if (status !== 200) {
          clearTimeout(timer);
          const e = new Error(`proxy CONNECT answered ${status || 'malformed'}: ${statusLine.slice(0, 120)}`);
          e.name = 'ProxyConnectError';
          e.code = status === 407 ? 'PROXY_AUTH_REQUIRED' : 'PROXY_CONNECT_FAILED';
          return fail('proxy-connect', e);
        }
        // Anything the proxy already sent past the CONNECT header belongs to TLS.
        const rest = head.subarray(end + 4);
        tlsSocket = tls.connect({ socket: transport, servername: host, ALPNProtocols: ['http/1.1'] });
        tlsSocket.once('secureConnect', onTlsReady);
        tlsSocket.once('error', (e) => { clearTimeout(timer); fail('tls', e); });
        tlsSocket.on('data', onData);
        if (rest.length > 0) tlsSocket.unshift(rest);
      };
      transport.on('data', onHead);
      transport.once('error', (e) => { clearTimeout(timer); fail('proxy-connect', e); });
    });
    transport.once('error', (e) => { clearTimeout(timer); fail(proxy ? 'proxy-connect' : 'tcp', e); });
    transport.once('close', () => {
      if (!settled) {
        clearTimeout(timer);
        const e = new Error('peer closed the connection before any response byte');
        e.name = 'SocketClosedError';
        fail(phases.proxyConnectResponded ? 'response' : 'connect', e);
      }
    });
  });
}

// ---------------------------------------------------------------- main

async function main() {
  const argv = process.argv.slice(2);
  const opt = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? fallback : argv[i + 1];
  };
  const host = opt('host', 'api.deepseek.com');
  const port = Number(opt('port', 443));
  const timeoutMs = Number(opt('timeout', 8000));
  const cwd = opt('cwd', process.cwd());
  const outFile = opt('jsonl', undefined);

  const noProcessProxy = argv.includes('--simulate-plain-launch');
  const env = layeredEnv(cwd, { noProcessProxy });
  const httpProxy = env.get('http_proxy');
  const httpsProxy = env.get('https_proxy');
  const noProxy = env.get('no_proxy');
  const proxyValue = httpsProxy ?? httpProxy;
  let proxy;
  let proxyRefusal;
  if (proxyValue) {
    try {
      const u = new URL(proxyValue.value);
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        const bypass = bypasses(noProxy?.value, host) || bypasses(LOOPBACK.join(','), host);
        if (!bypass) proxy = { host: u.hostname, port: Number(u.port || (u.protocol === 'https:' ? 443 : 80)), scheme: u.protocol, source: proxyValue.source, hasAuth: u.username !== '' };
      }
    } catch (e) {
      proxyRefusal = `proxy value from ${proxyValue.source} is not a URL: ${e.message}`;
    }
  }

  const report = {
    kind: 'dsh-diag/probe',
    version: 1,
    at: iso(now()),
    host: os.hostname(),
    platform: `${process.platform} ${os.release()}`,
    node: process.version,
    cwd,
    env: {
      http_proxy: httpProxy ? { source: httpProxy.source, value: redactUrl(httpProxy.value) } : null,
      https_proxy: httpsProxy ? { source: httpsProxy.source, value: redactUrl(httpsProxy.value) } : null,
      no_proxy: noProxy ? { source: noProxy.source, value: noProxy.value } : null,
      node_use_env_proxy: env.get('NODE_USE_ENV_PROXY')?.value ?? null,
      node_use_system_ca: env.get('NODE_USE_SYSTEM_CA')?.value ?? null,
      node_extra_ca_certs: env.get('NODE_EXTRA_CA_CERTS')?.value ?? null,
      tls_reject_unauthorized: env.get('NODE_TLS_REJECT_UNAUTHORIZED')?.value ?? null,
    },
    simulatedPlainLaunch: noProcessProxy || undefined,
    route: proxy ? { proxied: true, proxy: redactUrl(`http://${proxy.host}:${proxy.port}`), source: proxy.source } : { proxied: false, reason: proxyRefusal ?? 'no proxy configured, or host is in no_proxy' },
    results: [],
  };

  const target = '/anthropic/v1/messages';
  const repeat = Number(opt('repeat', 1));
  const skipLocal = argv.includes('--skip-local');

  if (proxy) {
    report.results.push(await tcpProbe(proxy.host, proxy.port, Math.min(timeoutMs, 3000)));
  }
  for (let i = 0; i < repeat; i++) {
    if (proxy) {
      report.results.push(await exchange({ label: 'proxied-POST', host, port, targetPath: target, method: 'POST', proxy, timeoutMs, extraHeaders: { 'content-type': 'application/json' }, body: '{}' }));
    }
    report.results.push(await exchange({ label: 'direct-POST', host, port, targetPath: target, method: 'POST', timeoutMs, extraHeaders: { 'content-type': 'application/json' }, body: '{}' }));
  }

  if (!skipLocal) {
    // Local providers from the profile patch, when configured.
    const locals = [
      { label: 'local-llamacpp', host: '127.0.0.1', port: 8080, path: '/v1/models' },
      { label: 'local-ollama', host: '127.0.0.1', port: 11434, path: '/v1/models' },
    ];
    for (const l of locals) report.results.push(await exchange({ label: l.label, host: l.host, port: l.port, targetPath: l.path, method: 'GET', timeoutMs: 2000 }));
  }

  if (repeat > 1) {
    const summarize = (label) => {
      const rows = report.results.filter((r) => r.label === label && r.phase !== 'tcp');
      const ok = rows.filter((r) => r.ok && r.status < 500);
      const times = rows.map((r) => r.elapsedMs).sort((a, b) => a - b);
      const pct = (p) => times[Math.min(times.length - 1, Math.floor(times.length * p))];
      return { label, attempts: rows.length, ok: ok.length, failed: rows.length - ok.length, p50ms: pct(0.5), p95ms: pct(0.95), maxMs: times[times.length - 1], failures: rows.filter((r) => !r.ok || r.status >= 500).map((r) => ({ at: r.at, failedAt: r.failedAt, status: r.status, elapsedMs: r.elapsedMs, error: describe(r.error) })) };
    };
    report.summary = [summarize('proxied-POST'), summarize('direct-POST')];
  }

  const line = JSON.stringify(report);
  if (outFile) {
    fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
    fs.appendFileSync(outFile, line + '\n', 'utf8');
  }
  // Human summary on stdout: one line per probe, no header values.
  for (const r of report.results) {
    if (r.phase === 'tcp') {
      console.log(`${r.ok ? 'PASS' : 'FAIL'} tcp ${host}:${port} ${r.elapsedMs}ms ${r.ok ? '' : describe(r.error)}`.trim());
      continue;
    }
    const okc = r.ok ? (r.status >= 200 && r.status < 500 ? 'PASS' : 'FAIL') : 'FAIL';
    console.log(`${okc} ${r.label.padEnd(14)} ${r.ok ? `${r.status} ${r.httpVersion} ${r.elapsedMs}ms` : `${r.elapsedMs}ms @${r.failedAt} ${describe(r.error)}`}`);
  }
  console.log(`route: ${report.route.proxied ? `proxy ${report.route.proxy} (${report.route.source})` : `direct 鈥?${report.route.reason}`}`);
  for (const s of report.summary ?? []) {
    console.log(`${s.label}: ok ${s.ok}/${s.attempts} p50 ${s.p50ms}ms p95 ${s.p95ms}ms max ${s.maxMs}ms`);
    for (const f of s.failures) console.log(`  fail ${f.at} @${f.failedAt} ${f.elapsedMs}ms ${f.status ?? ''} ${f.error ?? ''}`.trim());
  }
}

function describe(error) {
  if (!error) return '';
  return error.chain.map((c) => [c.name, c.code, c.message].filter(Boolean).join(' | ')).join(' << ');
}

/** Keep host:port, drop any userinfo and query so a proxy credential never lands in a log. */
function redactUrl(value) {
  try {
    const u = new URL(value);
    u.username = '';
    u.password = '';
    u.search = '';
    return u.toString().replace(/\/$/, '');
  } catch {
    return '<unparseable>';
  }
}

main().catch((error) => {
  console.error('probe failed:', error && error.stack || String(error));
  process.exitCode = 1;
});

