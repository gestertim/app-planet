param(
    [switch]$BrowserOnly,
    [switch]$IntegrationOnly,
    [switch]$Upgrade0025,
    [string[]]$IntegrationFilter = @(),
    [string[]]$E2EFilter = @()
)

$ErrorActionPreference = "Stop"
if (Test-Path variable:PSNativeCommandUseErrorActionPreference) {
    $PSNativeCommandUseErrorActionPreference = $false
}

$repoRoot = (git rev-parse --show-toplevel).Trim()
$runId = [Guid]::NewGuid().ToString("N")
$projectId = "app-planet-auth-$($runId.Substring(0, 12))"
$workRoot = Join-Path $env:TEMP "AppPlanetNativeAuth-$runId"
$projectRoot = Join-Path $workRoot "project"
$supabaseRoot = Join-Path $projectRoot "supabase"
$apiPort = 0
$dbPort = 0
$shadowPort = 0
$webPort = 0
$started = $false
$exitCode = 0
$nextCandidatePort = 55000
$supabaseExecutable = (Get-Command supabase -CommandType Application | Select-Object -First 1).Source
$script:commandInvocationId = 0
Write-Output "IsolatedProject=$projectId"

function Get-FreeTcpPort {
    while ($script:nextCandidatePort -le 56289) {
        $candidate = $script:nextCandidatePort++
        $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Any, $candidate)
        try {
            $listener.Start()
            return $candidate
        } catch [System.Net.Sockets.SocketException] {
            continue
        } finally {
            $listener.Stop()
        }
    }
    throw "無法取得非 Windows 保留範圍的隔離本機連接埠。"
}

function Invoke-QuietSupabase(
    [string[]]$Arguments,
    [string]$Failure,
    [switch]$CaptureOutput
) {
    $script:commandInvocationId++
    $argumentLine = ($Arguments | ForEach-Object { '"' + $_.Replace('"', '\"') + '"' }) -join " "
    $startInfo = [System.Diagnostics.ProcessStartInfo]::new($supabaseExecutable, $argumentLine)
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    if (-not $process.Start()) { throw "$Failure (process did not start)." }
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    $stdout = $stdoutTask.GetAwaiter().GetResult()
    $stderr = $stderrTask.GetAwaiter().GetResult()
    if ($process.ExitCode -ne 0) {
        [Console]::Error.WriteLine("$Failure (exit $($process.ExitCode))")
        foreach ($line in ("$stdout`n$stderr" -split "\r?\n")) {
            $safeLine = [string]$line
            $safeLine = $safeLine -replace '(?i)("(?:apikey|authorization|service_role_key|anon_key|secret_key|publishable_key|jwt_secret|password|access_token|refresh_token|db_url)"\s*:\s*")[^"]+', '$1[REDACTED]'
            $safeLine = $safeLine -replace '(?i)(apikey|authorization|service_role_key|anon_key|secret_key|publishable_key|jwt_secret|password|access_token|refresh_token|db_url)\s*[=:]\s*[^,\s"]+', '$1=[REDACTED]'
            $safeLine = $safeLine -replace 'eyJ[A-Za-z0-9._-]{20,}', '[JWT REDACTED]'
            $safeLine = $safeLine -replace '(?i)(postgres(ql)?://)[^@\s]+@', '$1[REDACTED]@'
            if ($safeLine.Trim()) { [Console]::Error.WriteLine($safeLine) }
        }
        $script:failedCommandExitCode = $process.ExitCode
        throw $Failure
    }
    $process.Dispose()
    if ($CaptureOutput) { return $stdout }
}

