# Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
# licensed under the terms of the MIT license which can be found in the
# root directory of this project.

# Windows twin of scripts/package.sh: builds qs400-code-host for
# x86_64-pc-windows-msvc, copies it to bin\, and packages the win32-x64
# pre-release VSIX.
#
#   scripts\package.ps1             host + VSIX
#   scripts\package.ps1 -HostOnly   host into bin\ only (for npm test)

param([switch]$HostOnly)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$triple = 'x86_64-pc-windows-msvc'
$target = 'win32-x64'
$exe = 'qs400-code-host.exe'

function Invoke-Checked {
    param([string]$File, [string[]]$Arguments)
    & $File @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$File $($Arguments -join ' ') failed with exit code $LASTEXITCODE" }
}

Write-Host "==> building qs400-code-host for $triple"
Push-Location host
try { Invoke-Checked cargo @('build', '--release', '--locked', '--target', $triple) } finally { Pop-Location }

Write-Host "==> bin\$exe"
New-Item -ItemType Directory -Force bin | Out-Null
Get-ChildItem bin -Force | Where-Object Name -ne '.gitkeep' | Remove-Item -Recurse -Force
Copy-Item "host\target\$triple\release\$exe" "bin\$exe"
Invoke-Checked "bin\$exe" @('--version')

if ($HostOnly) { exit 0 }

Write-Host '==> checking VSIX contents'
$files = @(& npx --no-install vsce ls)
if ($LASTEXITCODE -ne 0) { throw 'vsce ls failed' }
$files | ForEach-Object { Write-Host $_ }
if ($files | Where-Object { $_ -match '^(host|test|src|node_modules)/' }) { throw 'VSIX would contain sources or tests' }
$bins = @($files | Where-Object { $_ -like 'bin/*' })
if ($bins.Count -ne 1 -or $bins[0] -ne "bin/$exe") { throw "VSIX must carry exactly bin/$exe" }

$out = "code-for-qs400-$target.vsix"
Write-Host "==> $out"
Invoke-Checked npx @('--no-install', 'vsce', 'package', '--pre-release', '--target', $target, '--out', $out)
