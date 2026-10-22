# Shared path resolution for the dsh-diag scripts.
# Dot-source this file; it defines Resolve-DshInstall / Resolve-DshNode / Resolve-DshHome.
#
# Nothing here assumes a specific machine: the install directory is taken from
# -InstallDir, then $env:DSH_INSTALL_DIR, then a list of conventional locations.

function Resolve-DshInstall {
    param([string]$Explicit)

    $candidates = @()
    if ($Explicit) { $candidates += $Explicit }
    if ($env:DSH_INSTALL_DIR) { $candidates += $env:DSH_INSTALL_DIR }
    $candidates += @(
        (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness'),
        (Join-Path $env:ProgramFiles 'DeepSeek Harness'),
        (Join-Path ${env:ProgramFiles(x86)} 'DeepSeek Harness'),
        (Join-Path $env:ProgramData 'DeepSeek Harness')
    )

    # Uninstall registry keys carry the real location when the app was installed elsewhere.
    foreach ($root in 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall',
                      'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall',
                      'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall') {
        try {
            Get-ChildItem $root -ErrorAction SilentlyContinue | ForEach-Object {
                $props = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
                if ($props.DisplayName -match 'DeepSeek Harness' -and $props.InstallLocation) {
                    $candidates += $props.InstallLocation
                }
            }
        } catch { }
    }

    foreach ($c in $candidates) {
        if ([string]::IsNullOrWhiteSpace($c)) { continue }
        if (Test-Path -LiteralPath (Join-Path $c 'DeepSeek Harness.exe')) { return (Resolve-Path -LiteralPath $c).Path }
    }
    throw '找不到 DeepSeek Harness 安装目录。请用 -InstallDir 指定，或设置环境变量 DSH_INSTALL_DIR。'
}

function Resolve-DshNode {
    param([Parameter(Mandatory)][string]$InstallDir)

    # The desktop app ships its own runtime; prefer it so the probe sees the same
    # Node the harness actually uses.
    $bundled = Join-Path $InstallDir 'resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
    if (Test-Path -LiteralPath $bundled) { return $bundled }

    $onPath = Get-Command node -ErrorAction SilentlyContinue
    if ($onPath) { return $onPath.Source }

    throw '找不到 node 运行时：安装目录下没有自带 Node，PATH 里也没有。'
}

function Resolve-DshHome {
    if ($env:DSH_HOME) { return $env:DSH_HOME }
    return (Join-Path $env:USERPROFILE '.dsh')
}
