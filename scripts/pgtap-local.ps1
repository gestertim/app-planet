param(
  [ValidateSet('Normal', 'Authorization', 'Projects', 'Usage', 'NotOk', 'SqlError', 'ParserSelfTest', 'EvidenceSelfTest', 'EvidenceWriteFailure')]
  [string]$Scenario = 'Normal',
  [switch]$UsageUpgrade
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:RepoRoot = Split-Path -Parent $PSScriptRoot
$script:ComposeFile = Join-Path $script:RepoRoot 'supabase\pgtap.local.compose.yml'
$script:MigrationFiles = @(
  (Join-Path $script:RepoRoot 'supabase\migrations\0001_identity_audit.sql'),
  (Join-Path $script:RepoRoot 'supabase\migrations\0002_account_gate.sql'),
  (Join-Path $script:RepoRoot 'supabase\migrations\0003_usage_jobs.sql'),
  (Join-Path $script:RepoRoot 'supabase\migrations\0009_projects_stages.sql'),
  (Join-Path $script:RepoRoot 'supabase\migrations\0010_projects_unclassified_create.sql'),
  (Join-Path $script:RepoRoot 'supabase\migrations\0011_project_requirements_classification.sql'),
  (Join-Path $script:RepoRoot 'supabase\migrations\0012_stage_drafts.sql'),
  (Join-Path $script:RepoRoot 'supabase\migrations\0020_job_status_snapshot.sql'),
  (Join-Path $script:RepoRoot 'supabase\migrations\0021_usage_account_row_lock_privileges.sql'),
  (Join-Path $script:RepoRoot 'supabase\migrations\0022_project_create_replay_only.sql'),
  (Join-Path $script:RepoRoot 'supabase\migrations\0023_project_task_done.sql'),
  (Join-Path $script:RepoRoot 'supabase\migrations\0024_project_task_manual_import.sql'),
  (Join-Path $script:RepoRoot 'supabase\migrations\0025_stage_draft_confirmation.sql')
)
if ($UsageUpgrade) {
  if ($Scenario -ne 'Usage') { throw 'UsageUpgrade 只適用 Usage scenario。' }
  $usageMigration = Join-Path $script:RepoRoot 'supabase\migrations\0003_usage_jobs.sql'
  $jobStatusMigration = Join-Path $script:RepoRoot 'supabase\migrations\0020_job_status_snapshot.sql'
  $usageLockMigration = Join-Path $script:RepoRoot 'supabase\migrations\0021_usage_account_row_lock_privileges.sql'
  # 0020 依賴 0003 的 jobs 表；0021 的鎖定權限也排在 usage schema 建立之後。
  $script:MigrationFiles = @($script:MigrationFiles | Where-Object {
      $_ -ne $usageMigration -and $_ -ne $jobStatusMigration -and $_ -ne $usageLockMigration
    }) + @($usageMigration, $jobStatusMigration, $usageLockMigration)
}
$script:ProjectLegacyMigrationFile =
  Join-Path $script:RepoRoot 'supabase\migrations\0010_projects_unclassified_create.sql'
$script:TestFiles = @(
  (Join-Path $script:RepoRoot 'supabase\tests\identity_audit.test.sql'),
  (Join-Path $script:RepoRoot 'supabase\tests\account_gate.test.sql')
)
$script:ProjectMigrationSetupFile = Join-Path $script:RepoRoot 'supabase\tests\project-migration-compatibility-setup.sql'
$script:ProjectMigrationTestFile = Join-Path $script:RepoRoot 'supabase\tests\project-migration-compatibility.test.sql'
if ($Scenario -in @('Projects', 'Usage')) {
  $script:TestFiles += $script:ProjectMigrationTestFile
}
$script:GrantFile = Join-Path $script:RepoRoot 'supabase\tests\harness\temporary-grants.sql'
$script:RevokeFile = Join-Path $script:RepoRoot 'supabase\tests\harness\temporary-revokes.sql'
$script:SnapshotFile = Join-Path $script:RepoRoot 'supabase\tests\harness\catalog-snapshot.sql'
$script:Image = 'public.ecr.aws/supabase/postgres:17.6.1.167'
$script:Timestamp = (Get-Date).ToString('o')
$script:RunId = [guid]::NewGuid().ToString('N')
$script:ProjectName = "appplanet-pgtap-$($script:RunId)"
$script:EvidencePath = Join-Path $env:LOCALAPPDATA "Temp\AppPlanet-pgtap-$(Get-Date -Format 'yyyyMMdd-HHmmss')-$($script:RunId.Substring(0, 10))"
$script:Commands = [System.Collections.Generic.List[object]]::new()
$script:TestResults = [System.Collections.Generic.List[object]]::new()
$script:CleanupErrors = [System.Collections.Generic.List[string]]::new()
$script:EvidenceErrors = [System.Collections.Generic.List[string]]::new()
$script:InCleanup = $false
$script:Resources = [ordered]@{
  project = $script:ProjectName
  container_ids = @()
  volume_names = @()
  network_ids = @()
  removed_container_ids = @()
  removed_volume_names = @()
  removed_network_ids = @()
}
$script:RunError = $null
$script:CleanupStatus = 'not_started'
$script:RevocationStatus = 'not_attempted'
$script:FailureInjectionPath = $null
$script:Secrets = @()
$script:EnvironmentInfo = [ordered]@{}
$script:EnvironmentInfo.usage_upgrade = [bool]$UsageUpgrade
$script:EnvironmentInfo.migration_application_order = @($script:MigrationFiles | ForEach-Object { Split-Path -Leaf $_ })
$script:ComposeAttempted = $false
$script:SourcePaths = @(
  $PSCommandPath,
  (Join-Path $script:RepoRoot 'package.json'),
  $script:ComposeFile,
  $script:GrantFile,
  $script:RevokeFile,
  $script:SnapshotFile
) + $script:MigrationFiles + $script:TestFiles + @(
  $script:ProjectMigrationSetupFile,
  $script:ProjectMigrationTestFile
)
if ($Scenario -in @('Authorization', 'Projects', 'Usage')) {
  $script:SourcePaths += @(
    'package-lock.json',
    'apps\web\src\server\authorization.ts',
    'vitest.authorization.config.ts',
    'tests\integration\authorization-context.ts',
    'tests\integration\authorization.test.ts'
  ) | ForEach-Object { Join-Path $script:RepoRoot $_ }
}
if ($Scenario -in @('Projects', 'Usage')) {
  $script:SourcePaths += @(
    'packages\core\contracts\project-classification.ts',
    'packages\core\contracts\stage-drafts.ts',
    'packages\core\index.ts',
    'apps\web\src\server\projects.ts',
    'apps\web\src\server\project-classification.ts',
    'apps\web\src\server\stage-drafts.ts',
    'vitest.projects.config.ts',
    'tests\contract\project-stages.test.ts',
    'tests\contract\project-create.test.ts',
    'tests\contract\project-classification.test.ts',
    'tests\integration\projects.test.ts',
    'tests\integration\project-create.test.ts',
    'tests\integration\project-classification.test.ts',
    'tests\contract\stage-drafts.test.ts',
    'tests\integration\stage-drafts.test.ts',
    'tests\integration\stage-draft-save-controller.test.ts',
    'apps\web\src\server\project-workspace.ts',
    'tests\contract\project-workspace.test.ts',
    'tests\integration\project-workspace.test.ts',
    'apps\web\src\server\creation-flow-assessment.ts',
    'packages\core\policy\creation-flow.ts',
    'packages\core\policy\work-eligibility.ts',
    'tests\contract\creation-flow.test.ts',
    'tests\contract\work-eligibility.test.ts',
    'tests\integration\creation-flow-assessment.test.ts',
    'vitest.projects.config.ts'
  ) | ForEach-Object { Join-Path $script:RepoRoot $_ }
}
if ($Scenario -eq 'Usage') {
  $script:SourcePaths += @(
    'packages\core\usage\ledger.ts',
    'apps\worker\src\jobs\runner.ts',
    'apps\worker\src\jobs\checkpoint.ts',
    'tests\integration\usage-worker.test.ts',
    'vitest.usage.config.ts',
    'apps\web\src\server\http.ts',
    'apps\web\src\server\idempotency.ts',
    'apps\web\src\server\jobs.ts',
    'tests\integration\http-harness.ts',
    'tests\integration\http-foundation.test.ts',
    'vitest.foundation.config.ts',
    'apps\web\package.json',
    'apps\web\src\components\app-shell.tsx',
    'apps\web\src\components\operation-state.tsx',
    'apps\web\src\components\operation-presentation.ts',
    'apps\web\src\components\stage-draft-save-simulation.tsx',
    'apps\web\src\components\project\save-controller.ts',
    'apps\web\src\components\project\http-save-adapter.ts',
    'apps\web\src\components\project\stage-draft-editor.tsx',
    'apps\web\src\server\foundation-handlers.ts',
    'tests\e2e\foundation-save-host.tsx',
    'tests\e2e\shell.spec.ts',
    'tests\unit\http-save-adapter.test.ts',
    'tests\unit\operation-presentation.test.ts',
    'scripts\test-foundations.mjs'
  ) | ForEach-Object { Join-Path $script:RepoRoot $_ }
}

function ConvertTo-WindowsArgument {
  param([Parameter(Mandatory)][string]$Value)

  if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') {
    return $Value
  }

  $builder = [System.Text.StringBuilder]::new()
  [void]$builder.Append('"')
  $backslashes = 0
  foreach ($character in $Value.ToCharArray()) {
    if ($character -eq '\') {
      $backslashes++
      continue
    }

    if ($character -eq '"') {
      [void]$builder.Append(('\' * (($backslashes * 2) + 1)))
      [void]$builder.Append('"')
      $backslashes = 0
      continue
    }

    if ($backslashes -gt 0) {
      [void]$builder.Append(('\' * $backslashes))
      $backslashes = 0
    }
    [void]$builder.Append($character)
  }

  if ($backslashes -gt 0) {
    [void]$builder.Append(('\' * ($backslashes * 2)))
  }
  [void]$builder.Append('"')
  return $builder.ToString()
}

function Protect-Output {
  param([AllowEmptyString()][string]$Text)

  $safe = $Text
  foreach ($secret in $script:Secrets) {
    if ($secret) {
      $safe = $safe.Replace($secret, '[REDACTED]')
    }
  }
  return $safe
}

function Write-Utf8File {
  param(
    [Parameter(Mandatory)][string]$Path,
    [AllowEmptyString()][string]$Text
  )

  [System.IO.File]::WriteAllText($Path, $Text, [System.Text.UTF8Encoding]::new($false))
}

function Get-Sha256 {
  param([Parameter(Mandatory)][string]$Path)

  $algorithm = [System.Security.Cryptography.SHA256]::Create()
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
  }
  finally {
    $stream.Dispose()
    $algorithm.Dispose()
  }
}

function Invoke-Captured {
  param(
    [Parameter(Mandatory)][string]$Name,
    [Parameter(Mandatory)][string]$FilePath,
    [string[]]$Arguments = @(),
    [AllowEmptyString()][string]$InputText = ''
  )

  $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $FilePath
  $startInfo.Arguments = (($Arguments | ForEach-Object { ConvertTo-WindowsArgument -Value $_ }) -join ' ')
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardInput = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.StandardOutputEncoding = [System.Text.UTF8Encoding]::new($false)
  $startInfo.StandardErrorEncoding = [System.Text.UTF8Encoding]::new($false)

  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  if (-not $process.Start()) {
    throw "無法啟動命令：$Name"
  }

  $stdoutTask = $process.StandardOutput.ReadToEndAsync()
  $stderrTask = $process.StandardError.ReadToEndAsync()
  if ($InputText.Length -gt 0) {
    $process.StandardInput.Write($InputText)
  }
  $process.StandardInput.Close()
  $timedOut = -not $process.WaitForExit(180000)
  if ($timedOut) {
    $killer = [System.Diagnostics.Process]::Start('taskkill.exe', "/PID $($process.Id) /T /F")
    if (-not $killer.WaitForExit(10000)) { $killer.Kill() }
    $killer.Dispose()
    if (-not $process.WaitForExit(10000)) { $process.Kill() }
  }

  $stdout = Protect-Output -Text $stdoutTask.GetAwaiter().GetResult()
  $stderr = Protect-Output -Text $stderrTask.GetAwaiter().GetResult()
  $exitCode = if ($timedOut) { 124 } else { $process.ExitCode }
  $process.Dispose()
  $commandId = '{0:D4}' -f ($script:Commands.Count + 1)
  $safeName = $Name -replace '[^A-Za-z0-9._-]', '-'
  $stdoutFile = "commands/$commandId-$safeName.stdout.txt"
  $stderrFile = "commands/$commandId-$safeName.stderr.txt"
  $record = [ordered]@{
    command_id = $commandId
    name = $Name
    executable = $FilePath
    exit_code = $exitCode
    timed_out = $timedOut
    stdout_file = $stdoutFile
    stderr_file = $stderrFile
    evidence_status = 'pending'
    stdout_status = 'pending'
    stderr_status = 'pending'
    evidence_error = $null
  }
  $script:Commands.Add($record)

  $writeErrors = [System.Collections.Generic.List[string]]::new()
  foreach ($stream in @(
    @{ File = $stdoutFile; Text = $stdout; Status = 'stdout_status' },
    @{ File = $stderrFile; Text = $stderr; Status = 'stderr_status' }
  )) {
    try {
      Write-Utf8File -Path (Join-Path $script:EvidencePath $stream.File.Replace('/', '\')) -Text $stream.Text
      $record[$stream.Status] = 'saved'
    }
    catch {
      $record[$stream.Status] = 'failed'
      $writeErrors.Add((Protect-Output -Text $_.Exception.Message))
    }
  }
  if ($writeErrors.Count -gt 0) {
    $record.evidence_status = 'failed'
    $record.evidence_error = $writeErrors -join '; '
    $message = "命令 $commandId ($Name) 證據寫入失敗：$($record.evidence_error)"
    $script:EvidenceErrors.Add($message)
    [Console]::Error.WriteLine($message)
    if (-not $script:InCleanup) {
      throw $message
    }
  }
  else {
    $record.evidence_status = 'saved'
  }

  return [pscustomobject]@{
    CommandId = $commandId
    Name = $Name
    ExitCode = $exitCode
    Stdout = $stdout
    Stderr = $stderr
    StdoutFile = $stdoutFile
    StderrFile = $stderrFile
  }
}

function Invoke-Docker {
  param(
    [Parameter(Mandatory)][string]$Name,
    [Parameter(Mandatory)][string[]]$Arguments,
    [AllowEmptyString()][string]$InputText = ''
  )

  return Invoke-Captured -Name $Name -FilePath 'docker' -Arguments $Arguments -InputText $InputText
}

function Assert-CommandSuccess {
  param([Parameter(Mandatory)]$Result)
  if ($Result.ExitCode -ne 0) {
    $detail = $Result.Stderr.Trim()
    if (-not $detail) {
      $detail = $Result.Stdout.Trim()
    }
    throw "命令 $($Result.Name) 失敗（exit $($Result.ExitCode)）：$detail"
  }
}

function Get-SourceHashes {
  $hashes = [ordered]@{}
  foreach ($path in $script:SourcePaths) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
      throw "缺少必要來源檔：$path"
    }
    $relativePath = $path.Substring($script:RepoRoot.Length + 1).Replace('\', '/')
    $hashes[$relativePath] = Get-Sha256 -Path $path
  }
  return $hashes
}

function New-SecretHex {
  param([ValidateRange(32, 128)][int]$ByteCount = 64)

  $bytes = [byte[]]::new($ByteCount)
  $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $generator.GetBytes($bytes)
    return (($bytes | ForEach-Object { $_.ToString('x2') }) -join '')
  }
  finally {
    [Array]::Clear($bytes, 0, $bytes.Length)
    $generator.Dispose()
  }
}

function Get-FreeLoopbackPort {
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  try {
    $listener.Start()
    return ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
  }
  finally {
    $listener.Stop()
  }
}

function Assert-ProjectResourcesAbsent {
  $checks = @(
    @{ Name = 'preflight-existing-containers'; Args = @('ps', '-aq', '--no-trunc', '--filter', "label=com.docker.compose.project=$($script:ProjectName)") },
    @{ Name = 'preflight-existing-volumes'; Args = @('volume', 'ls', '-q', '--filter', "label=com.docker.compose.project=$($script:ProjectName)") },
    @{ Name = 'preflight-existing-networks'; Args = @('network', 'ls', '-q', '--filter', "label=com.docker.compose.project=$($script:ProjectName)") }
  )
  foreach ($check in $checks) {
    $result = Invoke-Docker -Name $check.Name -Arguments $check.Args
    Assert-CommandSuccess -Result $result
    if ($result.Stdout.Trim()) {
      throw "唯一 Compose project 資源意外已存在；不接管或刪除：$($check.Name)"
    }
  }
}

function Invoke-DbSql {
  param(
    [Parameter(Mandatory)][string]$Name,
    [Parameter(Mandatory)][string]$Role,
    [Parameter(Mandatory)][string]$Sql,
    [string[]]$PsqlOptions = @()
  )

  if (@($script:Resources.container_ids).Count -ne 1) {
    throw "無法執行 $Name：尚未確認唯一資料庫容器。"
  }
  $arguments = @(
    'exec', '-i', @($script:Resources.container_ids)[0],
    'psql', '-U', $Role, '-d', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1'
  ) + $PsqlOptions
  $result = Invoke-Docker -Name $Name -Arguments $arguments -InputText $Sql
  return $result
}

function Invoke-DbFile {
  param(
    [Parameter(Mandatory)][string]$Name,
    [Parameter(Mandatory)][string]$Role,
    [Parameter(Mandatory)][string]$Path,
    [string[]]$PsqlOptions = @()
  )

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "缺少 SQL harness：$Path"
  }
  return Invoke-DbSql -Name $Name -Role $Role -Sql ([System.IO.File]::ReadAllText($Path)) -PsqlOptions $PsqlOptions
}

function Save-Snapshot {
  param([Parameter(Mandatory)][string]$Name)

  $result = Invoke-DbFile -Name "snapshot-$Name" -Role 'supabase_admin' -Path $script:SnapshotFile -PsqlOptions @('-q', '-A', '-t', '-F', "`t")
  Assert-CommandSuccess -Result $result
  $path = Join-Path $script:EvidencePath "permissions\$Name.tsv"
  Write-Utf8File -Path $path -Text ($result.Stdout.TrimEnd() + "`n")
  return $result.Stdout -split "`r?`n" | Where-Object { $_ -ne '' }
}

function Save-ProjectMigrationEvidence {
  param([Parameter(Mandatory)][string]$Name)

  $rowsSql = @'
SELECT COALESCE(jsonb_agg(jsonb_build_array(
  project.id::text,
  project.owner_id::text,
  project.title,
  project.tier,
  project.needs_visitor_identity,
  project.stage,
  to_char(project.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  project.row_version
) ORDER BY project.id), '[]'::jsonb)::text
FROM app.projects AS project
WHERE project.id BETWEEN
  '79000000-0000-4000-8000-000000000001'::uuid AND
  '79000000-0000-4000-8000-000000000006'::uuid;
'@
  $rows = Invoke-DbSql -Name "projects-migration-$Name-data" -Role 'postgres' -Sql $rowsSql -PsqlOptions @('-q', '-A', '-t')
  Assert-CommandSuccess -Result $rows
  if ([string]::IsNullOrWhiteSpace($rows.Stdout)) {
    throw "遷移相容 $Name 資料快照為空。"
  }

  $catalogSql = @'
SELECT jsonb_build_object(
  'project_columns', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'name', column_name,
      'type', data_type,
      'nullable', is_nullable,
      'default', column_default
    ) ORDER BY ordinal_position)
    FROM information_schema.columns
    WHERE table_schema='app' AND table_name='projects'
  ), '[]'::jsonb),
  'projects_rls', (
    SELECT jsonb_build_object('enabled', relrowsecurity, 'forced', relforcerowsecurity)
    FROM pg_class WHERE oid='app.projects'::regclass
  ),
  'idempotency_owner', (
    SELECT owner.rolname
    FROM pg_class AS relation
    JOIN pg_roles AS owner ON owner.oid=relation.relowner
    WHERE relation.oid=to_regclass('app.project_create_idempotency')
  ),
  'idempotency_table', to_regclass('app.project_create_idempotency') IS NOT NULL,
  'authenticated_dml', jsonb_build_object(
    'insert', has_table_privilege('authenticated', 'app.projects', 'INSERT'),
    'update', has_table_privilege('authenticated', 'app.projects', 'UPDATE'),
    'delete', has_table_privilege('authenticated', 'app.projects', 'DELETE')
  ),
  'project_writer', (
    SELECT jsonb_build_object(
      'login', rolcanlogin,
      'superuser', rolsuper,
      'bypassrls', rolbypassrls
    )
    FROM pg_roles WHERE rolname='app_project_writer'
  ),
  'supabase_admin_project_writer_memberships', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'grantor', grantor.rolname,
      'admin', membership.admin_option,
      'inherit', membership.inherit_option,
      'set', membership.set_option
    ))
    FROM pg_auth_members AS membership
    JOIN pg_roles AS writer ON writer.oid = membership.roleid
    JOIN pg_roles AS member ON member.oid = membership.member
    JOIN pg_roles AS grantor ON grantor.oid = membership.grantor
    WHERE writer.rolname='app_project_writer' AND member.rolname='supabase_admin'
  ), '[]'::jsonb)
)::text;
'@
  $catalog = Invoke-DbSql -Name "projects-migration-$Name-catalog" -Role 'postgres' -Sql $catalogSql -PsqlOptions @('-q', '-A', '-t')
  Assert-CommandSuccess -Result $catalog
  if ([string]::IsNullOrWhiteSpace($catalog.Stdout)) {
    throw "遷移相容 $Name schema／權限快照為空。"
  }

  $directory = Join-Path $script:EvidencePath 'migration'
  if (-not (Test-Path -LiteralPath $directory)) {
    New-Item -ItemType Directory -Path $directory | Out-Null
  }
  Write-Utf8File -Path (Join-Path $directory "$Name-data.json") -Text ($rows.Stdout.Trim() + "`n")
  Write-Utf8File -Path (Join-Path $directory "$Name-catalog.json") -Text ($catalog.Stdout.Trim() + "`n")
  return [ordered]@{
    data = $rows.Stdout.Trim()
    catalog = $catalog.Stdout.Trim()
  }
}