function Remove-OwnedDockerResources {
    $containerIds = @(& docker ps -aq --filter "name=$projectId" 2>$null)
    if ($containerIds.Count -gt 0) { $null = & docker rm -f $containerIds 2>&1 }
    $volumeNames = @(& docker volume ls -q --filter "name=$projectId" 2>$null)
    if ($volumeNames.Count -gt 0) { $null = & docker volume rm $volumeNames 2>&1 }
    $networkIds = @(& docker network ls -q --filter "name=$projectId" 2>$null)
    if ($networkIds.Count -gt 0) { $null = & docker network rm $networkIds 2>&1 }
    $remainingContainers = @(& docker ps -aq --filter "name=$projectId" 2>$null)
    $remainingVolumes = @(& docker volume ls -q --filter "name=$projectId" 2>$null)
    $remainingNetworks = @(& docker network ls -q --filter "name=$projectId" 2>$null)
    if ($remainingContainers.Count -or $remainingVolumes.Count -or $remainingNetworks.Count) {
        throw "隔離 Supabase 容器／volume／network 清理後仍有殘留。"
    }
    Write-Output "CleanupVerified=$projectId containers=0 volumes=0 networks=0"
}

try {
    foreach ($port in 1..16) {
        $candidate = Get-FreeTcpPort
        if (@($apiPort, $dbPort, $shadowPort, $webPort) -notcontains $candidate) {
            if ($apiPort -eq 0) { $apiPort = $candidate }
            elseif ($dbPort -eq 0) { $dbPort = $candidate }
            elseif ($shadowPort -eq 0) { $shadowPort = $candidate }
            elseif ($webPort -eq 0) { $webPort = $candidate }
        }
        if ($apiPort -and $dbPort -and $shadowPort -and $webPort) { break }
    }
    if (-not ($apiPort -and $dbPort -and $shadowPort -and $webPort)) {
        throw "無法取得隔離本機測試連接埠。"
    }

    New-Item -ItemType Directory -Path (Join-Path $supabaseRoot "migrations") -Force | Out-Null
    Get-ChildItem -LiteralPath (Join-Path $repoRoot "supabase\migrations") -Filter "*.sql" |
        Copy-Item -Destination (Join-Path $supabaseRoot "migrations")
    $dbPassword = [Guid]::NewGuid().ToString("N")
    $config = @"
project_id = "$projectId"

[api]
enabled = true
port = $apiPort
schemas = ["public", "graphql_public"]
extra_search_path = ["public", "extensions"]
max_rows = 1000

[db]
port = $dbPort
shadow_port = $shadowPort
health_timeout = "2m"
major_version = 17
password = "$dbPassword"

[db.migrations]
enabled = false
schema_paths = []

[db.seed]
enabled = false
sql_paths = []

[realtime]
enabled = false

[studio]
enabled = false

[storage]
enabled = false

[auth]
enabled = true
site_url = "https://localhost:$webPort"
additional_redirect_urls = ["https://localhost:$webPort/**"]
jwt_expiry = 60
enable_signup = false

[auth.email]
enable_signup = true
double_confirm_changes = false
enable_confirmations = false

[edge_runtime]
enabled = false

[analytics]
enabled = false
"@
    Set-Content -LiteralPath (Join-Path $supabaseRoot "config.toml") -Value $config -Encoding utf8

    Invoke-QuietSupabase @(
        "--yes", "start", "--workdir", $projectRoot,
        "--exclude", "studio,edge-runtime,analytics,vector,storage-api,imgproxy,realtime,mailpit,postgres-meta,postgrest,supavisor"
    ) "隔離 Supabase 原生 Auth 啟動失敗。"
    $started = $true
    Write-Output "隔離 Supabase Auth／PostgreSQL 已啟動。"

    $statusOutput = Invoke-QuietSupabase @("status", "--workdir", $projectRoot, "--output", "json") `
        "無法讀取隔離 Supabase local status。" -CaptureOutput
    $status = $statusOutput | ConvertFrom-Json
    $authOrigin = $status.API_URL
    $adminDbUri = [System.UriBuilder]::new([string]$status.DB_URL)
    $adminDbUri.UserName = "supabase_admin"
    $adminDbUrl = $adminDbUri.Uri.AbsoluteUri
    $anonKey = $status.ANON_KEY
    $adminAuthKey = $status.SERVICE_ROLE_KEY
    if (-not ($authOrigin -and $adminDbUrl -and $anonKey -and $adminAuthKey)) {
        throw "隔離 Supabase status 缺少必要 Auth／PostgreSQL 設定。"
    }
    Write-Output "已取得隔離 Auth／PostgreSQL 連線設定。"

    $env:APP_PLANET_LOCAL_AUTH = "1"
    $env:APP_PLANET_AUTH_ORIGIN = $authOrigin
    $env:APP_PLANET_AUTH_API_KEY = $anonKey
    $env:APP_PLANET_APP_ORIGIN = "https://localhost:$webPort"
    $env:APP_PLANET_TEST_AUTH_ADMIN_KEY = $adminAuthKey
    $env:APP_PLANET_TEST_DB_ADMIN_URL = $adminDbUrl
    $env:APP_PLANET_E2E_PORT = "$webPort"
    $env:APP_PLANET_E2E_CHANNEL = "msedge"
    $env:APP_PLANET_TEST_AUTH_CONTAINER = "supabase_auth_$projectId"
    $env:NODE_ENV = "test"

    if ($Upgrade0025) { $env:APP_PLANET_TEST_MIGRATE_THROUGH = "0024" }
    $roleUrlsJson = & node (Join-Path $repoRoot "scripts\prepare-real-auth-db.mjs")
    if ($LASTEXITCODE -ne 0) {
        $exitCode = $LASTEXITCODE
        throw "隔離 PostgreSQL runtime role setup 失敗。"
    }
    $roleUrls = $roleUrlsJson | ConvertFrom-Json
    $env:APP_PLANET_DATABASE_URL = $roleUrls.applicationDatabaseUrl
    $env:APP_PLANET_TEST_WORKER_DATABASE_URL = $roleUrls.workerDatabaseUrl
    Write-Output "隔離 migration 與 runtime database roles 已準備。"

    Push-Location $repoRoot
    try {
        if ($Upgrade0025) {
            & npm run test:auth:upgrade
            if ($LASTEXITCODE -ne 0) {
                $exitCode = $LASTEXITCODE
                throw "0024→0025 既有資料升級驗收失敗。"
            }
        } elseif (-not $BrowserOnly) {
            & npm run test:auth:integration -- @IntegrationFilter
            if ($LASTEXITCODE -ne 0) {
                $exitCode = $LASTEXITCODE
                throw "真實 Auth／產品 Route Handler 整合驗證失敗。"
            }
        }
        if (-not $IntegrationOnly -and -not $Upgrade0025) {
            & npm run test:e2e:auth -- @E2EFilter
            if ($LASTEXITCODE -ne 0) {
                $exitCode = $LASTEXITCODE
                throw "真實頁面瀏覽器驗證失敗。"
            }
        }
    } finally {
        Pop-Location
    }
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    if ($exitCode -eq 0) {
        $exitCode = if ($script:failedCommandExitCode) { $script:failedCommandExitCode } else { 1 }
    }
} finally {
    if ($started) {
        try {
            Invoke-QuietSupabase @("stop", "--workdir", $projectRoot, "--no-backup") `
                "隔離 Supabase stop 未成功。"
        } catch {
            [Console]::Error.WriteLine($_.Exception.Message)
            if ($exitCode -eq 0) { $exitCode = 1 }
        }
    }
    try { Remove-OwnedDockerResources }
    catch {
        [Console]::Error.WriteLine($_.Exception.Message)
        if ($exitCode -eq 0) { $exitCode = 1 }
    }
    if (Test-Path -LiteralPath $workRoot) {
        Remove-Item -LiteralPath $workRoot -Recurse -Force
    }
}

if ($exitCode -ne 0) { exit $exitCode }
Write-Output "隔離本機 Supabase Auth／PostgreSQL 已測試並清理。"
