# dsh-diag

DeepSeek Harness（Windows）**模型请求反复失败**的诊断工具与一份完整复盘。

复盘的结论不是"重装试试"或"换个模型提供方"，而是一条可验证的因果链：**本地代理端口配对错误
→ `ECONNREFUSED`（1~2 ms）→ 被包装成 `transport failed` → 原始错误被丢弃 → 界面只能显示一句
无法定位的提示**。工具的作用是：在故障发生时，把被丢弃的那一层抓回来。

> 适用于 `v0.2.1-rc.2` 及同代架构（后台 Node 宿主 + undici 全局 dispatcher）。
> 不依赖具体代理软件，只依赖它把端口写在环境或 `.env` 里。

---

## 1. 症状

界面上反复出现：

```
DeepSeek Messages transport failed
已重试模型请求 (5/5)
```

特征（抓住这几条就能少走很多弯路）：

| 特征 | 含义 |
|---|---|
| 每次失败耗时 **1~20 ms** | 根本没完成一次网络往返，不是超时 |
| **从未**出现部分响应内容 | 失败发生在拿到任何数据之前 |
| 固定重试 5 次、退避 500 ms→10 s | `TRANSPORT` 在默认可重试码集合里 |
| 换模型提供方、禁用插件、重装、清缓存都无效 | 说明不在这些层 |
| 网页版/开放平台能登录，系统代理正常 | 说明不是账号或整机网络 |

---

## 2. 根因链路

```
启动 Harness（后台 Node 宿主进程）
  → 该进程读分层环境：进程环境 > 安装目录 .env > $DSH_HOME/.env
  → 得到 HTTPS_PROXY=http://127.0.0.1:<一个没有在监听的端口>
  → @deepseek-ai/dsh-http-proxy 安装 undici 全局 dispatcher，按该端口建隧道
  → dsh-llm-deepseek 调用全局 fetch → connect 被拒 → ECONNREFUSED（1~2 ms）
  → 同一文件的兜底 catch：
      new LlmError("… transport failed", "TRANSPORT", { cause: error })
  → UI 只渲染 .message；会话持久化只存 { message, code }
  → cause 链（含真实的 ECONNREFUSED / ENOTFOUND / CERT_* ）永久丢失
```

关键点有三个，缺一个都解释不完整：

1. **模型请求不在 Electron/Chromium 网络栈里**。它在后台 Node 宿主进程（由 Electron 主进程以
   `ELECTRON_RUN_AS_NODE` 拉起，内部直接 `runProfile()`）。所以 `--log-net-log` 抓不到任何模型
   请求，那不是"日志不够详细"，而是抓错了进程。
2. **代理来自 dsh 自己的 undici dispatcher，不是 Windows 系统代理**。它只读环境变量与 `.env`，
   完全无视 Windows 的"Internet 选项"。因此系统代理正常 ≠ Harness 正常。
3. **错误被包装且 cause 被丢弃**。`dsh-llm` 里其实有 `errorChain()` 能把整条 cause 链渲染出来，
   但 UI 和会话日志都没接。**这就是为什么同一个症状可能对应完全不同的底层原因，而界面上永远只有一句话。**

---

## 3. 为什么"设了环境变量就好，过一会又坏"

真实场景：机器上装了两个代理客户端，端口不同，经常切换（比如一个 33210、一个 7897）。

- 从**导出了正确端口**的终端启动 → 进程层压过 `.env` → 正常
- 从**桌面图标/开始菜单**启动 → 进程层没有该变量 → 回落 `.env`，而 `.env` 里写的是**另一个**端口 → 失败
- 把端口写进**用户级环境变量** → Harness 好了，但代理客户端自己也继承它、指向自己的端口，形成**自环**
  → 表现为"代理软件初始化异常"
- 把用户级变量删掉 → Harness 又回落到 `.env` 的错端口 → **故障复现**

结论：**"设变量"只改变了"这次从哪儿读"，没有消除"两个地方写着不同端口"这个结构性缺陷。**

同理，如果你的启动器（.vbs/.bat/快捷方式）里硬编码了某一个端口，那么切换代理工具后它必然失效——
补丁打在症状上，不是根因上。

---

## 4. 本地模型为什么是另一个问题

不要和上面的故障合并，它们看起来同时发生，但机制无关：

- `dsh-http-proxy` 的 `proxyForUrl()` 对本机地址**强制直连**（`isLoopbackHost` 覆盖 `localhost`、
  `127.0.0.0/8`、`::1`、IPv4-mapped），本地请求永远不会走代理。
- 实测：在同一套"坏代理"配置下，`http://127.0.0.1:PORT` 返回 **200 / 16 ms**，而
  `https://api.deepseek.com` 返回 **ECONNREFUSED / 3 ms**。互不影响。
- 本地模型失败的真实原因通常是**后端没启动**（端口无监听、无 `llama-server`/`ollama` 进程）。
- 文案也不同：本地走 `dsh-llm-pi-ai`，错误是 `pi-ai stream error …` /
  `pi-ai event stream ended without done/error`，**不会**是 `Messages transport failed`。

**把这两类故障当成同一个根因，是排查走偏最常见的原因。**

---

## 5. 工具

零依赖，只用 Node 内置模块 + PowerShell 5.1。全部输出仅存本机。

