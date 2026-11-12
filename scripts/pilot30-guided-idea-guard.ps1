param([string]$Label = 'guard')

$ErrorActionPreference = 'Stop'
if ($Label -cnotmatch '^[a-z0-9-]+$') { throw 'P30_INVALID_GUARD_LABEL' }
$Source = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$BatchRoot = Split-Path -Parent $Source
if ((Split-Path -Leaf $BatchRoot) -cne 'AP-PILOT30-GUIDED-IDEA-TO-BLUEPRINT-01-20261113') {
    throw 'P30_WRONG_BATCH_ROOT'
}
Set-Location -LiteralPath $Source
if ((Get-Location).Path -cne $Source) { throw 'P30_CWD_MISMATCH' }
for ($item = Get-Item -LiteralPath $Source; $null -ne $item; $item = $item.Parent) {
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'P30_REPARSE_POINT' }
}
$env:GIT_OPTIONAL_LOCKS = '0'
$top = & git --no-pager rev-parse --show-toplevel
if ($LASTEXITCODE -ne 0 -or [IO.Path]::GetFullPath($top.Replace('/', '\')) -cne $Source) {
    throw 'P30_GIT_ROOT_MISMATCH'
}
$head = & git --no-pager rev-parse HEAD
if ($LASTEXITCODE -ne 0 -or $head -cne 'eac667c7e6438bab3649554d04395673e48018c8') {
    throw 'P30_HEAD_MISMATCH'
}
if (Test-Path -LiteralPath '.git\objects\info\alternates') { throw 'P30_ALTERNATES_PRESENT' }

$Evidence = Join-Path $BatchRoot 'evidence'
$Validation = Join-Path $Evidence 'validation'
foreach ($output in @(
    (Join-Path $Validation 'tmp'),
    (Join-Path $Validation 'npm-cache'),
    (Join-Path $Validation 'home'),
    (Join-Path $Validation 'runtime'),
    (Join-Path $Validation 'logs'),
    (Join-Path $Evidence 'runtime'),
    (Join-Path $Evidence 'runtime\test-results')
)) {
    for ($path = $output; $path -cne $BatchRoot; $path = Split-Path -Parent $path) {
        if ((Test-Path -LiteralPath $path) -and
            ((Get-Item -LiteralPath $path).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'P30_OUTPUT_REPARSE_POINT'
        }
    }
    New-Item -ItemType Directory -Force -Path $output | Out-Null
}
foreach ($name in @(Get-ChildItem Env: | Select-Object -ExpandProperty Name)) {
    if ($name -match '^(APP_PLANET|SUPABASE|NEXT_PUBLIC|DATABASE|PG|AUTH|AI_|OPENAI|ANTHROPIC|AZURE|VERCEL|SENTRY|PILOT30|E2B|NODE_OPTIONS|NODE_ENV|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NPM_CONFIG_)' -or
        $name -match '(TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY)') {
        Remove-Item -LiteralPath "Env:$name"
    }
}
$env:TEMP = Join-Path $Validation 'tmp'
$env:TMP = $env:TEMP
$env:HOME = Join-Path $Validation 'home'
$env:NPM_CONFIG_CACHE = Join-Path $Validation 'npm-cache'
$env:NPM_CONFIG_OFFLINE = 'true'
$env:NPM_CONFIG_AUDIT = 'false'
$env:NPM_CONFIG_FUND = 'false'
$env:NPM_CONFIG_UPDATE_NOTIFIER = 'false'
$env:NPM_CONFIG_USERCONFIG = Join-Path $Validation 'no-user-npmrc'
$env:NPM_CONFIG_GLOBALCONFIG = Join-Path $Validation 'no-global-npmrc'
$env:NPM_CONFIG_LOGS_DIR = Join-Path $Validation 'logs'
$env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1'
$env:NEXT_TELEMETRY_DISABLED = '1'
$env:SPECIFY_FEATURE_DIRECTORY = Join-Path $Source 'specs\001-app-planet-platform'
$env:NODE_OPTIONS = '--require="' + (Join-Path $PSScriptRoot 'pilot30-loopback-only.cjs').Replace('\', '\\') + '"'
$dirty = @(& git --no-pager status --porcelain=v1 --untracked-files=all)
if ($LASTEXITCODE -ne 0) { throw 'P30_STATUS_FAILED' }
[pscustomobject]@{
    label = $Label
    timestamp = (Get-Date).ToUniversalTime().ToString('o')
    pid = $PID
    cwd = '<SOURCE>'
    head = $head
    uncommitted = $dirty
    outputBoundary = '<BATCH_ROOT>'
} | ConvertTo-Json -Depth 4 |
    Set-Content -LiteralPath (Join-Path $Validation "guards-$Label-$PID-$([DateTime]::UtcNow.Ticks).json") -Encoding utf8
Write-Output "P30_GUARD_PASS label=$Label pid=$PID cwd=<SOURCE> head=$head"
