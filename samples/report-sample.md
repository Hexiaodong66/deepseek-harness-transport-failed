# DeepSeek Harness 传输故障诊断报告

生成时间：2026-10-22T06:49:48.017Z  
日志目录：`.\samples`  
记录数：fetch 4 条 / probe 1 次 / 钩子装载 1 次

## 1. 采集范围与隐私状态

本报告只使用钩子与探针写下的结构化字段：URL（已去查询串）、方法、请求头**名称**、请求体字节数、状态码、耗时、错误链。

不包含：Authorization / Cookie / API Key 的值、请求与响应正文、完整提示词。

## 2. 请求总体情况

| 请求 | 成功 | 失败(5xx) | 首字节 p50 | 首字节 p95 | 状态码 |
| --- | --- | --- | --- | --- | --- |
| `POST https://api.deepseek.com/anthropic/v1/messages` | 1 | 0 | 1240 ms | 1240 ms | 401 |

## 3. 失败明细

| 时间 | 请求 | 耗时 | 错误层 | 判定 | 错误链（code） |
| --- | --- | --- | --- | --- | --- |
| 2026-01-01T10:00:05.100Z | `POST https://api.deepseek.com/anthropic/v1/messages` | 3 ms | TCP | 目标或代理端口拒绝连接（对端未监听） | TypeError: fetch failed ← Error: ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:7897 |

## 4. 流式响应中断

_没有流式响应中断记录。_

## 5. 重试簇（对应界面上的“已重试模型请求 n/5”）

- 2026-01-01T07:20:05.100Z `POST https://api.deepseek.com/anthropic/v1/messages` → 1 次连续失败，簇跨度 0 ms，单次耗时 3–3 ms（含 dsh 退避等待，故簇跨度远大于单次），判定：目标或代理端口拒绝连接（对端未监听）

## 6. 探针记录（独立于 Harness 进程的分层结论）

| 时间 | 生效路由 | 代理 TCP | 代理 CONNECT | TLS | 状态 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-01-01T10:01:00.000Z | http://127.0.0.1:7897 | - | - | - | FAIL @proxy-connect | ECONNREFUSED |

## 7. 结论

- 1 次：**目标或代理端口拒绝连接（对端未监听）**

最早一次失败的定位：**TCP 层** —— 目标或代理端口拒绝连接（对端未监听）；建议：确认代理是否在跑，以及生效的端口号是否正确。

---

脱敏说明：URL 已去掉查询串与 userinfo；请求头只记录名称；响应正文从未读取。