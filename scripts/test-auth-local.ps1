param(
    [switch]$BrowserOnly,
    [switch]$IntegrationOnly,
    [switch]$Upgrade0025,
    [switch]$Upgrade0028,
    [switch]$Upgrade0031,
    [switch]$Upgrade0032,
    [switch]$Upgrade0035,
    [switch]$Upgrade0036,
    [switch]$Upgrade0037,
    [switch]$Upgrade0038,
    [switch]$Upgrade0039,
    [switch]$Upgrade0040,
    [switch]$Upgrade0041,
    [switch]$Upgrade0042,
    [switch]$Upgrade0043,
    [switch]$Upgrade0042IllegalHistory,
    [switch]$TeacherSignup,
    [switch]$StudentLogin,
    [string[]]$IntegrationFilter = @(),
    [string[]]$E2EFilter = @(),
    [ValidateRange(1024, 64246)]
    [int]$PortRangeStart = 55000
)

$ErrorActionPreference = "Stop"
if (Test-Path variable:PSNativeCommandUseErrorActionPreference) {
    $PSNativeCommandUseErrorActionPreference = $false
}

$repoRoot = (git rev-parse --show-toplevel).Trim()
if ($StudentLogin) {
    if ($TeacherSignup -or $Upgrade0025 -or $Upgrade0028 -or $Upgrade0031 -or $Upgrade0032 -or
        $Upgrade0035 -or $Upgrade0036 -or $Upgrade0037 -or $Upgrade0038 -or $Upgrade0039 -or
        $Upgrade0040 -or $Upgrade0041 -or $Upgrade0042 -or $Upgrade0043 -or $Upgrade0042IllegalHistory) {
        throw "學生入口隔離驗收不可混用其他模式。"
    }
    if (-not $env:APP_PLANET_BATCH_EVIDENCE -or
        -not [System.IO.Path]::IsPathRooted($env:APP_PLANET_BATCH_EVIDENCE) -or
        -not (Test-Path -LiteralPath $env:APP_PLANET_BATCH_EVIDENCE -PathType Container)) {
        throw "學生入口 runner 必須指定已存在的本批專屬證據目錄。"
    }
    if ($IntegrationFilter.Count -eq 0) { $IntegrationFilter = @("tests/integration/real-auth-student-login.test.ts") }
    if ($E2EFilter.Count -eq 0) { $E2EFilter = @("tests/auth-e2e/real-auth-student-login.spec.ts") }
}

# 不可變快照 fixture 不可藉停用 trigger 清理；合跑時改由兩個獨立 Docker 專案持有資料。
# 保留原篩選與各檔內斷言；不是以測試排序或刪除其他檔資料隔離。
$upgradeMode = $Upgrade0025 -or $Upgrade0028 -or $Upgrade0031 -or $Upgrade0032 -or
    $Upgrade0035 -or $Upgrade0036 -or $Upgrade0037 -or $Upgrade0038 -or $Upgrade0039 -or
    $Upgrade0040 -or $Upgrade0041 -or $Upgrade0042 -or $Upgrade0043 -or $Upgrade0042IllegalHistory
