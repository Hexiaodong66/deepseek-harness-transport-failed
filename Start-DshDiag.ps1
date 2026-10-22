#Requires -Version 5.1
<#
.SYNOPSIS
  以诊断模式启动 DeepSeek Harness：快照环境 + 注入 fetch 钩子 + 把每个请求记到本地 JSONL。

.DESCRIPTION
  只在本进程树内设置环境变量（$env:），不改注册表、不改用户级/系统级环境变量、
  不改 .env、不改 profile。脚本退出后，被启动的 Harness 继续运行并保留它拿到的副本。

  注入方式：NODE_OPTIONS=--require <bin\fetch-hook.cjs>。Windows 上 NODE_OPTIONS 会被
  二次解析，路径必须用正斜杠 + 双引号，否则反斜杠会被吃掉——这是实测结论。

.PARAMETER InstallDir
  Harness 安装目录。省略时自动探测，或读环境变量 DSH_INSTALL_DIR。

.PARAMETER DryRun
  只打印将要使用的环境与注入参数，不启动 Harness。

.PARAMETER NoHook
  不注入 fetch 钩子（NODE_OPTIONS 不变）。用于怀疑注入影响启动时。

.PARAMETER LogDir
  诊断输出目录，默认 <本目录>\logs。

.EXAMPLE
  .\Start-DshDiag.ps1 -DryRun
  .\Start-DshDiag.ps1
  .\Start-DshDiag.ps1 -NoHook
#>
[CmdletBinding()]
param(
    [string]$InstallDir,
    [switch]$DryRun,
    [switch]$NoHook,
    [string]$LogDir
)

$ErrorActionPreference = 'Stop'
$script:Root = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $script:Root 'lib\Resolve-Dsh.ps1')

if (-not $LogDir) { $LogDir = Join-Path $script:Root 'logs' }
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$InstallDir = Resolve-DshInstall -Explicit $InstallDir
$exe = Join-Path $InstallDir 'DeepSeek Harness.exe'
$nodeExe = Resolve-DshNode -InstallDir $InstallDir
$hookPath = Join-Path $script:Root 'bin\fetch-hook.cjs'
$dshHome = Resolve-DshHome
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$snapshotPath = Join-Path $LogDir "snapshot-$stamp.json"

foreach ($p in @($exe, $nodeExe, $hookPath)) { if (-not (Test-Path -LiteralPath $p)) { throw "缺少文件：$p" } }

# ------------------------------------------------------------------ 快照

function Get-ProxyEnvView {
    $names = 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
             'NODE_USE_ENV_PROXY', 'NODE_USE_SYSTEM_CA', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_OPTIONS'
    $out = [ordered]@{}
    foreach ($n in $names) {
        $v = [Environment]::GetEnvironmentVariable($n, 'Process')
        if ($null -ne $v -and $v -ne '') {
            # 去掉 userinfo，避免代理凭据落盘
            $out[$n] = ($v -replace '(?<=//)[^/@]+@', '<userinfo>@')
        }
    }
    return $out
}

function Read-EnvFile([string]$path) {
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    $map = [ordered]@{}
    foreach ($line in Get-Content -LiteralPath $path) {
        $t = $line.Trim()
        if ($t -eq '' -or $t.StartsWith('#')) { continue }
        $i = $t.IndexOf('=')
        if ($i -le 0) { continue }
        $map[$t.Substring(0, $i).Trim()] = ($t.Substring($i + 1).Trim() -replace '(?<=//)[^/@]+@', '<userinfo>@')
    }
    return $map
}

function Test-ProxyPort([string]$proxyUrl) {
    $result = [ordered]@{ url = $proxyUrl; host = $null; port = $null; listening = $false; owner = $null; elapsedMs = $null }
    if (-not $proxyUrl) { return $result }
    try {
        $u = [Uri]$proxyUrl
        $result.host = $u.Host
        $result.port = if ($u.Port -gt 0) { $u.Port } else { 80 }
        $sw = [Diagnostics.Stopwatch]::StartNew()
        $client = [System.Net.Sockets.TcpClient]::new()
        try {
            $ok = $client.ConnectAsync($result.host, $result.port).Wait(2000)
            $result.listening = $ok -and $client.Connected
        } catch { $result.listening = $false } finally { $client.Dispose() }
        $sw.Stop()
        $result.elapsedMs = $sw.ElapsedMilliseconds
    } catch { $result.error = 'unparseable proxy url' }
    try {
        $conn = Get-NetTCPConnection -State Listen -LocalPort $result.port -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($conn) { $result.owner = (Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue).ProcessName }
    } catch { }
    return $result
}

$homeEnvFile = Join-Path $dshHome '.env'
$projectEnvFile = Join-Path $InstallDir '.env'
$envView = Get-ProxyEnvView
$homeEnv = Read-EnvFile $homeEnvFile
$projectEnv = Read-EnvFile $projectEnvFile

