#!/usr/bin/env node
/**
 * dsh-diag report — turn the JSONL the hook and probe wrote into one redacted report.
 *
 *   node.exe bin\report.cjs [--logs DIR] [--out FILE]
 *
 * Inputs:  *.jsonl in the log directory (hook records + probe records, mixed is fine)
 * Output:  a Markdown report + a one-screen verdict on stdout.
 *
 * Nothing here re-reads bodies, headers, keys, or cookies: the hook never wrote them.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const argv = process.argv.slice(2);
const opt = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i === -1 ? fallback : argv[i + 1]; };
const root = path.resolve(__dirname, '..');
const logDir = opt('logs', path.join(root, 'logs'));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outFile = opt('out', path.join(logDir, `report-${stamp}.md`));

function readRecords(dir) {
  const records = [];
  if (!fs.existsSync(dir)) return records;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.jsonl')) continue;
    const file = path.join(dir, name);
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      try { records.push({ ...JSON.parse(line), _file: name }); } catch { /* torn last line */ }
    }
  }
  records.sort((a, b) => (a.atMs || 0) - (b.atMs || 0));
  return records;
}

const records = readRecords(logDir);
const fetches = records.filter((r) => r.kind && r.kind.startsWith('fetch/'));
const probes = records.filter((r) => r.kind === 'dsh-diag/probe');
const snapshotsFree = records.filter((r) => r.kind === 'hook/installed');

// ---------------------------------------------------------------- classification

function classify(entry) {
  const codes = entry.error.map((c) => c.code).filter(Boolean);
  const has = (code) => codes.includes(code);
  const elapsed = entry.elapsedMs ?? -1;
  if (has('ECONNREFUSED')) return { layer: 'TCP', verdict: '目标或代理端口拒绝连接（对端未监听）', action: '确认代理是否在跑，以及生效的端口号是否正确' };
  if (has('ENOTFOUND') || has('EAI_AGAIN')) return { layer: 'DNS', verdict: '域名解析失败', action: '检查 DNS 与代理的远端解析；确认没有把本地 DNS 指向已下线的服务' };
  if (has('ECONNRESET') || has('EPIPE') || has('UND_ERR_SOCKET')) {
    return { layer: 'TCP/TLS', verdict: '连接被重置（对端或中间设备主动断开）', action: '区分代理拒绝 CONNECT 与链路被中断：对照 probe 的 proxyConnect 状态' };
  }
  if (codes.some((c) => /CERT|UNABLE_TO_VERIFY|SELF_SIGNED|ERR_TLS/i.test(c)) || /wrong version number/i.test(entry.error.map((c) => c.message).join(' '))) {
    return { layer: 'TLS', verdict: 'TLS 握手/证书校验失败', action: '检查代理是否做了 TLS 中间人、系统根证书是否被信任；不要关闭校验' };
  }
  if (has('UND_ERR_CONNECT_TIMEOUT') || has('ETIMEDOUT')) return { layer: 'TCP', verdict: '连接超时（可达性差或黑洞路由）', action: '对比直连与代理的耗时，确认走的是哪条路径' };
  if (has('UND_ERR_HEADERS_TIMEOUT') || has('UND_ERR_BODY_TIMEOUT')) return { layer: 'HTTP', verdict: '响应头/响应体超时', action: '看 firstByteMs 与 streamMs，判断卡在首字节还是流中' };
  if (elapsed >= 0 && elapsed < 50) return { layer: 'pre-connect', verdict: '极快失败（未完成一次网络往返）', action: '通常是对端拒绝、端口写错，或请求在本地就被判定失败' };
  return { layer: 'unknown', verdict: '未归类的传输失败', action: '查看完整 error 链与 probe 记录' };
}

// ---------------------------------------------------------------- aggregation

const failures = fetches.filter((r) => r.kind === 'fetch/failed');
const okResponses = fetches.filter((r) => r.kind === 'fetch/response' && r.status < 500);
const streamErrors = fetches.filter((r) => r.kind === 'fetch/stream-error');

