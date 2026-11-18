# Build "Boop" for Windows: the NSH window (windows/), the bot (src/, app/,
# package.json, production node_modules) and a Node runtime, all beside Boop.exe.
# Output: windows\.nsh\out\Boop\ and windows\.nsh\out\Boop-windows.zip. See docs/windows.md.
#
#   powershell -ExecutionPolicy Bypass -File scripts/windows-build.ps1
#
# Must run on Windows: nsh package --target windows builds the runner for the machine
# it is built on (nsh.dev/docs/packaging). Needs: nsh 0.5
# (https://nsh.dev/docs/installation), Node 24 + npm, and the TailPocket helper for
# Windows in vendor/tailpocket/bin (the workflow builds it with Go; without it the app
# pairs over the local network only). DEEPSEEK_BOT_WINDOWS_BUILD puts the ~1 GB of
# build output elsewhere (default: windows\.nsh, ignored by git).
param(
    [string]$Build = $env:DEEPSEEK_BOT_WINDOWS_BUILD,
    [string]$NodeVersion = '24.13.1'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$Root = Split-Path -Parent $PSScriptRoot
if (-not $Build) { $Build = Join-Path $Root 'windows\.nsh' }
$Out = Join-Path $Build 'out'
$Stage = Join-Path $Build 'stage'
$Cache = Join-Path $Build 'cache'
$App = Join-Path $Out 'Boop'
$Bot = Join-Path $App 'bot'
$Zip = Join-Path $Out 'Boop-windows.zip'
$NodeZip = "node-v$NodeVersion-win-x64.zip"
$NodeArchive = "node-v$NodeVersion-win-x64"
$t0 = Get-Date

function Say([string]$Text) { Write-Host "`n== $Text" }
function Fail([string]$Text) { throw $Text }

# robocopy copies trees quickly and returns 0-7 for success (1: files copied).
function Copy-Tree([string]$From, [string]$To) {
    robocopy $From $To /E /NFL /NDL /NJH /NJS /NP /MT:8 | Out-Null
    if ($LASTEXITCODE -ge 8) { Fail "robocopy failed ($LASTEXITCODE): $From -> $To" }
    $global:LASTEXITCODE = 0
}

$Nsh = if ($env:NSH_BIN) { $env:NSH_BIN } else { (Get-Command nsh.exe -ErrorAction SilentlyContinue).Source }
if (-not $Nsh -or -not (Test-Path $Nsh)) { Fail 'nsh not found; install NSH 0.5: https://nsh.dev/docs/installation' }
$Version = (& $Nsh --version | Out-String).Trim()
if ($Version -notmatch '^nsh 0\.5\.') { Fail "Boop needs NSH 0.5 and $Nsh is $Version. Install it: https://nsh.dev/docs/installation" }

Say '1/6 the window (nsh package --target windows)'
foreach ($p in @($App, (Join-Path $Out 'Boop.zip'), $Zip)) {
    if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Recurse -Force }
}
New-Item -ItemType Directory -Force -Path $Out | Out-Null
Push-Location (Join-Path $Root 'windows')
try { & $Nsh package --target windows --out $Out } finally { Pop-Location }
if ($LASTEXITCODE -ne 0) { Fail "nsh package failed ($LASTEXITCODE)" }
if (-not (Test-Path (Join-Path $App 'Boop.exe'))) { Fail "nsh package did not produce $App\Boop.exe" }

Say "2/6 the bot's dependencies (npm ci --omit=dev, pruned as in the Dockerfile)"
New-Item -ItemType Directory -Force -Path $Stage | Out-Null
$LockHash = (Get-FileHash (Join-Path $Root 'package-lock.json') -Algorithm SHA256).Hash
$Stamp = Join-Path $Stage 'package-lock.sha256'
$Reuse = (Test-Path (Join-Path $Stage 'node_modules')) -and (Test-Path $Stamp) -and ((Get-Content $Stamp -Raw).Trim() -eq $LockHash)
if ($Reuse) {
    Write-Host 'reusing node_modules (package-lock.json unchanged)'
} else {
    if (Test-Path (Join-Path $Stage 'node_modules')) { Remove-Item (Join-Path $Stage 'node_modules') -Recurse -Force }
    Copy-Item (Join-Path $Root 'package.json') (Join-Path $Root 'package-lock.json') $Stage -Force
    Push-Location $Stage
    try { npm ci --omit=dev --no-audit --no-fund } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { Fail "npm ci failed ($LASTEXITCODE)" }
    # Same list as the Dockerfile and scripts/mac-build.sh: DSH's optional speech/office
    # packages and SDKs the web profile never loads.
    $Nm = Join-Path $Stage 'node_modules'
    foreach ($p in @('@deepseek-ai\libreoffice-kit-wasm', '@img\sharp-wasm32', '@aws-sdk', '@smithy', '@octokit', '@google', '@anthropic-ai', 'openai', '@opentelemetry', '@img')) {
        $path = Join-Path $Nm $p
        if (Test-Path $path) { Remove-Item $path -Recurse -Force }
    }
    Get-ChildItem (Join-Path $Nm '@deepseek-ai') -Filter 'libreoffice-kit-*' -Directory -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force
    Get-ChildItem $Nm -Filter 'sherpa-onnx-*' -Directory -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force
    Set-Content $Stamp $LockHash
}