function Get-AppPrivilegeRows {
  param([string[]]$Snapshot)
  return @($Snapshot | Where-Object { $_ -like "app_table_privilege`t*" })
}

function Compare-PrivilegeSnapshots {
  param(
    [Parameter(Mandatory)][string[]]$Before,
    [Parameter(Mandatory)][string[]]$After,
    [Parameter(Mandatory)][string]$Description
  )

  $beforeRows = Get-AppPrivilegeRows -Snapshot $Before | Sort-Object
  $afterRows = Get-AppPrivilegeRows -Snapshot $After | Sort-Object
  $difference = @(Compare-Object -ReferenceObject $beforeRows -DifferenceObject $afterRows)
  if ($difference.Count -gt 0) {
    throw "$Description：app 資料表有效權限快照不一致。"
  }
}

function Compare-CatalogSnapshots {
  param(
    [Parameter(Mandatory)][string[]]$Before,
    [Parameter(Mandatory)][string[]]$After
  )

  $difference = @(Compare-Object -ReferenceObject @($Before | Sort-Object) -DifferenceObject @($After | Sort-Object))
  if ($difference.Count -gt 0) {
    throw '撤銷後角色／schema／pgTAP 函式／app 資料表權限快照與授權前不一致。'
  }
}

function Assert-TemporaryGrantsActive {
  param([string[]]$Snapshot)

  $membership = @($Snapshot | Where-Object { $_ -like "role_membership`tpostgres`tapp_audit_writer`t*" })
  if ($membership.Count -ne 1 -or -not $membership[0].EndsWith('|true')) {
    throw '測試 harness 未能暫時啟用控制角色 postgres 的 app_audit_writer SET option。'
  }
  foreach ($role in @('authenticated', 'app_audit_writer')) {
    if ($Snapshot -notcontains "schema_privilege`t$role`tUSAGE`ttrue") {
      throw "測試角色 $role 未取得 extensions schema 的必要 USAGE。"
    }
  }
}

