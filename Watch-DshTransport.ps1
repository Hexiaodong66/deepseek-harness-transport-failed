#Requires -Version 5.1
<#
.SYNOPSIS
  持续探测 Harness 的出网链路，第一次失败时立刻停下并打印分层结论。

.DESCRIPTION
  不改任何环境、不碰 Harness 进程。每 -IntervalSeconds 秒跑一次 probe.cjs，
  结果追加到 logs\probe-<stamp>.jsonl。出现失败立即高亮，并保留全部历史。

.EXAMPLE
  .\Watch-DshTransport.ps1
  .\Watch-DshTransport.ps1 -IntervalSeconds 10 -StopOnFailure
#>
[CmdletBinding()]
param(
    [string]$InstallDir,
    [int]$IntervalSeconds = 30,
    [switch]$StopOnFailure,
    [string]$LogDir
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $root 'lib\Resolve-Dsh.ps1')

if (-not $LogDir) { $LogDir = Join-Path $root 'logs' }
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$InstallDir = Resolve-DshInstall -Explicit $InstallDir
$nodeExe = Resolve-DshNode -InstallDir $InstallDir
$probe = Join-Path $root 'bin\probe.cjs'
$jsonl = Join-Path $LogDir ('probe-{0}.jsonl' -f (Get-Date -Format 'yyyyMMdd-HHmmss'))

Write-Host ('观测中：每 {0}s 一次，输出 {1}  (Ctrl+C 结束)' -f $IntervalSeconds, $jsonl) -ForegroundColor Cyan

$round = 0
while ($true) {
    $round++
    $lines = & $nodeExe $probe --cwd $InstallDir --skip-local --jsonl $jsonl 2>&1
    $fail = $lines | Where-Object { $_ -match '^FAIL' }
    $stamp = Get-Date -Format 'HH:mm:ss'
    if ($fail) {
        Write-Host ('[{0}] 第 {1} 轮 —— 失败' -f $stamp, $round) -ForegroundColor Red
        $fail | ForEach-Object { Write-Host "    $_" -ForegroundColor Red }
        $lines | Where-Object { $_ -match '^route:' } | ForEach-Object { Write-Host "    $_" -ForegroundColor Yellow }
        if ($StopOnFailure) {
            Write-Host '已按 -StopOnFailure 停止。' -ForegroundColor Yellow
            break
        }
    } else {
        $summary = ($lines | Where-Object { $_ -match '^(PASS|route:)' }) -join ' | '
        Write-Host ('[{0}] 第 {1} 轮 正常  {2}' -f $stamp, $round, $summary)
    }
    Start-Sleep -Seconds $IntervalSeconds
}