const byUrl = new Map();
for (const r of fetches) {
  if (r.kind !== 'fetch/response') continue;
  const key = `${r.method} ${r.url}`;
  const cur = byUrl.get(key) || { key, ok: 0, bad: 0, times: [], statuses: [] };
  if (r.status < 500) { cur.ok++; cur.times.push(r.headersMs); } else cur.bad++;
  cur.statuses.push(r.status);
  byUrl.set(key, cur);
}
const quantile = (arr, q) => {
  if (arr.length === 0) return undefined;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))];
};

/** 同一 URL 在 5 秒内的连续失败，等价于 dsh 的 5 次重试。 */
const bursts = [];
for (const f of failures) {
  const last = bursts[bursts.length - 1];
  if (last && last.url === f.url && f.atMs - last.endMs < 5000) {
    last.count++; last.endMs = f.atMs; last.items.push(f);
  } else {
    bursts.push({ url: f.url, method: f.method, startMs: f.atMs, endMs: f.atMs, count: 1, items: [f] });
  }
}

// ---------------------------------------------------------------- report

const lines = [];
const push = (...a) => lines.push(...a);

push('# DeepSeek Harness 传输故障诊断报告', '');
push(`生成时间：${new Date().toISOString()}  `);
push(`日志目录：\`${logDir}\`  `);
push(`记录数：fetch ${fetches.length} 条 / probe ${probes.length} 次 / 钩子装载 ${snapshotsFree.length} 次`, '');

push('## 1. 采集范围与隐私状态', '');
push('本报告只使用钩子与探针写下的结构化字段：URL（已去查询串）、方法、请求头**名称**、请求体字节数、状态码、耗时、错误链。', '');
push('不包含：Authorization / Cookie / API Key 的值、请求与响应正文、完整提示词。', '');

push('## 2. 请求总体情况', '');
if (byUrl.size === 0) {
  push('_没有捕获到任何 HTTP 响应记录。_', '');
} else {
  push('| 请求 | 成功 | 失败(5xx) | 首字节 p50 | 首字节 p95 | 状态码 |', '| --- | --- | --- | --- | --- | --- |');
  for (const v of byUrl.values()) {
    push(`| \`${v.key}\` | ${v.ok} | ${v.bad} | ${quantile(v.times, 0.5) ?? '-'} ms | ${quantile(v.times, 0.95) ?? '-'} ms | ${[...new Set(v.statuses)].join(', ')} |`);
  }
  push('');
}

push('## 3. 失败明细', '');
if (failures.length === 0) {
  push('_没有 fetch 失败记录。_', '');
} else {
  push('| 时间 | 请求 | 耗时 | 错误层 | 判定 | 错误链（code） |', '| --- | --- | --- | --- | --- | --- |');
  for (const f of failures.slice(-40)) {
    const c = classify(f);
    const chain = f.error.map((e) => [e.name, e.code, e.message].filter(Boolean).join(': ')).join(' ← ').slice(0, 160);
    push(`| ${f.at} | \`${f.method} ${f.url}\` | ${f.elapsedMs} ms | ${c.layer} | ${c.verdict} | ${chain.replace(/\|/g, '\\|')} |`);
  }
  push('');
}

push('## 4. 流式响应中断', '');
if (streamErrors.length === 0) {
  push('_没有流式响应中断记录。_', '');
} else {
  push('| 时间 | 请求 | 首字节 | 已收字节 | 错误 |', '| --- | --- | --- | --- | --- |');
  for (const s of streamErrors.slice(-20)) {
    push(`| ${s.failedAt} | \`${s.method} ${s.url}\` | ${s.firstByteMs ?? '-'} ms | ${s.bytes} | ${s.error.map((e) => e.code || e.name).join(' ← ')} |`);
  }
  push('');
}