# dsh-app-boot 的层级优先级：进程 > 项目 .env > 用户 .env；进程层缺失时由 .env 兜底。
$effective = $null; $source = 'none'
foreach ($name in 'HTTPS_PROXY', 'https_proxy') {
    if (-not $effective -and $envView[$name]) { $effective = $envView[$name]; $source = 'process' }
}
if (-not $effective -and $projectEnv) {
    foreach ($name in 'HTTPS_PROXY', 'https_proxy') {
        if (-not $effective -and $projectEnv[$name]) { $effective = $projectEnv[$name]; $source = "project-env:$projectEnvFile" }
    }
}
if (-not $effective -and $homeEnv) {
    foreach ($name in 'HTTPS_PROXY', 'https_proxy') {
        if (-not $effective -and $homeEnv[$name]) { $effective = $homeEnv[$name]; $source = "user-env:$homeEnvFile" }
    }
}

$snapshot = [ordered]@{
    kind                = 'dsh-diag/snapshot'
    at                  = (Get-Date).ToString('o')
    installDir          = $InstallDir
    appVersion          = (Get-Content -LiteralPath (Join-Path $InstallDir 'version') -Raw -ErrorAction SilentlyContinue).Trim()
    nodeVersion         = (& $nodeExe -v 2>$null)
    powershell          = $PSVersionTable.PSVersion.ToString()
    processEnv          = $envView
    homeEnvFile         = @{ path = $homeEnvFile; exists = (Test-Path -LiteralPath $homeEnvFile); values = $homeEnv }
    projectEnvFile      = @{ path = $projectEnvFile; exists = (Test-Path -LiteralPath $projectEnvFile); values = $projectEnv }
    effectiveHttpsProxy = @{ value = $effective; source = $source }
    proxyReachability   = @(Test-ProxyPort $effective)
    winInet             = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction SilentlyContinue |
                            Select-Object ProxyEnable, ProxyServer, ProxyOverride, AutoConfigURL)
    localModels         = @(
        @{ name = 'llama.cpp'; port = 8080 },
        @{ name = 'ollama';    port = 11434 }
    ) | ForEach-Object {
        $r = Test-ProxyPort ("http://127.0.0.1:{0}" -f $_.port)
        [ordered]@{ name = $_.name; port = $_.port; listening = $r.listening; owner = $r.owner }
    }
    harnessProcesses    = @(Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" -ErrorAction SilentlyContinue |
                            Select-Object ProcessId, ParentProcessId, CreationDate)
    hook                = @{ enabled = (-not $NoHook); path = $hookPath }
}

$snapshot | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $snapshotPath -Encoding UTF8

# ------------------------------------------------------------------ 注入

if (-not $NoHook) {
    $hookForNodeOptions = $hookPath.Replace('\', '/')
    $existing = [Environment]::GetEnvironmentVariable('NODE_OPTIONS', 'Process')
    $require = if ($hookForNodeOptions -match '\s') { "--require `"$hookForNodeOptions`"" } else { "--require $hookForNodeOptions" }
    $env:NODE_OPTIONS = if ([string]::IsNullOrWhiteSpace($existing)) { $require } else { "$existing $require" }
    $env:DSH_DIAG_DIR = $LogDir
}

Write-Host ''
Write-Host '=== dsh-diag 启动诊断 ===' -ForegroundColor Cyan
Write-Host ('HTTPS_PROXY 生效值 : {0}  (来源: {1})' -f $snapshot.effectiveHttpsProxy.value, $snapshot.effectiveHttpsProxy.source)
$proxyCheck = $snapshot.proxyReachability[0]
if ($proxyCheck.host) {
    $color = if ($proxyCheck.listening) { 'Green' } else { 'Red' }
    Write-Host ('代理端口连通性    : {0}:{1} -> {2} ({3} ms, owner={4})' -f $proxyCheck.host, $proxyCheck.port,
        $(if ($proxyCheck.listening) { 'LISTENING' } else { 'REFUSED' }), $proxyCheck.elapsedMs, $proxyCheck.owner) -ForegroundColor $color
    if (-not $proxyCheck.listening) {
        Write-Host '  !! 生效的代理端口没有监听：Harness 的每个 HTTPS 请求都会在 1~2ms 内失败，' -ForegroundColor Red
        Write-Host '     并被包装成 transport failed。先修代理来源，再谈其他。' -ForegroundColor Red
    }
}
foreach ($m in $snapshot.localModels) {
    Write-Host ('本地模型 {0,-9}: 127.0.0.1:{1} -> {2}' -f $m.name, $m.port, $(if ($m.listening) { "LISTENING ($($m.owner))" } else { 'REFUSED (后端未启动)' }))
}
Write-Host ("快照              : {0}" -f $snapshotPath)
Write-Host ("NODE_OPTIONS      : {0}" -f [Environment]::GetEnvironmentVariable('NODE_OPTIONS', 'Process'))
Write-Host ("日志目录          : {0}" -f $LogDir)

if ($DryRun) {
    Write-Host ''
    Write-Host 'DryRun：未启动 Harness。' -ForegroundColor Yellow
    return
}

Write-Host ''
Write-Host '正在启动 Harness ...' -ForegroundColor Cyan
$proc = Start-Process -FilePath $exe -WorkingDirectory $InstallDir -PassThru
Write-Host ('已启动 PID {0}。复现故障后运行 bin\report.cjs 生成脱敏报告。' -f $proc.Id)
Write-Host '提示：本脚本设置的环境变量只作用于它启动的进程树，注册表与用户级变量未被改动。'