function Assert-TemporaryGrantsRevoked {
  param(
    [string[]]$Snapshot,
    [string[]]$BeforeSnapshot
  )

  $beforeMembership = @($BeforeSnapshot | Where-Object { $_ -like "role_membership`tpostgres`tapp_audit_writer`t*" })
  $afterMembership = @($Snapshot | Where-Object { $_ -like "role_membership`tpostgres`tapp_audit_writer`t*" })
  if ($beforeMembership.Count -ne 1 -or $afterMembership.Count -ne 1 -or $beforeMembership[0] -ne $afterMembership[0]) {
    throw '撤銷驗證失敗：postgres 的 app_audit_writer membership option 未恢復原狀。'
  }
}

function Read-TapResult {
  param(
    [Parameter(Mandatory)][AllowEmptyString()][string]$Output,
    [AllowEmptyString()][string]$Stderr,
    [Parameter(Mandatory)][int]$PsqlExitCode
  )

  if ($PsqlExitCode -ne 0) {
    throw "psql 非零退出（exit $PsqlExitCode）；拒絕判定 TAP 通過。"
  }
  if ($Stderr -match '(?im)^\s*(?:ERROR|FATAL):') {
    throw 'psql stderr 含 SQL ERROR／FATAL；拒絕判定 TAP 通過。'
  }
  if ([string]::IsNullOrWhiteSpace($Output)) {
    throw 'TAP 輸出空白；拒絕判定通過。'
  }

  $assertions = [System.Collections.Generic.List[int]]::new()
  $tapLines = [System.Collections.Generic.List[string]]::new()
  $planCount = 0
  $planned = $null
  $lineNumber = 0
  foreach ($line in ($Output -split "`r?`n")) {
    $lineNumber++
    $trimmed = $line.Trim()
    if (-not $trimmed) {
      continue
    }
    if ($trimmed -match '^(?:ERROR|FATAL):') {
      throw "stdout 含 SQL ERROR／FATAL（第 $lineNumber 行）。"
    }
    if ($trimmed -match '^(?:Bail out!|Bail out\b)') {
      throw "TAP 發出 Bail out（第 $lineNumber 行）。"
    }
    if ($trimmed -match '^1\.\.0(?:\s|$)') {
      throw 'TAP skip-all／零項 plan 不可視為通過。'
    }
    if ($trimmed -match '^1\.\.(\d+)$') {
      $planCount++
      if ($planCount -gt 1) {
        throw 'TAP 出現重複 plan。'
      }
      $planned = [int]$Matches[1]
      $tapLines.Add($trimmed)
      continue
    }
    if ($trimmed -match '^(?:ok|not ok)\s+(\d+)\s+-\s+(.+)$') {
      $testNumber = [int]$Matches[1]
      $isFailure = $trimmed -match '^not ok\b'
      if ($trimmed -match '(?i)\s#\s*(?:TODO|SKIP)\b') {
        throw "TAP 含未預期 TODO／SKIP（第 $lineNumber 行）。"
      }
      if ($isFailure) {
        $tapLines.Add($trimmed)
        throw "TAP not ok：$trimmed"
      }
      $assertions.Add($testNumber)
      $tapLines.Add($trimmed)
      continue
    }

    if ($trimmed -match '^[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$') {
      continue
    }
    if ($trimmed -match '^\{"sub":"[0-9a-fA-F-]{36}","role":"authenticated"\}$') {
      continue
    }

    throw "非空 TAP 輸出含未識別內容（第 $lineNumber 行）；拒絕判讀。"
  }

  if ($planCount -ne 1 -or $null -eq $planned) {
    throw 'TAP 缺少唯一 plan。'
  }
  if ($planned -lt 1) {
    throw 'TAP plan 無有效測試項目。'
  }
  if ($assertions.Count -ne $planned) {
    throw "TAP plan mismatch：plan=$planned、實際斷言=$($assertions.Count)。"
  }
  for ($index = 0; $index -lt $planned; $index++) {
    if ($assertions[$index] -ne ($index + 1)) {
      throw "TAP 測試編號不連續、缺漏或重複：期待 $($index + 1)，實際 $($assertions[$index])。"
    }
  }

  return [pscustomobject]@{
    planned = $planned
    passed = $assertions.Count
    failed = 0
    tap = ($tapLines -join "`n") + "`n"
  }
}