if (bursts.length > 0) {
  push('## 5. 重试簇（对应界面上的“已重试模型请求 n/5”）', '');
  for (const b of bursts) {
    const span = b.endMs - b.startMs;
    const c = classify(b.items[0]);
    const each = b.items.map((i) => i.elapsedMs).sort((x, y) => x - y);
    push(`- ${new Date(b.startMs).toISOString()} \`${b.method} ${b.url}\` → ${b.count} 次连续失败，簇跨度 ${span} ms，` +
      `单次耗时 ${each[0]}–${each[each.length - 1]} ms（含 dsh 退避等待，故簇跨度远大于单次），判定：${c.verdict}`);
  }
  push('');
}

if (probes.length > 0) {
  push('## 6. 探针记录（独立于 Harness 进程的分层结论）', '');
  push('| 时间 | 生效路由 | 代理 TCP | 代理 CONNECT | TLS | 状态 | 说明 |', '| --- | --- | --- | --- | --- | --- | --- |');
  for (const p of probes.slice(-20)) {
    const tcp = p.results.find((r) => r.phase === 'tcp');
    const proxied = p.results.find((r) => r.label === 'proxied-POST');
    const direct = p.results.find((r) => r.label === 'direct-POST');
    const pc = proxied && proxied.phases && proxied.phases.proxyConnect ? proxied.phases.proxyConnect.status : '-';
    const tls = proxied && proxied.phases && proxied.phases.tls ? (proxied.phases.tls.authorized ? 'OK' : String(proxied.phases.tls.authorizationError || 'FAIL')) : '-';
    const statusText = proxied ? (proxied.ok ? `HTTP ${proxied.status}` : `FAIL @${proxied.failedAt}`) : (direct ? `direct ${direct.status ?? 'FAIL'}` : '-');
    const note = proxied && proxied.error ? proxied.error.chain.map((e) => e.code || e.message).filter(Boolean).join(' ← ').slice(0, 90) : (p.route.proxied ? `via ${p.route.proxy}` : `direct(${p.route.reason})`);
    push(`| ${p.at} | ${p.route.proxied ? p.route.proxy : 'direct'} | ${tcp ? (tcp.ok ? tcp.elapsedMs + 'ms' : 'FAIL') : '-'} | ${pc} | ${tls} | ${statusText} | ${note} |`);
  }
  push('');
}

push('## 7. 结论', '');
if (failures.length === 0 && probes.every((p) => p.results.every((r) => r.ok || r.phase === 'tcp'))) {
  push('本次采集窗口内没有失败。若故障可复现，请用 `Watch-DshTransport.ps1` 在故障时段常驻观测，或用 `Start-DshDiag.ps1` 带着钩子启动。', '');
} else {
  const counter = new Map();
  for (const f of failures) {
    const c = classify(f);
    counter.set(c.verdict, (counter.get(c.verdict) || 0) + 1);
  }
  const ranked = [...counter.entries()].sort((a, b) => b[1] - a[1]);
  for (const [verdict, n] of ranked) push(`- ${n} 次：**${verdict}**`);
  push('');
  const first = failures[0];
  const c = classify(first);
  push(`最早一次失败的定位：**${c.layer} 层** —— ${c.verdict}；建议：${c.action}。`, '');
}
push('---', '');
push('脱敏说明：URL 已去掉查询串与 userinfo；请求头只记录名称；响应正文从未读取。');

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, lines.join('\n'), 'utf8');

// ---------------------------------------------------------------- console verdict

console.log(`records: fetch=${fetches.length} probe=${probes.length} hooks=${snapshotsFree.length}`);
console.log(`failures: ${failures.length}  stream-errors: ${streamErrors.length}  bursts: ${bursts.length}`);
for (const [verdict, n] of [...new Map(failures.map((f) => [classify(f).verdict, 0])).keys()].map((k) => [k, failures.filter((f) => classify(f).verdict === k).length])) {
  console.log(`  ${n}× ${verdict}`);
}
console.log(`report: ${outFile}`);