if (-not $BrowserOnly -and -not $upgradeMode -and -not $TeacherSignup -and -not $StudentLogin -and
    -not $env:APP_PLANET_AUTH_TEST_DATABASE_GROUP) {
    Push-Location $repoRoot
    try {
        $selectedFiles = @(& node (Join-Path $repoRoot "node_modules\vitest\vitest.mjs") list `
            --config vitest.auth.config.ts --filesOnly @IntegrationFilter)
        if ($LASTEXITCODE -ne 0) { throw "無法列舉 Auth 測試檔；未建立隔離資源。" }
    } finally { Pop-Location }
    if ($selectedFiles.Count -gt 1 -and $selectedFiles -contains "tests/integration/real-auth-project-files.test.ts") {
        $groupExitCode = 0
        try {
            foreach ($group in @("project-files", "shared")) {
                $env:APP_PLANET_AUTH_TEST_DATABASE_GROUP = $group
                Write-Output "IntegrationDatabaseGroup=$group (independent Docker project)"
                & $PSCommandPath -IntegrationOnly -PortRangeStart $PortRangeStart -IntegrationFilter $IntegrationFilter
                if ($LASTEXITCODE -ne 0) { $groupExitCode = $LASTEXITCODE }
            }
        } finally {
            Remove-Item -LiteralPath Env:APP_PLANET_AUTH_TEST_DATABASE_GROUP
        }
        if ($groupExitCode -ne 0) { exit $groupExitCode }
        if ($IntegrationOnly) { exit 0 }
        # 瀏覽器驗收仍使用另一個全新隔離專案；不沿用任一整合測試的 fixture。
        & $PSCommandPath -BrowserOnly -PortRangeStart $PortRangeStart -E2EFilter $E2EFilter
        exit $LASTEXITCODE
    }
}
$runId = [Guid]::NewGuid().ToString("N")
$projectId = "app-planet-auth-$($runId.Substring(0, 12))"
$workRoot = if ($StudentLogin) {
    Join-Path $env:APP_PLANET_BATCH_EVIDENCE "runtime\AppPlanetNativeAuth-$runId"
} else { Join-Path $env:TEMP "AppPlanetNativeAuth-$runId" }
$projectRoot = Join-Path $workRoot "project"
$supabaseRoot = Join-Path $projectRoot "supabase"
if ($StudentLogin) {
    $env:TEMP = Join-Path $workRoot "process"
    $env:TMP = $env:TEMP
    $env:npm_config_cache = Join-Path $workRoot "npm-cache"
    $env:npm_config_update_notifier = "false"
    New-Item -ItemType Directory -Path $env:TEMP, $env:npm_config_cache -Force | Out-Null
    foreach ($processPath in @($env:TEMP, $env:TMP, $env:npm_config_cache)) {
        if (-not [System.IO.Path]::GetFullPath($processPath).StartsWith(
            [System.IO.Path]::GetFullPath($workRoot) + [System.IO.Path]::DirectorySeparatorChar,
            [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "本批程序／cache 路徑未隔離；未進行安裝或驗收。"
        }
    }
    Write-Output "StudentProcessPathsVerified=batch-private"
}
$apiPort = 0
$dbPort = 0
$shadowPort = 0
$webPort = 0
$mailPort = 0
$started = $false
$exitCode = 0
$nextCandidatePort = $PortRangeStart
$supabaseExecutable = (Get-Command supabase -CommandType Application | Select-Object -First 1).Source
$script:commandInvocationId = 0
Write-Output "IsolatedProject=$projectId"

function Get-FreeTcpPort {
    while ($script:nextCandidatePort -le $PortRangeStart + 1289) {
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
    if ($TeacherSignup) {
        do { $mailPort = Get-FreeTcpPort } while (@($apiPort, $dbPort, $shadowPort, $webPort) -contains $mailPort)
    }

    # readiness §92：只有 -TeacherSignup 隔離 runner 開啟 Auth signup、電郵確認與本機郵件接收器；
    # 其他 runner 維持 signup 關閉。以下 OTP 期限、寄信頻率為隔離測試值，不是正式 PP 核定。
    $authSignupEnabled = if ($TeacherSignup) { "true" } else { "false" }
    $emailConfirmations = if ($TeacherSignup) { "true" } else { "false" }
    $teacherSignupConfig = ""
    if ($TeacherSignup) {
        $templateRoot = Join-Path $supabaseRoot "templates"
        New-Item -ItemType Directory -Path $templateRoot -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $repoRoot "scripts\auth-templates\teacher-signup-confirmation.html") `
            -Destination (Join-Path $templateRoot "teacher-signup-confirmation.html")
        $teacherSignupConfig = @"
otp_expiry = 120
max_frequency = "1s"

[auth.email.template.confirmation]
subject = "App Planet 教師申請電郵驗證（隔離測試）"
content_path = "./supabase/templates/teacher-signup-confirmation.html"

[inbucket]
enabled = true
port = $mailPort
"@
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
jwt_expiry = $(if ($StudentLogin) { 600 } else { 60 })
enable_signup = $authSignupEnabled

# readiness §90 隔離測試值：放寬上游 IP 登入限速，避免干擾產品端節流驗收；非正式 PP 核定。
[auth.rate_limit]
sign_in_sign_ups = 300
$(if ($TeacherSignup) { "email_sent = 1000" })

[auth.email]
enable_signup = true
double_confirm_changes = false
enable_confirmations = $emailConfirmations
$teacherSignupConfig

[edge_runtime]
enabled = false

[analytics]
enabled = false
"@
    Set-Content -LiteralPath (Join-Path $supabaseRoot "config.toml") -Value $config -Encoding utf8

    $excluded = "studio,edge-runtime,analytics,vector,storage-api,imgproxy,realtime,mailpit,postgres-meta,postgrest,supavisor"
    if ($TeacherSignup) { $excluded = $excluded.Replace("mailpit,", "") }
    Invoke-QuietSupabase @(
        "--yes", "start", "--workdir", $projectRoot,
        "--exclude", $excluded
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
    if ($StudentLogin) {
        $authUri = [System.Uri]::new($authOrigin)
        $dbUri = [System.Uri]::new($adminDbUrl)
        if (-not ($authUri.IsLoopback -and $dbUri.IsLoopback -and $authUri.Port -eq $apiPort -and $dbUri.Port -eq $dbPort)) {
            throw "學生入口 Auth／DB 不是本輪指定的 loopback 埠。"
        }
        foreach ($container in @("supabase_auth_$projectId", "supabase_db_$projectId", "supabase_kong_$projectId")) {
            $labels = (& docker inspect --format '{{json .Config.Labels}}' $container) | ConvertFrom-Json
            if ($LASTEXITCODE -ne 0 -or $labels.'com.supabase.cli.project' -ne $projectId) { throw "學生入口容器身分不符。" }
        }
        Write-Output "StudentResourceIdentityVerified=$projectId loopback=true unique-label=true"
    }
    Write-Output "已取得隔離 Auth／PostgreSQL 連線設定。"

    $env:APP_PLANET_LOCAL_AUTH = "1"
    $env:APP_PLANET_AUTH_ORIGIN = $authOrigin
    $env:APP_PLANET_AUTH_API_KEY = $anonKey
    $env:APP_PLANET_APP_ORIGIN = "https://localhost:$webPort"
    $env:APP_PLANET_TEST_AUTH_ADMIN_KEY = $adminAuthKey
    $env:APP_PLANET_TEST_DB_ADMIN_URL = $adminDbUrl
    $env:APP_PLANET_TEST_SCOPE_ELIGIBILITY_HOLD = "1"
    $env:APP_PLANET_E2E_PORT = "$webPort"
    $env:APP_PLANET_E2E_CHANNEL = "msedge"
    $env:APP_PLANET_TEST_AUTH_CONTAINER = "supabase_auth_$projectId"
    & docker inspect --format 'AuthImage={{.Config.Image}}' "supabase_auth_$projectId"
    if ($StudentLogin) {
        $authEnv = (& docker inspect --format '{{json .Config.Env}}' "supabase_auth_$projectId") | ConvertFrom-Json
        if ($authEnv -notcontains "GOTRUE_JWT_EXP=600") { throw "隔離 Auth 實際 TTL 不是 600 秒。" }
        Write-Output "StudentAuthTTLVerified=600"
        $env:APP_PLANET_STUDENT_LOGIN_MODE = "isolated-local-test"
        $env:APP_PLANET_STUDENT_AUTH_TTL_SECONDS = "600"
        $env:APP_PLANET_STUDENT_LOGIN_ISOLATION_ID = ([Guid]::Parse($runId)).ToString()
    }
    $env:NODE_ENV = "test"
    $env:APP_PLANET_ENV = "isolated-local-test"
    $env:APP_PLANET_BOOTSTRAP_MODE = "isolated-local-test"
    $env:APP_PLANET_BOOTSTRAP_ISOLATION_ID = ([Guid]::Parse($runId)).ToString()
    $env:APP_PLANET_STAFF_REVIEW_MODE = "isolated-local-test"

    # readiness §90：既有教職員登入僅在本隔離 runner 啟用；以下為隔離測試值，不是 PP-03／PP-04 正式核定。
    $env:APP_PLANET_STAFF_LOGIN_MODE = "isolated-local-test"
    $env:APP_PLANET_STAFF_LOGIN_THROTTLE_BACKEND = "memory-single-process"
    $hmacBytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($hmacBytes) } finally { $rng.Dispose() }
    $env:APP_PLANET_STAFF_LOGIN_HMAC_SECRET = -join ($hmacBytes | ForEach-Object { $_.ToString("x2") })
    [Array]::Clear($hmacBytes, 0, $hmacBytes.Length)
    $env:APP_PLANET_STAFF_SESSION_MAX_AGE_SECONDS = "900"

    if ($TeacherSignup) {
        $mailApiUrl = if ($status.MAILPIT_URL) { [string]$status.MAILPIT_URL } else { [string]$status.INBUCKET_URL }
        $mailUri = [System.Uri]::new($mailApiUrl)
        if (-not ($mailUri.IsLoopback -and $mailUri.Port -eq $mailPort)) {
            throw "隔離郵件接收器不是本輪指定的 loopback 埠。"
        }
        $mailContainer = "supabase_inbucket_$projectId"
        if (-not (& docker ps -q --filter "name=^/$mailContainer$")) { throw "找不到本輪隔離郵件接收器容器。" }
        $env:APP_PLANET_TEACHER_SIGNUP_MODE = "isolated-local-test"
        # 郵件接收器只供測試工具讀取；APP_PLANET_TEST_* 不傳入 Next 子程序。
        $env:APP_PLANET_TEST_MAIL_API_URL = $mailApiUrl.TrimEnd("/")
        $env:APP_PLANET_TEST_MAIL_CONTAINER = $mailContainer
        $env:APP_PLANET_TEST_AUTH_OTP_EXPIRY_SECONDS = "120"
        if ($IntegrationFilter.Count -eq 0) { $IntegrationFilter = @("tests/integration/real-auth-teacher-signup.test.ts") }
        if ($E2EFilter.Count -eq 0) { $E2EFilter = @("tests/auth-e2e/real-auth-teacher-signup.spec.ts") }
        Write-Output "隔離郵件接收器已啟動（僅 loopback；不寄外部信件）。"
    }
    if ($Upgrade0025) { $env:APP_PLANET_TEST_MIGRATE_THROUGH = "0024" }
    if ($Upgrade0031) {
        if ($Upgrade0025 -or $Upgrade0028 -or $BrowserOnly) { throw "0031 升級驗收不可混用其他升級或 BrowserOnly。" }
        $env:APP_PLANET_TEST_MIGRATE_THROUGH = "0030"
        $IntegrationFilter = @("tests/integration/real-auth-specification-review.test.ts")
    }
    if ($Upgrade0028) {
        if (-not $TeacherSignup) { throw "0028 升級驗收必須使用 -TeacherSignup。" }
        $env:APP_PLANET_TEST_MIGRATE_THROUGH = "0028"
    }
    if ($Upgrade0032) {
        if ($Upgrade0025 -or $Upgrade0028 -or $Upgrade0031 -or $Upgrade0035 -or $Upgrade0036 -or $BrowserOnly -or -not $IntegrationOnly) {
            throw "0032 升級驗收須單獨使用 -Upgrade0032 -IntegrationOnly。"
        }
        $env:APP_PLANET_TEST_MIGRATE_THROUGH = "0031"
        $IntegrationFilter = @("tests/integration/real-auth-bindings-upgrade.test.ts")
    }
    if ($Upgrade0035) {
        if ($Upgrade0025 -or $Upgrade0028 -or $Upgrade0031 -or $Upgrade0032 -or $Upgrade0036 -or $BrowserOnly -or -not $IntegrationOnly) {
            throw "0035 升級驗收須單獨使用 -Upgrade0035 -IntegrationOnly。"
        }
        $env:APP_PLANET_TEST_MIGRATE_THROUGH = "0034"
        $IntegrationFilter = @("tests/integration/real-auth-teacher-view-audit.test.ts")
    }
    if ($Upgrade0036) {
        if ($Upgrade0025 -or $Upgrade0028 -or $Upgrade0031 -or $Upgrade0032 -or $Upgrade0035 -or $BrowserOnly -or -not $IntegrationOnly) {
            throw "0036 升級驗收須單獨使用 -Upgrade0036 -IntegrationOnly。"
        }
        $env:APP_PLANET_TEST_MIGRATE_THROUGH = "0035"
        $IntegrationFilter = @("tests/integration/real-auth-project-rename.test.ts")
    }
    if ($Upgrade0037) {
        if ($Upgrade0025 -or $Upgrade0028 -or $Upgrade0031 -or $Upgrade0032 -or $Upgrade0035 -or $Upgrade0036 -or $BrowserOnly -or -not $IntegrationOnly) {
            throw "0037 升級驗收須單獨使用 -Upgrade0037 -IntegrationOnly。"
        }
        $env:APP_PLANET_TEST_MIGRATE_THROUGH = "0036"
        $IntegrationFilter = @("tests/integration/real-auth-agent-runs.test.ts")
    }
    if ($Upgrade0038) {
        if ($Upgrade0025 -or $Upgrade0028 -or $Upgrade0031 -or $Upgrade0032 -or $Upgrade0035 -or $Upgrade0036 -or $Upgrade0037 -or $BrowserOnly -or -not $IntegrationOnly) {
            throw "0038 升級驗收須單獨使用 -Upgrade0038 -IntegrationOnly。"
        }
        $env:APP_PLANET_TEST_MIGRATE_THROUGH = "0037"
        $IntegrationFilter = @("tests/integration/real-auth-admin-memberships.test.ts")
    }
    if ($Upgrade0039) {
        if ($Upgrade0025 -or $Upgrade0028 -or $Upgrade0031 -or $Upgrade0032 -or $Upgrade0035 -or $Upgrade0036 -or $Upgrade0037 -or $Upgrade0038 -or $BrowserOnly -or -not $IntegrationOnly) {
            throw "0039 升級驗收須單獨使用 -Upgrade0039 -IntegrationOnly。"
        }
        $env:APP_PLANET_TEST_MIGRATE_THROUGH = "0038"
        $IntegrationFilter = @("tests/integration/real-auth-project-export.test.ts")
    }
    if ($Upgrade0040) {
        if ($Upgrade0025 -or $Upgrade0028 -or $Upgrade0031 -or $Upgrade0032 -or $Upgrade0035 -or $Upgrade0036 -or $Upgrade0037 -or $Upgrade0038 -or $Upgrade0039 -or $BrowserOnly -or -not $IntegrationOnly) {
            throw "0040 升級驗收須單獨使用 -Upgrade0040 -IntegrationOnly。"
        }
        $env:APP_PLANET_TEST_MIGRATE_THROUGH = "0039"
        $IntegrationFilter = @("tests/integration/real-auth-admin-schools.test.ts")
    }
    if ($Upgrade0041) {
        if ($Upgrade0025 -or $Upgrade0028 -or $Upgrade0031 -or $Upgrade0032 -or $Upgrade0035 -or
            $Upgrade0036 -or $Upgrade0037 -or $Upgrade0038 -or $Upgrade0039 -or $Upgrade0040 -or
            $Upgrade0042 -or $BrowserOnly -or -not $IntegrationOnly) {
            throw "0040→0041 升級驗收須單獨使用 -Upgrade0041 -IntegrationOnly。"
        }
        $env:APP_PLANET_TEST_MIGRATE_THROUGH = "0040"
        $IntegrationFilter = @("tests/integration/real-auth-project-files.test.ts")
    }
    if ($Upgrade0042) {
        if ($Upgrade0025 -or $Upgrade0028 -or $Upgrade0031 -or $Upgrade0032 -or $Upgrade0035 -or
            $Upgrade0036 -or $Upgrade0037 -or $Upgrade0038 -or $Upgrade0039 -or $Upgrade0040 -or
            $Upgrade0041 -or $BrowserOnly -or -not $IntegrationOnly) {
            throw "0041→0042 升級驗收須單獨使用 -Upgrade0042 -IntegrationOnly。"
        }
        $env:APP_PLANET_TEST_MIGRATE_THROUGH = "0041"
        $IntegrationFilter = @("tests/integration/real-auth-project-files.test.ts")
    }
    if ($Upgrade0043) {
        if ($Upgrade0025 -or $Upgrade0028 -or $Upgrade0031 -or $Upgrade0032 -or $Upgrade0035 -or
            $Upgrade0036 -or $Upgrade0037 -or $Upgrade0038 -or $Upgrade0039 -or $Upgrade0040 -or
            $Upgrade0041 -or $Upgrade0042 -or $Upgrade0042IllegalHistory -or $BrowserOnly -or -not $IntegrationOnly) {
            throw "0042→0043 升級驗收須單獨使用 -Upgrade0043 -IntegrationOnly。"
        }
        $env:APP_PLANET_TEST_MIGRATE_THROUGH = "0042"
        $IntegrationFilter = @("tests/integration/real-auth-project-files.test.ts")
    }
    if ($Upgrade0042IllegalHistory) {
        # readiness §108：0041 舊規則接受、0042 新規則拒絕的歷史路徑，須明確阻擋且不部分套用。
        if ($Upgrade0025 -or $Upgrade0028 -or $Upgrade0031 -or $Upgrade0032 -or $Upgrade0035 -or
            $Upgrade0036 -or $Upgrade0037 -or $Upgrade0038 -or $Upgrade0039 -or $Upgrade0040 -or
            $Upgrade0041 -or $Upgrade0042 -or $BrowserOnly -or -not $IntegrationOnly) {
            throw "0042 非法歷史路徑阻擋驗收須單獨使用 -Upgrade0042IllegalHistory -IntegrationOnly。"
        }
        $env:APP_PLANET_TEST_MIGRATE_THROUGH = "0041"
        $env:APP_PLANET_TEST_ILLEGAL_PATH_HISTORY = "1"
        $IntegrationFilter = @("tests/integration/real-auth-project-file-path-history.test.ts")
    }
    $roleUrlsJson = & node (Join-Path $repoRoot "scripts\prepare-real-auth-db.mjs")
    if ($LASTEXITCODE -ne 0) {
        $exitCode = $LASTEXITCODE
        throw "隔離 PostgreSQL runtime role setup 失敗。"
    }
    $roleUrls = $roleUrlsJson | ConvertFrom-Json
    $env:APP_PLANET_DATABASE_URL = $roleUrls.applicationDatabaseUrl
    if ($StudentLogin) {
        if (-not ($roleUrls.studentLoginDatabaseUrl -and $roleUrls.studentDummyAlias)) {
            throw "隔離學生入口設定不完整。"
        }
        $env:APP_PLANET_STUDENT_LOGIN_DATABASE_URL = $roleUrls.studentLoginDatabaseUrl
        $env:APP_PLANET_STUDENT_DUMMY_ALIAS = $roleUrls.studentDummyAlias
    }
    $env:APP_PLANET_TEST_WORKER_DATABASE_URL = $roleUrls.workerDatabaseUrl
    if ($roleUrls.bootstrapDatabaseUrl) { $env:APP_PLANET_BOOTSTRAP_DATABASE_URL = $roleUrls.bootstrapDatabaseUrl }
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
    foreach ($secretName in @("APP_PLANET_BOOTSTRAP_DATABASE_URL", "APP_PLANET_STAFF_LOGIN_HMAC_SECRET", "APP_PLANET_SOURCE_PROXY_PROOF", "APP_PLANET_TEST_AUTH_ADMIN_KEY", "APP_PLANET_TEST_DB_ADMIN_URL", "APP_PLANET_DATABASE_URL", "APP_PLANET_TEST_WORKER_DATABASE_URL", "APP_PLANET_AUTH_API_KEY",
        "APP_PLANET_TEACHER_SIGNUP_MODE", "APP_PLANET_TEST_MAIL_API_URL", "APP_PLANET_TEST_MAIL_CONTAINER",
        "APP_PLANET_TEST_AUTH_OTP_EXPIRY_SECONDS", "APP_PLANET_TEST_MIGRATE_THROUGH", "APP_PLANET_TEST_ILLEGAL_PATH_HISTORY",
        "APP_PLANET_STUDENT_LOGIN_MODE", "APP_PLANET_STUDENT_AUTH_TTL_SECONDS", "APP_PLANET_STUDENT_LOGIN_ISOLATION_ID",
        "APP_PLANET_STUDENT_LOGIN_DATABASE_URL", "APP_PLANET_STUDENT_DUMMY_ALIAS")) {
        Remove-Item -LiteralPath "Env:$secretName" -ErrorAction SilentlyContinue
    }
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