function Test-TapParser {
  $cases = @(
    @{ Name = 'empty'; Text = ''; Expected = 'TAP 輸出空白' },
    @{ Name = 'missing-plan'; Text = "ok 1 - one`n"; Expected = '缺少唯一 plan' },
    @{ Name = 'plan-mismatch'; Text = "ok 1 - one`n1..2`n"; Expected = 'plan mismatch' },
    @{ Name = 'bail-out'; Text = "Bail out! injected`n"; Expected = 'Bail out' },
    @{ Name = 'duplicate-number'; Text = "ok 1 - one`nok 1 - duplicate`n1..2`n"; Expected = 'plan mismatch|編號' },
    @{ Name = 'duplicate-plan'; Text = "ok 1 - one`n1..1`n1..1`n"; Expected = '重複 plan' },
    @{ Name = 'out-of-order'; Text = "ok 2 - two`nok 1 - one`n1..2`n"; Expected = '編號不連續' },
    @{ Name = 'not-ok'; Text = "not ok 1 - injected failure`n1..1`n"; Expected = 'TAP not ok' },
    @{ Name = 'skip-all'; Text = "1..0 # SKIP injected`n"; Expected = 'skip-all' },
    @{ Name = 'unexpected-todo'; Text = "ok 1 - todo # TODO pending`n1..1`n"; Expected = 'TODO' },
    @{ Name = 'sql-error-stderr'; Text = "ok 1 - one`n1..1`n"; Stderr = "ERROR: division by zero`n"; Expected = 'SQL ERROR／FATAL' },
    @{ Name = 'nonzero-psql'; Text = "ok 1 - one`n1..1`n"; PsqlExitCode = 3; Expected = '非零退出' }
  )
  foreach ($case in $cases) {
    $rejected = $false
    try {
      $caseStderr = if ($case.ContainsKey('Stderr')) { $case.Stderr } else { '' }
      $caseExitCode = if ($case.ContainsKey('PsqlExitCode')) { $case.PsqlExitCode } else { 0 }
      [void](Read-TapResult -Output $case.Text -Stderr $caseStderr -PsqlExitCode $caseExitCode)
    }
    catch {
      $rejected = $_.Exception.Message -match $case.Expected
      if (-not $rejected) {
        throw "TAP parser self-test $($case.Name) 遇到非預期錯誤：$($_.Exception.Message)"
      }
    }
    if (-not $rejected) {
      throw "TAP parser self-test $($case.Name) 未拒絕無效輸出。"
    }
  }

  $valid = Read-TapResult -Output "ok 1 - one`nok 2 - two`n1..2`n" -Stderr '' -PsqlExitCode 0
  if ($valid.planned -ne 2 -or $valid.passed -ne 2) {
    throw 'TAP parser self-test 有效輸出計數錯誤。'
  }
  return [pscustomobject]@{
    invalid_cases_rejected = $cases.Count
    valid_plan_count = $valid.planned
    valid_passed_count = $valid.passed
  }
}

function Get-LabeledIds {
  param(
    [Parameter(Mandatory)][string]$Name,
    [Parameter(Mandatory)][string[]]$Arguments
  )

  $result = Invoke-Docker -Name $Name -Arguments $Arguments
  Assert-CommandSuccess -Result $result
  return @($result.Stdout -split "`r?`n" | Where-Object { $_.Trim() })
}

function Capture-ProjectResources {
  $script:Resources.container_ids = Get-LabeledIds -Name 'resource-list-containers' -Arguments @(
    'ps', '-aq', '--no-trunc', '--filter', "label=com.docker.compose.project=$($script:ProjectName)"
  )
  $script:Resources.volume_names = Get-LabeledIds -Name 'resource-list-volumes' -Arguments @(
    'volume', 'ls', '-q', '--filter', "label=com.docker.compose.project=$($script:ProjectName)"
  )
  $script:Resources.network_ids = Get-LabeledIds -Name 'resource-list-networks' -Arguments @(
    'network', 'ls', '-q', '--filter', "label=com.docker.compose.project=$($script:ProjectName)"
  )
}

