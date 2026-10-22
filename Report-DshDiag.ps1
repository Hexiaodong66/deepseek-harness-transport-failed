#Requires -Version 5.1
<#
.SYNOPSIS
  把采集到的 JSONL 汇总成一份脱敏 Markdown 报告（可直接分享）。

.DESCRIPTION
  读取 <LogDir>\*.jsonl（探测记录与钩子记录可混放），输出：
    - 请求总体情况（成功数、首字节 p50/p95、状态码）
    - 失败明细（时间、请求、耗时、错误层、错误链 code）
    - 流式中断、重试簇
    - 探针记录与分层结论

  报告不含：请求/响应正文、Authorization/Cookie/API Key 的值、完整提示词。

.PARAMETER InstallDir
  Harness 安装目录，用于找它自带的 Node。省略时自动探测，或读 DSH_INSTALL_DIR。

.PARAMETER LogDir
  采集目录，默认 <本目录>\logs。

.PARAMETER Out
  报告输出路径。省略时写到 <LogDir>\report-<时间>.md。

.EXAMPLE
  .\Report-DshDiag.ps1
  .\Report-DshDiag.ps1 -LogDir .\samples
#>
[CmdletBinding()]
param(
    [string]$InstallDir,
    [string]$LogDir,
    [string]$Out
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $root 'lib\Resolve-Dsh.ps1')

if (-not $LogDir) { $LogDir = Join-Path $root 'logs' }

$files = @()
if (Test-Path -LiteralPath $LogDir) {
    $files = @(Get-ChildItem -LiteralPath $LogDir -Filter '*.jsonl' -File -ErrorAction SilentlyContinue)
}
if ($files.Count -eq 0) {
    Write-Host "在 $LogDir 里没有找到任何 .jsonl 采集文件。" -ForegroundColor Yellow
    Write-Host '先用 .\Start-DshDiag.ps1 带钩子启动并复现一次，或用 .\Watch-DshTransport.ps1 常驻观测。' -ForegroundColor Yellow
    exit 1
}

# Node 优先用 Harness 自带的，保证与它实际运行时同版本。
$nodeExe = $null
try { $nodeExe = Resolve-DshNode -InstallDir (Resolve-DshInstall -Explicit $InstallDir) }
catch { $nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source }
if (-not $nodeExe) { throw '找不到 node 运行时。' }

$report = Join-Path $root 'bin\report.cjs'
if (-not (Test-Path -LiteralPath $report)) { throw "缺少文件：$report" }

$args = @($report, '--logs', (Resolve-Path -LiteralPath $LogDir).Path)
if ($Out) { $args += @('--out', $Out) }

& $nodeExe @args
if ($LASTEXITCODE -ne 0) { throw "报告生成失败（退出码 $LASTEXITCODE）。" }

Write-Host ''
Write-Host '这份报告可以直接分享：URL 已去查询串，请求头只保留名称，响应正文从未读取。' -ForegroundColor Green
Write-Host '发送前若想再确认一遍：' -ForegroundColor DarkGray
Write-Host "  Select-String -Path '$LogDir\*.jsonl' -Pattern 'Bearer|sk-|cookie' -SimpleMatch" -ForegroundColor DarkGray
Write-Host '  正常应当零命中。' -ForegroundColor DarkGray
