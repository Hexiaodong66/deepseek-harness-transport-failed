/**
 * dsh-diag fetch hook — records every outbound fetch with its real error chain.
 *
 * Loaded only into a process tree you launch yourself:
 *   set NODE_OPTIONS=--require "D:\path\to\fetch-hook.cjs"
 *
 * Why a hook instead of a plugin: dsh-llm-deepseek wraps any failure of the
 * Messages request in `new LlmError("DeepSeek Messages transport failed",
 * "TRANSPORT", { cause })`. The wrapper keeps only `message` + `code` in the
 * session log, so the undici/Node error that actually happened is gone by the
 * time any plugin or the UI can see it. This hook sits at `globalThis.fetch`,
 * one layer *below* that wrapper, and records the pristine error before dsh
 * rewraps it.
 *
 * Privacy: header NAMES only (never values), URL without query or userinfo,
 * request body as a byte count only, response body never read. Nothing leaves
 * the machine.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

(function install() {
  const globalKey = Symbol.for('dsh.diag.fetchHook');
  if (globalThis[globalKey]) return;
  globalThis[globalKey] = true;

  const outDir = process.env.DSH_DIAG_DIR || path.join(os.homedir(), '.dsh', 'diagnostics');
  const maxBytes = Number(process.env.DSH_DIAG_MAX_BYTES || 32 * 1024 * 1024);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(outDir, `transport-${stamp}-${process.pid}.jsonl`);

  try { fs.mkdirSync(outDir, { recursive: true }); } catch { /* keep going: a missing dir must not break the host */ }

  let written = 0;
  let disabled = false;

  function write(record) {
    if (disabled) return;
    let line;
    try { line = JSON.stringify(record) + '\n'; } catch { return; }
    if (written > maxBytes) { disabled = true; return; }
    try {
      fs.appendFileSync(file, line, 'utf8');
      written += line.length;
    } catch {
      disabled = true;
    }
  }

  // -------------------------------------------------------------- redaction

  const SECRET_HEADERS = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token|x-amz-security-token|anthropic-key)$/i;

  function headerNames(headers) {
    const names = [];
    try {
      if (headers && typeof headers.forEach === 'function' && !Array.isArray(headers)) {
        headers.forEach((_v, k) => names.push(String(k).toLowerCase()));
      } else if (Array.isArray(headers)) {
        for (const pair of headers) if (pair && pair.length >= 1) names.push(String(pair[0]).toLowerCase());
      } else if (headers && typeof headers === 'object') {
        for (const k of Object.keys(headers)) names.push(String(k).toLowerCase());
      }
    } catch { /* ignore */ }
    return [...new Set(names)].sort();
  }

  /**
   * Keep origin + path so a route is identifiable, drop query and userinfo so a
   * signed URL or an embedded credential cannot land in the log.
   */
  function safeUrl(input) {
    let raw;
    try {
      raw = typeof input === 'string' ? input : (input && input.url) || String(input);
    } catch { return '<unreadable>'; }
    try {
      const u = new URL(raw);
      return `${u.protocol}//${u.host}${u.pathname}`;
    } catch {
      return '<unparseable>';
    }
  }

  /** Flatten an error and every `cause`, keeping the codes that identify the failing layer. */
  function chain(error) {
    const out = [];
    let cur = error;
    for (let depth = 0; cur && depth < 10; depth++) {
      const entry = {
        name: cur.name,
        message: typeof cur.message === 'string' ? cur.message.slice(0, 500) : undefined,
        code: cur.code,
        errno: cur.errno,
        syscall: cur.syscall,
        hostname: cur.hostname,
        address: cur.address,
        port: cur.port,
        library: cur.library,
        reason: typeof cur.reason === 'string' ? cur.reason : undefined,
      };
      if (cur instanceof AggregateError && Array.isArray(cur.errors)) {
        entry.aggregate = cur.errors.map((e) => ({ name: e && e.name, message: e && String(e.message).slice(0, 200), code: e && e.code }));
      }
      for (const k of Object.keys(entry)) if (entry[k] === undefined) delete entry[k];
      out.push(entry);
      cur = cur.cause;
    }
    return out;
  }

  const base = {
    v: 1,
    pid: process.pid,
    ppid: process.ppid,
    execPath: process.execPath,
    argv: process.argv.slice(0, 3).map((a) => path.basename(a)),
    node: process.version,
    platform: process.platform,
  };

  write({ ...base, kind: 'hook/installed', at: new Date().toISOString(), atMs: Date.now(), dir: outDir, file });

  // --------------------------------------------------------------- wrapping

  const realFetch = globalThis.fetch;
  if (typeof realFetch !== 'function') {
    write({ ...base, kind: 'hook/unavailable', at: new Date().toISOString(), note: 'globalThis.fetch is not a function' });
    return;
  }

  globalThis.fetch = function dshDiagFetch(input, init) {
    const id = `${process.pid}-${(dshDiagFetch.seq = (dshDiagFetch.seq || 0) + 1)}`;
    const startedAt = Date.now();
    const startedIso = new Date(startedAt).toISOString();
    const url = safeUrl(input);
    const method = (init && init.method) || (input && input.method) || 'GET';
    const reqHeaders = headerNames((init && init.headers) || (input && input.headers));
    let bodyBytes;
    try {
      const b = init && init.body;
      bodyBytes = b == null ? 0 : typeof b === 'string' ? Buffer.byteLength(b) : b instanceof Uint8Array ? b.byteLength : undefined;
    } catch { /* ignore */ }

    const record = {
      ...base,
      kind: 'fetch',
      id,
      url,
      method,
      at: startedIso,
      atMs: startedAt,
      requestHeaderNames: reqHeaders,
      requestBodyBytes: bodyBytes,
      hasSignal: Boolean(init && init.signal),
    };

    return realFetch.call(this, input, init).then(
      (response) => {
        const headersAt = Date.now();
        const result = {
          ...record,
          kind: 'fetch/response',
          respondedAt: new Date(headersAt).toISOString(),
          respondedAtMs: headersAt,
          headersMs: headersAt - startedAt,
          status: response.status,
          statusText: response.statusText,
          httpVersionHint: response.redirected ? 'redirected' : undefined,
          responseHeaderNames: headerNames(response.headers),
          contentLength: response.headers.get('content-length') || undefined,
          contentType: response.headers.get('content-type') || undefined,
          streaming: Boolean(response.body),
        };
        // Observe the body through a tee'd clone so the response the caller gets
        // back is the untouched original — an SSE stream must reach dsh intact.
        if (response.body) {
          try {
            const observer = response.clone();
            const reader = observer.body.getReader();
            let firstByteAt;
            let bytes = 0;
            const pump = () => reader.read().then(({ done, value }) => {
              if (done) {
                write({ ...result, kind: 'fetch/stream-end', endedAtMs: Date.now(), endedAt: new Date().toISOString(), firstByteMs: firstByteAt === undefined ? undefined : firstByteAt - startedAt, streamMs: Date.now() - startedAt, bytes });
                return;
              }
              if (firstByteAt === undefined) {
                firstByteAt = Date.now();
                write({ ...result, kind: 'fetch/first-byte', firstByteAt: new Date(firstByteAt).toISOString(), firstByteMs: firstByteAt - startedAt, firstChunkBytes: value ? value.byteLength : 0 });
              }
              bytes += value ? value.byteLength : 0;
              return pump();
            }, (error) => {
              write({ ...result, kind: 'fetch/stream-error', failedAtMs: Date.now(), firstByteMs: firstByteAt === undefined ? undefined : firstByteAt - startedAt, streamMs: Date.now() - startedAt, bytes, error: chain(error) });
            });
            pump();
          } catch (error) {
            write({ ...result, kind: 'fetch/stream-hook-error', error: chain(error) });
          }
        }
        write(result);
        return response;
      },
      (error) => {
        const failedAt = Date.now();
        write({
          ...record,
          kind: 'fetch/failed',
          failedAt: new Date(failedAt).toISOString(),
          failedAtMs: failedAt,
          elapsedMs: failedAt - startedAt,
          error: chain(error),
          stack: error && typeof error.stack === 'string' ? error.stack.split('\n').slice(0, 6).join('\n').slice(0, 800) : undefined,
        });
        throw error;
      },
    );
  };

  // Preserve identity checks some libraries perform on fetch.
  try { Object.defineProperty(globalThis.fetch, 'name', { value: 'fetch' }); } catch {}

  // Crash hooks are opt-in: registering an 'uncaughtException' listener changes
  // Node's crash semantics (the process stops exiting), so the host must ask.
  if (process.env.DSH_DIAG_CRASH_HOOK === '1') {
    process.on('unhandledRejection', (reason) => {
      write({ ...base, kind: 'unhandledRejection', at: new Date().toISOString(), atMs: Date.now(), error: chain(reason) });
    });
    process.on('uncaughtException', (error) => {
      write({ ...base, kind: 'uncaughtException', at: new Date().toISOString(), atMs: Date.now(), error: chain(error) });
    });
  }

  write({ ...base, kind: 'hook/ready', at: new Date().toISOString(), atMs: Date.now(), outputFile: file });
})();