function Remove-OwnedResources {
  $script:CleanupStatus = 'in_progress'
  try {
    $currentContainers = Get-LabeledIds -Name 'resource-list-containers' -Arguments @(
      'ps', '-aq', '--no-trunc', '--filter', "label=com.docker.compose.project=$($script:ProjectName)"
    )
    $currentVolumes = Get-LabeledIds -Name 'resource-list-volumes' -Arguments @(
      'volume', 'ls', '-q', '--filter', "label=com.docker.compose.project=$($script:ProjectName)"
    )
    $currentNetworks = Get-LabeledIds -Name 'resource-list-networks' -Arguments @(
      'network', 'ls', '-q', '--filter', "label=com.docker.compose.project=$($script:ProjectName)"
    )
    if (@($script:Resources.container_ids).Count -eq 0) { $script:Resources.container_ids = @($currentContainers) }
    if (@($script:Resources.volume_names).Count -eq 0) { $script:Resources.volume_names = @($currentVolumes) }
    if (@($script:Resources.network_ids).Count -eq 0) { $script:Resources.network_ids = @($currentNetworks) }
  }
  catch {
    $script:CleanupErrors.Add("資源盤點失敗：$($_.Exception.Message)")
    $script:CleanupStatus = 'unverified'
    return
  }

  foreach ($containerId in @($script:Resources.container_ids)) {
    try {
      $service = Invoke-Docker -Name 'verify-container-label' -Arguments @(
        'inspect', '--format', '{{ index .Config.Labels "com.docker.compose.service" }}', $containerId
      )
      Assert-CommandSuccess -Result $service
      $project = Invoke-Docker -Name 'verify-container-project-label' -Arguments @(
        'inspect', '--format', '{{ index .Config.Labels "com.docker.compose.project" }}', $containerId
      )
      Assert-CommandSuccess -Result $project
      if ($service.Stdout.Trim() -ne 'db' -or $project.Stdout.Trim() -ne $script:ProjectName) {
        throw "container $containerId 的 Compose labels 不符合本次 runner；拒絕移除。"
      }
      $remove = Invoke-Docker -Name 'remove-owned-container' -Arguments @('rm', '-f', $containerId)
      Assert-CommandSuccess -Result $remove
      $script:Resources.removed_container_ids += $containerId
    }
    catch {
      $script:CleanupErrors.Add("移除 container $containerId 失敗：$($_.Exception.Message)")
    }
  }

  foreach ($volumeName in @($script:Resources.volume_names)) {
    try {
      $labels = Invoke-Docker -Name 'verify-volume-labels' -Arguments @(
        'volume', 'inspect', '--format', '{{ index .Labels "com.docker.compose.project" }}|{{ index .Labels "com.docker.compose.volume" }}', $volumeName
      )
      Assert-CommandSuccess -Result $labels
      if ($labels.Stdout.Trim() -ne "$($script:ProjectName)|db-data") {
        throw "volume $volumeName 的 Compose labels 不符合本次 runner；拒絕移除。"
      }
      $remove = Invoke-Docker -Name 'remove-owned-volume' -Arguments @('volume', 'rm', $volumeName)
      Assert-CommandSuccess -Result $remove
      $script:Resources.removed_volume_names += $volumeName
    }
    catch {
      $script:CleanupErrors.Add("移除 volume $volumeName 失敗：$($_.Exception.Message)")
    }
  }

  foreach ($networkId in @($script:Resources.network_ids)) {
    try {
      $labels = Invoke-Docker -Name 'verify-network-labels' -Arguments @(
        'network', 'inspect', '--format', '{{ index .Labels "com.docker.compose.project" }}|{{ index .Labels "com.docker.compose.network" }}', $networkId
      )
      Assert-CommandSuccess -Result $labels
      if ($labels.Stdout.Trim() -ne "$($script:ProjectName)|default") {
        throw "network $networkId 的 Compose labels 不符合本次 runner；拒絕移除。"
      }
      $remove = Invoke-Docker -Name 'remove-owned-network' -Arguments @('network', 'rm', $networkId)
      Assert-CommandSuccess -Result $remove
      $script:Resources.removed_network_ids += $networkId
    }
    catch {
      $script:CleanupErrors.Add("移除 network $networkId 失敗：$($_.Exception.Message)")
    }
  }

  try {
    $remainingContainers = Get-LabeledIds -Name 'verify-no-remaining-containers' -Arguments @(
      'ps', '-aq', '--no-trunc', '--filter', "label=com.docker.compose.project=$($script:ProjectName)"
    )
    $remainingVolumes = Get-LabeledIds -Name 'verify-no-remaining-volumes' -Arguments @(
      'volume', 'ls', '-q', '--filter', "label=com.docker.compose.project=$($script:ProjectName)"
    )
    $remainingNetworks = Get-LabeledIds -Name 'verify-no-remaining-networks' -Arguments @(
      'network', 'ls', '-q', '--filter', "label=com.docker.compose.project=$($script:ProjectName)"
    )
    if (@($remainingContainers).Count -or @($remainingVolumes).Count -or @($remainingNetworks).Count) {
      $script:CleanupErrors.Add('清理後仍有本次 Compose project 資源。')
    }
  }
  catch {
    $script:CleanupErrors.Add("清理後資源查核失敗：$($_.Exception.Message)")
  }

  $script:CleanupStatus = if ($script:CleanupErrors.Count -eq 0) { 'complete' } else { 'failed' }
}
function Assert-RepositoryContext {
  $root = Invoke-Captured -Name 'git-repository-root' -FilePath 'git' -Arguments @('rev-parse', '--show-toplevel')
  Assert-CommandSuccess -Result $root
  $normalizedRoot = [System.IO.Path]::GetFullPath($root.Stdout.Trim()).TrimEnd('\')
  $normalizedScriptRoot = [System.IO.Path]::GetFullPath($script:RepoRoot).TrimEnd('\')
  if (-not [string]::Equals($normalizedRoot, $normalizedScriptRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Git 根目錄與 runner 所在專案不符：$normalizedRoot"
  }

  $featureFile = Join-Path $script:RepoRoot '.specify\feature.json'
  if (-not (Test-Path -LiteralPath $featureFile -PathType Leaf)) {
    throw '缺少 .specify\feature.json；拒絕執行。'
  }
  $feature = Get-Content -LiteralPath $featureFile -Raw | ConvertFrom-Json
  if ($feature.feature_directory -ne 'specs/001-app-planet-platform') {
    throw '目前 feature_directory 不符本次授權的功能目錄；拒絕執行。'
  }
}

function Invoke-DatabaseScenario {
  Assert-RepositoryContext

  $dockerVersion = Invoke-Docker -Name 'docker-client-version' -Arguments @('--version')
  Assert-CommandSuccess -Result $dockerVersion
  $composeVersion = Invoke-Docker -Name 'docker-compose-version' -Arguments @('compose', 'version', '--short')
  Assert-CommandSuccess -Result $composeVersion
  $daemonVersion = Invoke-Docker -Name 'docker-daemon-version' -Arguments @('info', '--format', '{{.ServerVersion}}')
  Assert-CommandSuccess -Result $daemonVersion
  $script:EnvironmentInfo.docker_client = $dockerVersion.Stdout.Trim()
  $script:EnvironmentInfo.docker_compose = $composeVersion.Stdout.Trim()
  $script:EnvironmentInfo.docker_daemon = $daemonVersion.Stdout.Trim()
  $script:EnvironmentInfo.image_reference = $script:Image

  $imageInspect = Invoke-Docker -Name 'image-inspect-before' -Arguments @(
    'image', 'inspect', '--format', '{{.Id}}|{{json .RepoDigests}}', $script:Image
  )
  if ($imageInspect.ExitCode -ne 0) {
    $imageInspect = $null
  }

  Assert-ProjectResourcesAbsent
  $port = Get-FreeLoopbackPort
  $password = New-SecretHex -ByteCount 32
  $jwtSecret = New-SecretHex -ByteCount 64
  $script:Secrets = @($password, $jwtSecret)
  $env:APP_PLANET_PGTAP_POSTGRES_PASSWORD = $password
  $env:APP_PLANET_PGTAP_JWT_SECRET = $jwtSecret
  $env:APP_PLANET_PGTAP_PORT = [string]$port

  $script:ComposeAttempted = $true
  $composeUp = Invoke-Docker -Name 'compose-up' -Arguments @(
    'compose', '--project-name', $script:ProjectName, '--file', $script:ComposeFile,
    'up', '--detach', '--wait', '--wait-timeout', '180'
  )
  Assert-CommandSuccess -Result $composeUp
  Capture-ProjectResources

  if (@($script:Resources.container_ids).Count -ne 1) {
    throw 'Compose 啟動後未找到唯一資料庫容器。'
  }
  $containerId = @($script:Resources.container_ids)[0]
  $imageInspectAfter = Invoke-Docker -Name 'image-inspect-after' -Arguments @(
    'image', 'inspect', '--format', '{{.Id}}|{{json .RepoDigests}}', $script:Image
  )
  Assert-CommandSuccess -Result $imageInspectAfter
  $imageDetails = $imageInspectAfter.Stdout.Trim() -split '\|', 2
  $script:EnvironmentInfo.image_id = $imageDetails[0]
  $script:EnvironmentInfo.image_digests = if ($imageDetails.Count -gt 1) {
    @((ConvertFrom-Json -InputObject $imageDetails[1]))
  } else {
    @()
  }

  $containerInspect = Invoke-Docker -Name 'verify-container-port-inspect' -Arguments @(
    'inspect', '--format', '{{json .NetworkSettings.Ports}}', $containerId
  )
  Assert-CommandSuccess -Result $containerInspect
  $portMap = $containerInspect.Stdout.Trim() | ConvertFrom-Json
  $bound = @($portMap.'5432/tcp')
  if ($bound.Count -ne 1 -or $bound[0].HostIp -ne '127.0.0.1' -or [int]$bound[0].HostPort -ne $port) {
    throw 'Docker inspect 的實際 port binding 不是唯一 127.0.0.1 綁定。'
  }
  $script:EnvironmentInfo.host_port_binding = "$($bound[0].HostIp):$($bound[0].HostPort)"

  $preflightSql = @'
SELECT current_database(),
       (to_regnamespace('app') IS NULL)::text,
       (to_regclass('auth.users') IS NOT NULL)::text,
       (SELECT count(*) = 0 FROM auth.users)::text,
       (to_regprocedure('auth.uid()') IS NOT NULL)::text,
       current_setting('server_version'),
       ((SELECT count(*) FROM pg_roles WHERE rolname = ANY (ARRAY[
         'anon', 'authenticated', 'postgres', 'service_role', 'supabase_admin'
       ])) = 5)::text,
       (to_regnamespace('pgtap_runner') IS NULL)::text,
       (to_regrole('app_audit_writer') IS NULL)::text,
       (SELECT default_version FROM pg_available_extensions WHERE name = 'pgtap');
'@
  $preflight = Invoke-DbSql -Name 'database-preflight' -Role 'postgres' -Sql $preflightSql -PsqlOptions @('-q', '-A', '-t', '-F', "`t")
  Assert-CommandSuccess -Result $preflight
  $preflightFields = $preflight.Stdout.Trim() -split "`t"
  if ($preflightFields.Count -ne 10 -or $preflightFields[0] -ne 'postgres' -or
      $preflightFields[1] -ne 'true' -or $preflightFields[2] -ne 'true' -or
      $preflightFields[3] -ne 'true' -or $preflightFields[4] -ne 'true' -or
      $preflightFields[6] -ne 'true' -or $preflightFields[7] -ne 'true' -or
      $preflightFields[8] -ne 'true' -or $preflightFields[9] -ne '1.3.3') {
    throw '新資料庫前置條件不符：拒絕 migration（app schema、auth.users、映像原生 roles／auth.uid() 或 pgTAP 版本）。'
  }
  $script:EnvironmentInfo.postgresql_server_version = $preflightFields[5]
  $script:EnvironmentInfo.pgtap_available_version = $preflightFields[9]

  $projectMigrationBefore = $null
  $draftMigrationBefore = $null
  foreach ($migration in $script:MigrationFiles) {
    if ($Scenario -in @('Projects', 'Usage') -and
        [System.IO.Path]::GetFileName($migration) -eq '0012_stage_drafts.sql') {
      $draftMigrationBefore = Invoke-DbSql -Name 'stage-draft-migration-before-projects' -Role 'postgres' -Sql @'
SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY id),'[]'::jsonb)::text FROM app.projects p;
'@ -PsqlOptions @('-q', '-A', '-t')
      Assert-CommandSuccess -Result $draftMigrationBefore
    }
    if ($Scenario -in @('Projects', 'Usage') -and $migration -eq $script:ProjectLegacyMigrationFile) {
      $setup = Invoke-DbFile -Name 'projects-migration-compatibility-setup-at-0009' -Role 'postgres' `
        -Path $script:ProjectMigrationSetupFile -PsqlOptions @('-q')
      Assert-CommandSuccess -Result $setup
      $projectMigrationBefore = Save-ProjectMigrationEvidence -Name 'before-0010'
      $beforeRows = ConvertFrom-Json -InputObject $projectMigrationBefore.data
      if ($beforeRows.Count -ne 6) {
        throw "0009 遷移前合成歷史列數不符：預期 6，實際 $($beforeRows.Count)。"
      }
    }

    $name = [System.IO.Path]::GetFileName($migration)
    $migrationRole = if ($migration -in @(
      (Join-Path $script:RepoRoot 'supabase\migrations\0003_usage_jobs.sql'),
      $script:ProjectLegacyMigrationFile,
      (Join-Path $script:RepoRoot 'supabase\migrations\0011_project_requirements_classification.sql'),
      (Join-Path $script:RepoRoot 'supabase\migrations\0012_stage_drafts.sql'),
      (Join-Path $script:RepoRoot 'supabase\migrations\0022_project_create_replay_only.sql'),
      (Join-Path $script:RepoRoot 'supabase\migrations\0023_project_task_done.sql'),
      (Join-Path $script:RepoRoot 'supabase\migrations\0024_project_task_manual_import.sql'),
      (Join-Path $script:RepoRoot 'supabase\migrations\0025_stage_draft_confirmation.sql'),
  (Join-Path $script:RepoRoot 'supabase\migrations\0024_project_task_manual_import.sql')
    )) { 'supabase_admin' } else { 'postgres' }
    $result = Invoke-DbFile -Name "migration-$name" -Role $migrationRole -Path $migration -PsqlOptions @('-q')
    Assert-CommandSuccess -Result $result
    if ($null -ne $draftMigrationBefore -and $name -eq '0012_stage_drafts.sql') {
      $draftMigrationAfter = Invoke-DbSql -Name 'stage-draft-migration-after-projects' -Role 'postgres' -Sql @'
SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY id),'[]'::jsonb)::text FROM app.projects p;
'@ -PsqlOptions @('-q', '-A', '-t')
      Assert-CommandSuccess -Result $draftMigrationAfter
      if ($draftMigrationAfter.Stdout.Trim() -cne $draftMigrationBefore.Stdout.Trim()) {
        throw '0012 migration 改變既有專案欄位。'
      }
      [void](Save-ProjectMigrationEvidence -Name 'after-0012')
      $script:TestResults.Add([ordered]@{
        file = '0011→0012 migration compatibility'
        result = 'passed'
        old_rows = 6
        all_project_fields_identical = $true
      })
    }

    if ($null -ne $projectMigrationBefore -and $migration -eq $script:ProjectLegacyMigrationFile) {
      $projectMigrationAfter = Save-ProjectMigrationEvidence -Name 'after-0010'
      if ($projectMigrationAfter.data -cne $projectMigrationBefore.data) {
        throw '0009→0010 遷移改變了合成歷史列既有欄位資料。'
      }
      $comparison = [ordered]@{
        migration = $name
        applied_once_after_0009 = $true
        old_row_count = $beforeRows.Count
        old_fields_identical = $true
        before_data_sha256 = (Get-Sha256 -Path (Join-Path $script:EvidencePath 'migration\before-0010-data.json'))
        after_data_sha256 = (Get-Sha256 -Path (Join-Path $script:EvidencePath 'migration\after-0010-data.json'))
        before_catalog_sha256 = (Get-Sha256 -Path (Join-Path $script:EvidencePath 'migration\before-0010-catalog.json'))
        after_catalog_sha256 = (Get-Sha256 -Path (Join-Path $script:EvidencePath 'migration\after-0010-catalog.json'))
      }
      Write-Utf8File -Path (Join-Path $script:EvidencePath 'migration\comparison.json') `
        -Text ($comparison | ConvertTo-Json -Depth 5)
      $script:TestResults.Add([ordered]@{
        file = '0009→0010 migration compatibility'
        result = 'passed'
        old_rows = $beforeRows.Count
        prior_fields_identical = $true
        before_catalog_captured = $true
        after_catalog_captured = $true
      })
      $projectMigrationBefore = $null
    }

    if ($Scenario -in @('Projects', 'Usage') -and
        [System.IO.Path]::GetFileName($migration) -eq '0011_project_requirements_classification.sql') {
      $projectMigrationAfter = Save-ProjectMigrationEvidence -Name 'after-0011'
      $beforeDataPath = Join-Path $script:EvidencePath 'migration\before-0010-data.json'
      if ($projectMigrationAfter.data -cne [System.IO.File]::ReadAllText($beforeDataPath).Trim()) {
        throw '0011 migration 改變了歷史專案的舊 DTO 欄位。'
      }
      $legacyMetadata = Invoke-DbSql -Name 'projects-migration-after-0011-classification-state' `
        -Role 'postgres' -Sql @'
SELECT (count(*) = 6
  AND bool_and(classification_state = 'legacy_unverified')
  AND bool_and(requirements_revision = 0)
  AND bool_and(current_confirmation_id IS NULL)
  AND bool_and(tier IN ('A', 'B'))
  AND bool_and(needs_visitor_identity IN (true, false)))::text
FROM app.projects
WHERE id BETWEEN
  '79000000-0000-4000-8000-000000000001'::uuid AND
  '79000000-0000-4000-8000-000000000006'::uuid;
'@ -PsqlOptions @('-q', '-A', '-t')
      Assert-CommandSuccess -Result $legacyMetadata
      if ($legacyMetadata.Stdout.Trim() -ne 'true') {
        throw '0011 migration 未將全部歷史列保留為無確認證據的 legacy_unverified。'
      }
      Write-Utf8File -Path (Join-Path $script:EvidencePath 'migration\0010-to-0011-comparison.json') `
        -Text (([ordered]@{
          applied_once_after_0010 = $true
          old_fields_identical = $true
          legacy_rows_unconfirmed = $true
          before_data_sha256 = (Get-Sha256 -Path $beforeDataPath)
          after_data_sha256 = (Get-Sha256 -Path (Join-Path $script:EvidencePath 'migration\after-0011-data.json'))
          after_catalog_sha256 = (Get-Sha256 -Path (Join-Path $script:EvidencePath 'migration\after-0011-catalog.json'))
        } | ConvertTo-Json -Depth 5))
      $script:TestResults.Add([ordered]@{
        file = '0010→0011 migration compatibility'
        result = 'passed'
        old_rows = 6
        prior_fields_identical = $true
        legacy_rows_unconfirmed = $true
        catalog_captured = $true
      })
    }
  }

  $extension = Invoke-DbSql -Name 'ensure-pgtap-extension' -Role 'postgres' -Sql 'CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;' -PsqlOptions @('-q')
  Assert-CommandSuccess -Result $extension
  $extensionVersion = Invoke-DbSql -Name 'verify-pgtap-version' -Role 'postgres' -Sql "SELECT extversion FROM pg_extension WHERE extname = 'pgtap';" -PsqlOptions @('-q', '-A', '-t')
  Assert-CommandSuccess -Result $extensionVersion
  if ($extensionVersion.Stdout.Trim() -ne '1.3.3') {
    throw "pgTAP 版本不符：$($extensionVersion.Stdout.Trim())"
  }
  $script:EnvironmentInfo.pgtap_extension_version = $extensionVersion.Stdout.Trim()

  $beforeSnapshot = Save-Snapshot -Name 'before-temporary-grants'
  if ($beforeSnapshot -contains "role_membership`tpostgres`tapp_audit_writer`ttrue") {
    throw '新建資料庫中 postgres 已是 app_audit_writer member；拒絕執行。'
  }
  $script:RevocationStatus = 'pending'
  $grantResult = Invoke-DbFile -Name 'temporary-test-grants' -Role 'supabase_admin' -Path $script:GrantFile -PsqlOptions @('-q')
  Assert-CommandSuccess -Result $grantResult
  $activeSnapshot = Save-Snapshot -Name 'temporary-grants-active'
  Assert-TemporaryGrantsActive -Snapshot $activeSnapshot
  Compare-PrivilegeSnapshots -Before $beforeSnapshot -After $activeSnapshot -Description '授權期間'
  $setRoleCheck = Invoke-DbSql -Name 'verify-control-set-role' -Role 'postgres' -Sql "SET ROLE app_audit_writer;`nSELECT current_user;`nRESET ROLE;`n" -PsqlOptions @('-q', '-A', '-t')
  Assert-CommandSuccess -Result $setRoleCheck
  if ($setRoleCheck.Stdout.Trim() -ne 'app_audit_writer') {
    throw '控制連線沒有以 app_audit_writer 身分完成實際 SET ROLE 驗證。'
  }

  if ($Scenario -eq 'SqlError') {
    $sqlError = Invoke-DbSql -Name 'injected-sql-error' -Role 'postgres' -Sql "SELECT 1 / 0;`n" -PsqlOptions @('-q', '-A', '-t')
    if ($sqlError.ExitCode -eq 0 -or $sqlError.Stderr -notmatch '(?im)^\s*ERROR:.*division by zero') {
      throw "SQL error 故障注入沒有以預期非零狀態及 division by zero 錯誤失敗（exit $($sqlError.ExitCode)）。"
    }
    $script:TestResults.Add([ordered]@{
      file = 'synthetic SELECT 1 / 0'
      result = 'sql_error_rejected'
      psql_exit_code = $sqlError.ExitCode
      command_id = $sqlError.CommandId
      stdout_file = $sqlError.StdoutFile
      stderr_file = $sqlError.StderrFile
      error = 'division by zero'
    })
    throw "SQL error 已正確偵測：psql exit $($sqlError.ExitCode)，division by zero。"
  }

  foreach ($testFile in $script:TestFiles) {
    $testName = [System.IO.Path]::GetFileName($testFile)
    $inputPath = $testFile
    if ($Scenario -eq 'NotOk' -and $testName -eq 'identity_audit.test.sql') {
      $testSql = [System.IO.File]::ReadAllText($testFile)
      $needle = 'SELECT extensions.no_plan();'
      if (($testSql.Split(@($needle), [System.StringSplitOptions]::None).Length - 1) -ne 1) {
        throw '無法安全建立 not ok 測試副本：原始定位語句不是唯一。'
      }
      $copySql = $testSql.Replace(
        $needle,
        "$needle`nSELECT extensions.ok(false, 'intentional runner failure injection');"
      )
      $script:FailureInjectionPath = Join-Path $script:EvidencePath 'temporary-not-ok.test.sql'
      Write-Utf8File -Path $script:FailureInjectionPath -Text $copySql
      $inputPath = $script:FailureInjectionPath
    }

    $record = [ordered]@{
      file = $testName
      psql_exit_code = $null
      result = 'not_run'
      planned = $null
      passed = $null
      failed = $null
      error = $null
      command_id = $null
      stdout_file = $null
      stderr_file = $null
      derived_tap_file = "$testName.derived.tap"
      derived_tap_kind = 'filtered assertions and plan; not complete stdout'
    }
    $script:TestResults.Add($record)
    $psql = Invoke-DbFile -Name "pgtap-$testName" -Role 'postgres' -Path $inputPath -PsqlOptions @('-q', '-A', '-t')
    $record.psql_exit_code = $psql.ExitCode
    $record.command_id = $psql.CommandId
    $record.stdout_file = $psql.StdoutFile
    $record.stderr_file = $psql.StderrFile
    try {
      $tap = Read-TapResult -Output $psql.Stdout -Stderr $psql.Stderr -PsqlExitCode $psql.ExitCode
      $record.result = 'passed'
      $record.planned = $tap.planned
      $record.passed = $tap.passed
      $record.failed = 0
      Write-Utf8File -Path (Join-Path $script:EvidencePath $record.derived_tap_file) -Text $tap.tap
    }
    catch {
      $record.result = 'failed'
      $record.error = $_.Exception.Message
      $candidateTap = @($psql.Stdout -split "`r?`n" | Where-Object {
        $_ -match '^(?:ok|not ok)\s+\d+\s+-\s+' -or $_ -match '^1\.\.'
      }) -join "`n"
      Write-Utf8File -Path (Join-Path $script:EvidencePath $record.derived_tap_file) -Text (($candidateTap.TrimEnd()) + "`n")
      throw "$testName：$($record.error)"
    }
    finally {
      if ($script:FailureInjectionPath -and (Test-Path -LiteralPath $script:FailureInjectionPath)) {
        Remove-Item -LiteralPath $script:FailureInjectionPath -Force
        $script:FailureInjectionPath = $null
      }
    }
  }

  if ($Scenario -eq 'NotOk') {
    throw 'not ok 故障注入未被 TAP 判讀器拒絕。'
  }
  if ($Scenario -in @('Authorization', 'Projects', 'Usage')) {
    Invoke-AuthorizationTests
  }
}

function Invoke-AuthorizationTests {
  $authorizationPassword = New-SecretHex -ByteCount 32
  $script:Secrets += $authorizationPassword
  $env:APP_PLANET_AUTHORIZATION_PASSWORD = $authorizationPassword
  $env:APP_PLANET_AUTHORIZATION_RUN = 'isolated-runner'
  try {
    # 僅本輪容器的測試 actor；密碼經 stdin 且已加入 Protect-Output，不進命令參數。
    $setup = Invoke-DbSql -Name 'authorization-actor-setup' -Role 'supabase_admin' -Sql @"
CREATE ROLE app_authorization_test LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '$authorizationPassword';
GRANT authenticated TO app_authorization_test WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;
SELECT rolname, rolsuper, rolbypassrls, rolinherit FROM pg_roles WHERE rolname='app_authorization_test';
"@ -PsqlOptions @('-q', '-A', '-t')
    Assert-CommandSuccess -Result $setup
    $result = Invoke-Captured -Name 'application-authorization-integration' -FilePath 'node' -Arguments @(
      (Join-Path $script:RepoRoot 'node_modules\vitest\vitest.mjs'),
      'run', '--config', (Join-Path $script:RepoRoot 'vitest.authorization.config.ts')
    )
    $script:TestResults.Add([ordered]@{
      file = 'tests/integration/authorization.test.ts'
      result = $(if ($result.ExitCode -eq 0) { 'passed' } else { 'failed' })
      command_id = $result.CommandId
      exit_code = $result.ExitCode
      stdout_file = $result.StdoutFile
      stderr_file = $result.StderrFile
    })
    Assert-CommandSuccess -Result $result
    if ($Scenario -in @('Projects', 'Usage')) {
      $projects = Invoke-Captured -Name 'application-projects-integration' -FilePath 'node' -Arguments @(
        (Join-Path $script:RepoRoot 'node_modules\vitest\vitest.mjs'),
        'run', '--config', (Join-Path $script:RepoRoot 'vitest.projects.config.ts')
      )
      $script:TestResults.Add([ordered]@{
        file = 'tests/integration/projects.test.ts'
        files = @('tests/integration/projects.test.ts', 'tests/integration/project-create.test.ts',
          'tests/integration/project-classification.test.ts', 'tests/integration/stage-drafts.test.ts',
          'tests/integration/stage-draft-save-controller.test.ts',
          'tests/integration/project-workspace.test.ts')
        result = $(if ($projects.ExitCode -eq 0) { 'passed' } else { 'failed' })
        command_id = $projects.CommandId
        exit_code = $projects.ExitCode
        stdout_file = $projects.StdoutFile
        stderr_file = $projects.StderrFile
      })
      Assert-CommandSuccess -Result $projects
    }
    if ($Scenario -eq 'Usage') {
      $usageSetup = Invoke-DbSql -Name 'usage-actor-setup' -Role 'supabase_admin' -Sql @"
CREATE ROLE app_usage_test LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '$authorizationPassword';
GRANT app_usage_executor, app_job_executor TO app_usage_test WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;
"@ -PsqlOptions @('-q')
      Assert-CommandSuccess -Result $usageSetup
      try {
        $usage = Invoke-Captured -Name 'application-usage-worker-integration' -FilePath 'node' -Arguments @(
          (Join-Path $script:RepoRoot 'node_modules\vitest\vitest.mjs'),
          'run', '--config', (Join-Path $script:RepoRoot 'vitest.usage.config.ts')
        )
        $script:TestResults.Add([ordered]@{
          file = 'tests/integration/usage-worker.test.ts'
          result = $(if ($usage.ExitCode -eq 0) { 'passed' } else { 'failed' })
          exit_code = $usage.ExitCode
          command_id = $usage.CommandId
        })
        Assert-CommandSuccess -Result $usage
        $foundation = Invoke-Captured -Name 'application-http-foundation-integration' -FilePath 'node' -Arguments @(
          (Join-Path $script:RepoRoot 'node_modules\vitest\vitest.mjs'),
          'run', '--config', (Join-Path $script:RepoRoot 'vitest.foundation.config.ts')
        )
        $script:TestResults.Add([ordered]@{
          file = 'tests/integration/http-foundation.test.ts'
          result = $(if ($foundation.ExitCode -eq 0) { 'passed' } else { 'failed' })
          exit_code = $foundation.ExitCode
          command_id = $foundation.CommandId
        })
        Assert-CommandSuccess -Result $foundation
      }
      finally {
        $usageDrop = Invoke-DbSql -Name 'usage-actor-drop' -Role 'supabase_admin' -Sql 'DROP ROLE app_usage_test;' -PsqlOptions @('-q')
        Assert-CommandSuccess -Result $usageDrop
      }
    }
  }
  finally {
    $drop = Invoke-DbSql -Name 'authorization-actor-drop' -Role 'supabase_admin' -Sql @'
DROP ROLE IF EXISTS app_authorization_test;
SELECT count(*) FROM pg_roles WHERE rolname='app_authorization_test';
'@ -PsqlOptions @('-q', '-A', '-t')
    Assert-CommandSuccess -Result $drop
    if ($drop.Stdout.Trim() -ne '0') {
      throw '本輪應用程式測試 actor 未完整移除。'
    }
  }
}

function Invoke-ParserSelfTest {
  Assert-RepositoryContext
  return Test-TapParser
}

function Invoke-SyntheticOutput {
  param(
    [AllowEmptyString()][string]$Stdout,
    [AllowEmptyString()][string]$Stderr = '',
    [int]$ExitCode = 0
  )

  $stdoutBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Stdout))
  $stderrBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Stderr))
  $child = @"
