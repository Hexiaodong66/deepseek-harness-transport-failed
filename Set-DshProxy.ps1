#Requires -Version 5.1
<#
.SYNOPSIS
  自动识别当前真正可用的 HTTP 代理端口，写入 Harness 的 .env，然后启动 Harness。

.DESCRIPTION
  适用场景：机器上装了不止一个代理工具，端口各不相同，而且经常来回切换
  （例如工具 A 用 33210、工具 B 用 7897）。DeepSeek Harness 不读取 Windows
  系统代理，只认进程环境与 $DSH_HOME\.env，所以端口一换它就整片失败。

  判定标准不是「端口在监听」，而是真实完成一次
  CONNECT api.deepseek.com:443 → TLS → HTTP，收到 2xx/4xx 才算可用。
  这样 SOCKS 端口、残留的半死进程、被规则拦掉的端口都会自动落选。

  只修改一个文件：$DSH_HOME\.env（改动前自动备份）。不碰注册表、不写用户级/
  系统级环境变量、不碰代理工具自己的配置。

.PARAMETER InstallDir
  Harness 安装目录。省略时自动探测，或读环境变量 DSH_INSTALL_DIR。

.PARAMETER DryRun
  只检测并打印结论，不写文件、不启动。

.PARAMETER NoLaunch
  写好 .env 但不启动 Harness。

.PARAMETER Port
  手动指定端口，跳过自动探测。

.EXAMPLE
  .\Set-DshProxy.ps1 -DryRun
  .\Set-DshProxy.ps1
  .\Set-DshProxy.ps1 -Port 7897
#>
[CmdletBinding()]
param(
    [string]$InstallDir,
    [switch]$DryRun,
    [switch]$NoLaunch,
    [int]$Port
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $root 'lib\Resolve-Dsh.ps1')

$InstallDir = Resolve-DshInstall -Explicit $InstallDir
$nodeExe = Resolve-DshNode -InstallDir $InstallDir
$checker = Join-Path $root 'bin\check-proxy.cjs'
$envFile = Join-Path (Resolve-DshHome) '.env'
$exe = Join-Path $InstallDir 'DeepSeek Harness.exe'

foreach ($p in @($nodeExe, $checker)) { if (-not (Test-Path -LiteralPath $p)) { throw "缺少文件：$p" } }

# ---------------------------------------------------------------- 候选端口

$candidates = [System.Collections.Generic.List[int]]::new()
function Add-Candidate([int]$p) {
    if ($p -gt 0 -and $p -lt 65536 -and -not $candidates.Contains($p)) { [void]$candidates.Add($p) }
}

if ($Port -gt 0) {
    Add-Candidate $Port
} else {
    # 1) Windows 系统代理：代理工具启动时都会把这里改成自己的端口
    try {
        $ie = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction SilentlyContinue
        if ($ie.ProxyServer) {
            foreach ($m in [regex]::Matches([string]$ie.ProxyServer, '(?:^|[;=])(?:https?=)?(?:http://)?(?:127\.0\.0\.1|localhost)?:?(\d{2,5})')) {
                Add-Candidate ([int]$m.Groups[1].Value)
            }
        }
    } catch { }

    # 2) 名字像代理的进程正在监听的端口
    $proxyProc = 'clash|verge|mihomo|sing-box|singbox|xray|v2ray|nekoray|hysteria|tuic|shadowsocks|ss-local'
    try {
        Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
            $proc = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue
            if ($proc -and $proc.ProcessName -match $proxyProc -and $_.LocalAddress -in '127.0.0.1', '0.0.0.0', '::', '::1') {
                Add-Candidate ([int]$_.LocalPort)
            }
        }
    } catch { }

    # 3) 常见默认端口兜底
    foreach ($p in 7897, 33210, 7890, 7899, 10808, 10809, 2080, 20171, 8889) { Add-Candidate $p }
}

Write-Host ''
Write-Host '=== 探测可用代理端口 ===' -ForegroundColor Cyan
Write-Host ('候选：' + ($candidates -join ', '))