Say "3/6 Node $NodeVersion (win-x64) from nodejs.org, checksum verified"
New-Item -ItemType Directory -Force -Path $Cache | Out-Null
$NodeExe = Join-Path $Cache 'node.exe'
$NodeLicense = Join-Path $Cache 'LICENSE-node'
$NodeStamp = Join-Path $Cache 'node-version.txt'
if (-not ((Test-Path $NodeExe) -and (Test-Path $NodeLicense) -and (Test-Path $NodeStamp) -and ((Get-Content $NodeStamp -Raw).Trim() -eq $NodeVersion))) {
    $Archive = Join-Path $Cache $NodeZip
    if (-not (Test-Path $Archive)) {
        & curl.exe -fsSL --retry 3 -o $Archive "https://nodejs.org/dist/v$NodeVersion/$NodeZip"
        if ($LASTEXITCODE -ne 0) { Fail "downloading $NodeZip failed ($LASTEXITCODE)" }
    }
    $Sums = Join-Path $Cache 'SHASUMS256.txt'
    & curl.exe -fsSL --retry 3 -o $Sums "https://nodejs.org/dist/v$NodeVersion/SHASUMS256.txt"
    if ($LASTEXITCODE -ne 0) { Fail "downloading SHASUMS256.txt failed ($LASTEXITCODE)" }
    $Want = (Select-String -LiteralPath $Sums -Pattern " $NodeZip$").Line.Split(' ')[0]
    if (-not $Want) { Fail "$NodeZip is not in SHASUMS256.txt" }
    $Got = (Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash
    if ($Got -ne $Want.ToUpperInvariant()) { Fail "checksum mismatch for ${NodeZip}: got $Got, want $Want" }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $z = [IO.Compression.ZipFile]::OpenRead($Archive)
    try {
        $NodeEntry = $z.GetEntry("$NodeArchive/node.exe")
        $LicenseEntry = $z.GetEntry("$NodeArchive/LICENSE")
        if (-not $NodeEntry -or -not $LicenseEntry) { Fail "$NodeZip does not contain node.exe and LICENSE where expected" }
        [IO.Compression.ZipFileExtensions]::ExtractToFile($NodeEntry, $NodeExe, $true)
        [IO.Compression.ZipFileExtensions]::ExtractToFile($LicenseEntry, $NodeLicense, $true)
    } finally { $z.Dispose() }
    Set-Content $NodeStamp $NodeVersion
}

Say '4/6 the bot beside Boop.exe'
New-Item -ItemType Directory -Force -Path $Bot | Out-Null
Copy-Tree (Join-Path $Root 'src') (Join-Path $Bot 'src')
Copy-Tree (Join-Path $Root 'app') (Join-Path $Bot 'app')
Copy-Tree (Join-Path $Root 'vendor') (Join-Path $Bot 'vendor')
Copy-Tree (Join-Path $Stage 'node_modules') (Join-Path $Bot 'node_modules')
Copy-Item (Join-Path $Root 'package.json') (Join-Path $Bot 'package.json') -Force
Copy-Item $NodeExe (Join-Path $Bot 'node.exe') -Force
Copy-Item $NodeLicense (Join-Path $Bot 'LICENSE-node') -Force
Copy-Item (Join-Path $Root 'mac\bot\qr.mjs') (Join-Path $Bot 'qr.mjs') -Force
if (-not (Get-ChildItem (Join-Path $Bot 'vendor\tailpocket\bin') -Filter 'tailpocket-host-windows-*' -ErrorAction SilentlyContinue)) {
    Write-Warning 'no TailPocket helper for Windows in vendor\tailpocket\bin: the app pairs over the local network only (HTTP, same Wi-Fi)'
}

Say '5/6 checks'
foreach ($p in @((Join-Path $App 'Boop.exe'), (Join-Path $App 'nsh\bundle.nshc'), (Join-Path $Bot 'node.exe'), (Join-Path $Bot 'src\main.ts'), (Join-Path $Bot 'node_modules\qrcode-terminal\package.json'))) {
    if (-not (Test-Path $p)) { Fail "missing from the build: $p" }
}

Say '6/6 the zip'
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory($App, $Zip, [IO.Compression.CompressionLevel]::Optimal, $true)
if (-not (Test-Path $Zip)) { Fail "the zip was not written: $Zip" }

$Elapsed = [int](((Get-Date) - $t0).TotalSeconds)
Say "done in $Elapsed s"
foreach ($p in @($App, (Join-Path $Bot 'node.exe'), (Join-Path $Bot 'node_modules'), $Zip)) {
    $item = Get-Item -LiteralPath $p
    if ($item.PSIsContainer) {
        $bytes = (Get-ChildItem -LiteralPath $p -Recurse -File | Measure-Object -Property Length -Sum).Sum
    } else { $bytes = $item.Length }
    '{0}  {1:N1} MB' -f $p, ($bytes / 1MB)
}
Write-Host $Zip