[Console]::OutputEncoding = [Text.UTF8Encoding]::new(`$false)
[Console]::Out.Write([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('$stdoutBase64')))
[Console]::Error.Write([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('$stderrBase64')))
exit $ExitCode
"@
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($child))
  return Invoke-Captured -Name 'pgtap-synthetic' -FilePath (Join-Path $PSHOME 'powershell.exe') -Arguments @(
    '-NoProfile', '-NonInteractive', '-EncodedCommand', $encoded
  )
}

function Invoke-EvidenceSelfTest {
  Assert-RepositoryContext
  $fakeCredential = 'synthetic-only-' + [guid]::NewGuid().ToString('N')
  $script:Secrets = @($fakeCredential)
  $cases = @(
    @{ Name = 'valid'; Text = "  ok 1 - 合成測試  `r`n`r`n1..1`r`n"; Error = $null },
    @{ Name = 'not-ok'; Text = "not ok 1 - synthetic`n# diagnostic before plan`n1..1`n# diagnostic after plan`n"; Error = 'TAP not ok' },
    @{ Name = 'unknown'; Text = "ok 1 - before marker`r`nAPPPLANET_UNRECOGNIZED_36`r`n1..1`r`n"; Error = '未識別' },
    @{ Name = 'redaction'; Text = "ok 1 - $fakeCredential`r`n1..1`r`n"; Stderr = "  before $fakeCredential after  `n`n"; Error = $null },
    @{ Name = 'sql-error'; Text = "ok 1 - before error`n1..1`n"; Stderr = "ERROR: synthetic SQL failure`n"; Error = 'SQL ERROR／FATAL' },
    @{ Name = 'empty'; Text = ''; Error = '輸出空白' },
    @{ Name = 'nonzero'; Text = "ok 1 - nonzero`n1..1`n"; ExitCode = 3; Error = '非零退出' }
  )
  $results = @()
  foreach ($case in $cases) {
    $stderr = if ($case.ContainsKey('Stderr')) { $case.Stderr } else { '' }
    $exitCode = if ($case.ContainsKey('ExitCode')) { $case.ExitCode } else { 0 }
    $result = Invoke-SyntheticOutput -Stdout $case.Text -Stderr $stderr -ExitCode $exitCode
    $savedStdout = [IO.File]::ReadAllText((Join-Path $script:EvidencePath $result.StdoutFile.Replace('/', '\')))
    $savedStderr = [IO.File]::ReadAllText((Join-Path $script:EvidencePath $result.StderrFile.Replace('/', '\')))
    if ($savedStdout -cne $case.Text.Replace($fakeCredential, '[REDACTED]') -or
        $savedStderr -cne $stderr.Replace($fakeCredential, '[REDACTED]') -or
        $result.ExitCode -ne $exitCode) {
      throw "證據合成測試 $($case.Name) 完整文字／行序／退出碼不符。"
    }
    $parserError = $null
    try {
      [void](Read-TapResult -Output $result.Stdout -Stderr $result.Stderr -PsqlExitCode $result.ExitCode)
    }
    catch {
      $parserError = $_.Exception.Message
    }
    if (($null -eq $case.Error -and $null -ne $parserError) -or
        ($null -ne $case.Error -and ($null -eq $parserError -or $parserError -notmatch $case.Error))) {
      throw "證據合成測試 $($case.Name) 判讀結果不符：$parserError"
    }
    $results += [ordered]@{
      case = $case.Name
      command_id = $result.CommandId
      result = 'passed'
      saved_before_parsing = $true
      parser_error = $parserError
    }
  }
  return $results
}

function Invoke-EvidenceWriteFailure {
  Assert-RepositoryContext
  $id = '{0:D4}' -f ($script:Commands.Count + 1)
  $blockedPath = Join-Path $script:EvidencePath "commands\$id-pgtap-synthetic.stdout.txt"
  New-Item -ItemType Directory -Path $blockedPath | Out-Null
  try {
    [void](Invoke-SyntheticOutput -Stdout "ok 1 - synthetic write failure`n1..1`n")
  }
  finally {
    Remove-Item -LiteralPath $blockedPath -Force
    $cleanupId = '{0:D4}' -f ($script:Commands.Count + 1)
    $cleanupBlockedPath = Join-Path $script:EvidencePath "commands\$cleanupId-pgtap-synthetic.stderr.txt"
    New-Item -ItemType Directory -Path $cleanupBlockedPath | Out-Null
    $script:InCleanup = $true
    try {
      $cleanupProbe = Invoke-SyntheticOutput -Stdout "synthetic cleanup continued`n"
      if ($cleanupProbe.ExitCode -ne 0 -or $cleanupProbe.Stdout -cne "synthetic cleanup continued`n" -or
          $script:EvidenceErrors.Count -ne 2) {
        throw '合成清理探針未在明確記錄證據錯誤後繼續。'
      }
    }
    finally {
      $script:InCleanup = $false
      Remove-Item -LiteralPath $cleanupBlockedPath -Force
    }
  }
  throw '證據寫入故障未被拒絕。'
}

function Write-RunSummary {
  param([Parameter(Mandatory)][string]$Status)

  $summary = [ordered]@{
    run_id = $script:RunId
    scenario = $Scenario
    started_at = $script:Timestamp
    finished_at = (Get-Date).ToString('o')
    status = $Status
    runner_exit_code = if ($Status -eq 'passed' -and $script:CleanupStatus -in @('complete', 'not_needed')) { 0 } else { 1 }
    failure_reason = $script:RunError
    evidence_errors = @($script:EvidenceErrors)
    output_format = [ordered]@{
      capture = 'complete redacted decoded text; not original bytes'
      decoding = 'Process StreamReader UTF-8 with replacement fallback and BOM detection'
      storage = 'UTF-8 without BOM; no trimming, line filtering or reordering'
      redaction = 'Protect-Output replaces only credentials known to this run; not a general PII/secret detector'
      derived = '*.derived.tap and permissions/*.tsv; run-summary.json is a derived index'
    }
    environment = $script:EnvironmentInfo
    cleanup_status = $script:CleanupStatus
    cleanup_errors = @($script:CleanupErrors)
    temporary_grant_revocation_status = $script:RevocationStatus
    resource_identifiers = $script:Resources
    tests = @($script:TestResults)
    commands = @($script:Commands)
    source_sha256 = Get-SourceHashes
  }
  Write-Utf8File -Path (Join-Path $script:EvidencePath 'run-summary.json') -Text ($summary | ConvertTo-Json -Depth 12)
}

$status = 'failed'
$parserResult = $null
try {
  if (Test-Path -LiteralPath $script:EvidencePath) {
    throw "證據目錄碰撞；拒絕覆寫：$($script:EvidencePath)"
  }
  New-Item -ItemType Directory -Path $script:EvidencePath | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $script:EvidencePath 'commands') | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $script:EvidencePath 'permissions') | Out-Null

  $sourceHashes = Get-SourceHashes
  Write-Utf8File -Path (Join-Path $script:EvidencePath 'source-sha256.json') -Text ($sourceHashes | ConvertTo-Json -Depth 5)
  if ($Scenario -eq 'ParserSelfTest') {
    $parserResult = Invoke-ParserSelfTest
    Write-Utf8File -Path (Join-Path $script:EvidencePath 'parser-self-test.json') -Text ($parserResult | ConvertTo-Json -Depth 5)
    $status = 'passed'
  }
  elseif ($Scenario -eq 'EvidenceSelfTest') {
    $evidenceResult = Invoke-EvidenceSelfTest
    Write-Utf8File -Path (Join-Path $script:EvidencePath 'evidence-self-test.json') -Text (ConvertTo-Json -InputObject @($evidenceResult) -Depth 6)
    $status = 'passed'
  }
  elseif ($Scenario -eq 'EvidenceWriteFailure') {
    Invoke-EvidenceWriteFailure
  }
  else {
    Invoke-DatabaseScenario
    $status = 'passed'
  }
}
catch {
  $script:RunError = $_.Exception.Message
  $status = 'failed'
}
finally {
  $script:InCleanup = $true
  if ($script:FailureInjectionPath -and (Test-Path -LiteralPath $script:FailureInjectionPath)) {
    Remove-Item -LiteralPath $script:FailureInjectionPath -Force
    $script:FailureInjectionPath = $null
  }

  if ($script:ComposeAttempted) {
    if ($script:RevocationStatus -ne 'not_attempted') {
      try {
        $revoke = Invoke-DbFile -Name 'temporary-test-revokes' -Role 'supabase_admin' -Path $script:RevokeFile -PsqlOptions @('-q')
        Assert-CommandSuccess -Result $revoke
        $script:RevocationStatus = 'sql_revoked'
        $afterSnapshot = Save-Snapshot -Name 'after-temporary-revokes'
        $beforePath = Join-Path $script:EvidencePath 'permissions\before-temporary-grants.tsv'
        if (Test-Path -LiteralPath $beforePath) {
          $beforeRows = Get-Content -LiteralPath $beforePath
          Assert-TemporaryGrantsRevoked -Snapshot $afterSnapshot -BeforeSnapshot $beforeRows
          Compare-PrivilegeSnapshots -Before $beforeRows -After $afterSnapshot -Description '撤銷後'
          Compare-CatalogSnapshots -Before $beforeRows -After $afterSnapshot
          $script:RevocationStatus = 'verified'
        }
        else {
          $script:RevocationStatus = 'revoked_unverified_baseline'
          $script:CleanupErrors.Add('已執行撤銷，但缺少授權前快照，無法比較權限基線。')
        }
      }
      catch {
        $script:RevocationStatus = if ($script:RevocationStatus -eq 'sql_revoked') { 'sql_revoked_unverified' } else { 'unverified' }
        $script:CleanupErrors.Add("測試專用授權撤銷／查核失敗：$($_.Exception.Message)")
      }
    }
    Remove-OwnedResources
  }
  elseif ($script:CleanupStatus -eq 'not_started') {
    $script:CleanupStatus = 'not_needed'
  }

  foreach ($name in @(
    'APP_PLANET_PGTAP_POSTGRES_PASSWORD',
    'APP_PLANET_PGTAP_JWT_SECRET',
    'APP_PLANET_PGTAP_PORT',
    'APP_PLANET_AUTHORIZATION_PASSWORD',
    'APP_PLANET_AUTHORIZATION_RUN'
  )) {
    [Environment]::SetEnvironmentVariable($name, $null, 'Process')
  }

  if ($script:CleanupErrors.Count -gt 0 -and $script:CleanupStatus -eq 'complete') {
    $script:CleanupStatus = 'failed'
  }
  if ($script:EvidenceErrors.Count -gt 0) {
    $status = 'failed'
    if (-not $script:RunError) {
      $script:RunError = '命令證據寫入失敗；詳見 evidence_errors。'
    }
  }
  if ($status -eq 'passed' -and ($script:CleanupStatus -eq 'failed' -or $script:CleanupStatus -eq 'unverified')) {
    $status = 'failed'
    $script:RunError = '測試成功但資源清理未完整驗證。'
  }
  if ($Scenario -ne 'ParserSelfTest' -and $script:ComposeAttempted -and $script:CleanupStatus -eq 'complete' -and
      (@($script:Resources.container_ids).Count -eq 0) -and
      ($script:Commands | Where-Object { $_.name -eq 'compose-up' -and $_.exit_code -eq 0 }) -and
      (@($script:Resources.removed_container_ids).Count -eq 0)) {
    $script:CleanupStatus = 'failed'
    $script:CleanupErrors.Add('Compose 已成功啟動，但未記錄到 runner 專用 container；無法證明資源清理範圍。')
    $status = 'failed'
  }

  try {
    Write-RunSummary -Status $status
  }
  catch {
    [Console]::Error.WriteLine("無法寫入 run-summary.json：$($_.Exception.Message)")
    $status = 'failed'
  }
}

Write-Output "Scenario=$Scenario"
Write-Output "Status=$status"
Write-Output "Revocation=$script:RevocationStatus"
Write-Output "Cleanup=$script:CleanupStatus"
Write-Output "Evidence=$script:EvidencePath"
if ($script:RunError) {
  [Console]::Error.WriteLine($script:RunError)
}

if ($status -eq 'passed' -and $script:CleanupStatus -in @('complete', 'not_needed')) {
  exit 0
}
exit 1