$results = & $nodeExe $checker @candidates | ConvertFrom-Json

$results | ForEach-Object {
    $mark = if ($_.ok) { 'OK  ' } else { 'FAIL' }
    $detail = if ($_.ok) { "CONNECT $($_.connectStatus) → HTTP $($_.httpStatus)" } else { "$($_.stage): $($_.error)" }
    $color = if ($_.ok) { 'Green' } else { 'DarkGray' }
    Write-Host ('  {0} {1,-6} {2,-7} {3}' -f $mark, $_.port, "$($_.elapsedMs)ms", $detail) -ForegroundColor $color
}

$winner = $results | Where-Object { $_.ok } |
    Sort-Object -Property @{ Expression = { if ($_.port -in 7897, 33210) { 0 } else { 1 } } }, elapsedMs |
    Select-Object -First 1

if (-not $winner) {
    Write-Host ''
    Write-Host '没有任何端口能完成一次真实的 HTTPS 代理请求。' -ForegroundColor Red
    Write-Host '请先确认代理工具已运行且已连接节点，然后重试。' -ForegroundColor Red
    exit 1
}

Write-Host ''
Write-Host ('选中端口：{0}（CONNECT {1} → HTTP {2}，{3} ms）' -f $winner.port, $winner.connectStatus, $winner.httpStatus, $winner.elapsedMs) -ForegroundColor Green

# ---------------------------------------------------------------- 写 .env

$wanted = "http://127.0.0.1:$($winner.port)"

$current = [ordered]@{}
if (Test-Path -LiteralPath $envFile) {
    foreach ($line in Get-Content -LiteralPath $envFile) {
        $t = $line.Trim()
        if ($t -eq '' -or $t.StartsWith('#')) { continue }
        $i = $t.IndexOf('=')
        if ($i -gt 0) { $current[$t.Substring(0, $i).Trim()] = $t.Substring($i + 1).Trim() }
    }
}

if (-not $current.Contains('NO_PROXY')) { $current['NO_PROXY'] = 'localhost,127.0.0.1,::1' }
$changed = ($current['HTTP_PROXY'] -ne $wanted) -or ($current['HTTPS_PROXY'] -ne $wanted)
$current['HTTP_PROXY'] = $wanted
$current['HTTPS_PROXY'] = $wanted

if (-not $changed -and (Test-Path -LiteralPath $envFile)) {
    Write-Host '.env 已是正确端口，无需改动。' -ForegroundColor DarkGray
} elseif ($DryRun) {
    Write-Host ".env 需要改动（DryRun 未写入）：HTTP_PROXY/HTTPS_PROXY → $wanted" -ForegroundColor Yellow
} else {
    if (Test-Path -LiteralPath $envFile) {
        $bak = "$envFile.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
        Copy-Item -LiteralPath $envFile -Destination $bak
        Write-Host "已备份：$bak" -ForegroundColor DarkGray
    } else {
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $envFile) | Out-Null
    }
    $lines = foreach ($k in $current.Keys) { "$k=$($current[$k])" }
    Set-Content -LiteralPath $envFile -Value $lines -Encoding UTF8
    Write-Host "已写入 $envFile：HTTP_PROXY/HTTPS_PROXY → $wanted" -ForegroundColor Green
}

if ($DryRun -or $NoLaunch) {
    Write-Host ''
    Write-Host '未启动 Harness。' -ForegroundColor Yellow
    return
}

$running = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue
if ($running) {
    Write-Host ''
    Write-Host '检测到 Harness 正在运行。.env 只在启动时读取，请先完全退出，再运行本脚本。' -ForegroundColor Yellow
    return
}

Write-Host ''
Write-Host '正在启动 Harness ...' -ForegroundColor Cyan
Start-Process -FilePath $exe -WorkingDirectory $InstallDir | Out-Null
Write-Host '已启动。若仍失败，运行 .\Start-DshDiag.ps1 取得分层证据。' -ForegroundColor Cyan