| 文件 | 作用 |
|---|---|
| `bin/probe.cjs` | 分层探针：TCP / 代理 CONNECT 状态行 / TLS 握手与证书 / 首字节 / 直连对照，五段独立计时 |
| `bin/check-proxy.cjs` | 判定某端口**是否真能当 HTTPS 代理用**（`CONNECT`+TLS+HTTP 全通才算，不是"在监听"就算） |
| `bin/fetch-hook.cjs` | 核心：包住 `globalThis.fetch`，站在 `LlmError` 包装层**之下**记录原始错误链 |
| `bin/report.cjs` | 把 JSONL 汇总成脱敏 Markdown，并按错误码给出分层判定 |
| `Set-DshProxy.ps1` | 自动探测当前可用端口 → 修正 `$DSH_HOME\.env` → 启动（适合多代理工具切换） |
| `Start-DshDiag.ps1` | 环境快照 + 注入钩子 + 启动 |
| `Watch-DshTransport.ps1` | 常驻观测，首次失败即高亮 |

安装目录、`$DSH_HOME` 都是自动探测的；也可用 `-InstallDir` 或 `DSH_INSTALL_DIR` 指定。

### 5.1 先做一次体检（只读）

```powershell
powershell -ExecutionPolicy Bypass -File .\Set-DshProxy.ps1 -DryRun
```

输出形如：

```
  OK   <port>   1100ms  CONNECT 200 → HTTP 401
  FAIL <port>   1180ms  connect: CONNECT 405      ← SOCKS 端口，自动排除
  FAIL <port>      1ms  tcp: ECONNREFUSED         ← 没有在监听
```

`401` 是**传输成功的证据**：不带凭据发请求，能拿到 401 说明 TCP、代理隧道、TLS、HTTP 全通。

### 5.2 复现故障并取证

```powershell
powershell -ExecutionPolicy Bypass -File .\Start-DshDiag.ps1
# 在界面里复现，然后：
& "<Harness 自带 node>" .\bin\report.cjs --logs .\logs
```

### 5.3 不改启动方式也能观测

```powershell
powershell -ExecutionPolicy Bypass -File .\Watch-DshTransport.ps1 -IntervalSeconds 20 -StopOnFailure
```

---

## 6. 按错误码判层

| 观测到的 | 层 | 含义 |
|---|---|---|
| `ECONNREFUSED` | TCP | 目标或代理端口拒绝连接：代理没起、端口写错 |
| `ENOTFOUND` / `EAI_AGAIN` | DNS | 域名解析失败 |
| `ECONNRESET` / `EPIPE`，且耗时 < 50 ms | TCP/TLS | 连接被重置：代理拒绝 CONNECT，或链路被中间设备切断 |
| `CERT_*` / `unable to verify` | TLS | 证书问题，多半是代理在做 TLS 中间人 —— 装它的根证书，**不要**关闭校验 |
| `UND_ERR_CONNECT_TIMEOUT` | TCP | 可达性差或黑洞路由 |
| 有 `firstByteMs`，随后 `stream-error` | HTTP | 长连接被切断，属于流式响应中途失败 |

---

## 7. 隐私设计

钩子与探针**不记录**：请求/响应正文、`Authorization`/`Cookie`/`API Key` 的值、完整提示词。

具体做法：

- 请求头只记**名称**，不记值（`requestHeaderNames: ["authorization","content-type"]`）
- URL 保留 origin + path，**去掉查询串与 userinfo**
- 请求体只记字节数，响应正文**从不读取**（用 `response.clone()` 旁路观察，原响应原样返回）
- 代理地址中的 `user:pass@` 一律替换为 `<userinfo>@`
- `NODE_OPTIONS` 注入只作用于本脚本拉起的进程树，**不写注册表、不写用户级/系统级环境变量**

`logs/` 已在 `.gitignore` 中：真实采集数据默认不进仓库。

---

## 8. 已知限制

1. 钩子只覆盖 `globalThis.fetch`。模型请求全部走它，但 Worker 线程、`node:http` 直连、
   Chromium 网络栈看不到。
2. DNS/TCP/TLS 的阶段区分由错误码反推；需要真分阶段计时请用 `probe.cjs`（它自己建连接）。
3. `NODE_OPTIONS` 也会进入 Electron 主进程。若某版本 Electron 因此启动异常，用
   `Start-DshDiag.ps1 -NoHook`，配合 `Watch-DshTransport.ps1` 观测（探针不需要注入）。
4. **纯插件方案拿不到 cause 链**。插件能拿到的只有 `agent/attempt` 事件里的
   `{ message, code }`，会话持久化存的也是这两个字段。要拿到下层错误，必须站到包装层之下。
5. 不建议用 `NODE_TLS_REJECT_UNAUTHORIZED=0` 绕过问题：它会把证书错误变成静默成功，
   正好抹掉要收集的证据。

---

## 9. 对上游的建议

如果这个复盘的结论对你有用，值得向 Harness 提一个 issue：

> `dsh-llm-deepseek` 的 `generate()` 把任何非 `LlmError` 的异常统一包成
> `LlmError("… transport failed", "TRANSPORT", { cause })`，但 UI 与会话持久化只保留
> `message` + `code`，`dsh-llm` 已有的 `errorChain()` 没有接到这两处。
> 结果是：**同一个提示可能对应端口拒绝、DNS 失败、证书错误、流中断等完全不同的原因，
> 用户与支持者都无法区分。** 建议至少把 cause 链的最后一环（如 `ECONNREFUSED`）渲染进
> 错误提示与会话日志。

---

## License

MIT
