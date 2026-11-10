param([Parameter(Mandatory=$true)][string]$DshCli)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$verificationRoot = Join-Path $projectRoot '.verification'
$isolatedHome = Join-Path $verificationRoot 'dsh-home'
$profilePath = Join-Path $isolatedHome 'profiles\runtime-log-smoke'
$bundlePath = Join-Path $profilePath 'node_modules\dsh-runtime-log'
$homeConfig = $env:DSH_HOME
if ([string]::IsNullOrWhiteSpace($homeConfig)) {
  $realDshHome = Join-Path $env:USERPROFILE '.dsh'
} elseif ($homeConfig -eq '~') {
  $realDshHome = $env:USERPROFILE
} elseif ($homeConfig.StartsWith('~/') -or $homeConfig.StartsWith('~\')) {
  $realDshHome = Join-Path $env:USERPROFILE $homeConfig.Substring(2)
} else {
  $realDshHome = $homeConfig
}
$realDshHome = [System.IO.Path]::GetFullPath($realDshHome)
$realProfileRoot = Join-Path $realDshHome 'profiles'
if (-not (Test-Path -LiteralPath $realProfileRoot -PathType Container)) { throw ('Real DSH profile root not found: ' + $realProfileRoot) }
$realProfilePaths = @()
$homePatch = Join-Path $realDshHome 'cordis.patch.yml'
if (Test-Path -LiteralPath $homePatch -PathType Leaf) { $realProfilePaths += $homePatch }
foreach ($profile in Get-ChildItem -LiteralPath $realProfileRoot -Directory) {
  foreach ($name in @('package.json','cordis.patch.yml','cordis.yml','compatibility.json')) {
    $candidate = Join-Path $profile.FullName $name
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { $realProfilePaths += $candidate }
  }
}
if ($realProfilePaths.Count -eq 0) { throw 'No real profile configuration files found; integrity check cannot pass vacuously.' }
$baseline = @{}
foreach ($file in $realProfilePaths) { $baseline[$file] = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash }
New-Item -ItemType Directory -Force -Path $bundlePath | Out-Null
foreach ($item in @('package.json','cordis.patch.yml','src')) { Copy-Item -LiteralPath (Join-Path $projectRoot $item) -Destination $bundlePath -Recurse -Force }
$manifest = @{name='runtime-log-smoke';private=$true;dependencies=@{'dsh-runtime-log'='file:node_modules/dsh-runtime-log'};dsh=@{profile=@{bundles=@('dsh-runtime-log')}}} | ConvertTo-Json -Depth 8
Set-Content -LiteralPath (Join-Path $profilePath 'package.json') -Value $manifest -Encoding utf8NoBOM
Set-Content -LiteralPath (Join-Path $profilePath 'cordis.patch.yml') -Value '[]' -Encoding utf8NoBOM
$previousDshHome = $env:DSH_HOME
try {
  $env:DSH_HOME = $isolatedHome
  $dump = & $DshCli --profile runtime-log-smoke --dump-config 2> (Join-Path $verificationRoot 'config-stderr.txt')
  if ($LASTEXITCODE -ne 0) { throw 'DSH --dump-config failed' }
  $dump | Set-Content -LiteralPath (Join-Path $verificationRoot 'config.yml') -Encoding utf8NoBOM
  if (($dump -join [Environment]::NewLine) -notmatch 'dsh-runtime-log') { throw 'Plugin missing from composed configuration' }
  $schemaText = & $DshCli --profile runtime-log-smoke --dump-config-schema 2> (Join-Path $verificationRoot 'schema-stderr.txt')
  if ($LASTEXITCODE -ne 0) { throw 'DSH --dump-config-schema failed' }
  $schemaText | Set-Content -LiteralPath (Join-Path $verificationRoot 'schema.json') -Encoding utf8NoBOM
  $schema = ($schemaText -join [Environment]::NewLine) | ConvertFrom-Json -Depth 100
  if ($null -eq $schema) { throw 'No configuration schema returned' }
  $schemaErrors = @($schema.'x-cordis'.diagnostics | Where-Object { $_.level -eq 'error' })
  if ($schemaErrors.Count -gt 0) { throw ('Configuration schema reports errors: ' + ($schemaErrors | ConvertTo-Json -Compress)) }
  if ((@($schema.'x-cordis'.entries) | ConvertTo-Json -Depth 30 -Compress) -notmatch 'dsh-runtime-log') { throw 'Plugin is absent from schema entries' }
  $negativeProfile = Join-Path $isolatedHome 'profiles\runtime-log-negative'
  $negativeBundle = Join-Path $negativeProfile 'node_modules\dsh-runtime-log-bad'
  New-Item -ItemType Directory -Force -Path $negativeBundle | Out-Null
  Set-Content -LiteralPath (Join-Path $negativeBundle 'package.json') -Value '{"name":"dsh-runtime-log-bad","version":"0.1.0"}' -Encoding utf8NoBOM
  Set-Content -LiteralPath (Join-Path $negativeProfile 'package.json') -Value '{"name":"runtime-log-negative","private":true,"dsh":{"profile":{"bundles":["dsh-runtime-log-bad"]}}}' -Encoding utf8NoBOM
  Set-Content -LiteralPath (Join-Path $negativeProfile 'cordis.patch.yml') -Value '[]' -Encoding utf8NoBOM
  $negativeDump = & $DshCli --profile runtime-log-negative --dump-config 2> (Join-Path $verificationRoot 'negative-stderr.txt')
  if ($LASTEXITCODE -ne 0) { throw 'Negative fixture failed for an unexpected reason' }
  if (($negativeDump -join [Environment]::NewLine) -match 'name: dsh-runtime-log-bad') { throw 'Validator accepted the invalid bundle' }
  $negativeReason = Get-Content -LiteralPath (Join-Path $verificationRoot 'negative-stderr.txt') -Raw
  if ($negativeReason -notmatch 'declares no dsh.bundle') { throw 'Missing the expected invalid-bundle diagnostic' }
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'fixture-host.mjs') -Destination (Join-Path $profilePath 'fixture-host.mjs') -Force
  $receiptDir = Join-Path $verificationRoot ('profile-logs-' + [guid]::NewGuid().ToString('N'))
  $receiptDirYaml = $receiptDir.Replace('\','/')
  $smokePatch = @('- id: dsh-runtime-log','  config:',('    directory: ' + ($receiptDirYaml | ConvertTo-Json -Compress)),'- insert:','    - id: runtime-log-smoke-runner','      name: ./fixture-host.mjs')
  $smokePatch | Set-Content -LiteralPath (Join-Path $profilePath 'cordis.patch.yml') -Encoding utf8NoBOM
  $hostOutput = & $DshCli --profile runtime-log-smoke 2> (Join-Path $verificationRoot 'host-stderr.txt')
  if ($LASTEXITCODE -ne 0) { throw 'Isolated DSH host boot failed' }
  $hostOutput | Set-Content -LiteralPath (Join-Path $verificationRoot 'host-stdout.txt') -Encoding utf8NoBOM
  if (-not (Test-Path -LiteralPath $receiptDir)) { throw 'The plugin did not create its log directory' }
  $logFiles = @(Get-ChildItem -LiteralPath $receiptDir -File | Where-Object Name -Match '^host-.*\.jsonl(\.\d+)?$')
  if ($logFiles.Count -eq 0) { throw 'No activation/log file was created by the plugin' }
  $rows = @()
  foreach ($logFile in $logFiles) { foreach ($line in (Get-Content -LiteralPath $logFile.FullName | Where-Object { $_.Trim() })) { $rows += ($line | ConvertFrom-Json -Depth 30) } }
  if (@($rows | Where-Object { $_.message -eq 'PROFILE_SMOKE_WARN ok' }).Count -ne 1) { throw 'WARN missing/duplicated in the real test host' }
  if (@($rows | Where-Object { $_.message -eq 'PROFILE_SMOKE_ERROR' }).Count -ne 1) { throw 'ERROR missing/duplicated in the real test host' }
  if (@($rows | Where-Object { $_.message -eq 'PROFILE_SMOKE_INFO' }).Count -ne 0) { throw 'INFO was unexpectedly retained' }
  $changed = @()
  foreach ($file in $realProfilePaths) { if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $baseline[$file]) { $changed += $file } }
  if ($changed.Count -gt 0) { throw ('Real profile changed: ' + ($changed -join ', ')) }
  [pscustomobject]@{configComposed=$true;schemaParsed=$true;invalidBundleRejected=$true;isolatedHostBoot=$true;warnErrorPersisted=$true;infoExcluded=$true;realProfilesUnchanged=$true;realProfileFilesChecked=$realProfilePaths.Count;profile='runtime-log-smoke';isolatedHome=$isolatedHome} | ConvertTo-Json
} finally {
  $env:DSH_HOME = $previousDshHome
  if (Test-Path -LiteralPath $verificationRoot) { Remove-Item -LiteralPath $verificationRoot -Recurse -Force }
}
