$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$nodeVersion = (& node --version).Trim()
if ($nodeVersion -notmatch '^v24\.') {
  throw "XiaoChu requires Node.js 24.x. Current version: $nodeVersion"
}

$healthUrl = 'http://localhost:4173/api/health'
try {
  $existing = Invoke-WebRequest -UseBasicParsing -Uri $healthUrl -TimeoutSec 2
  if ($existing.StatusCode -eq 200) {
    Start-Process 'http://localhost:4173'
    Write-Host 'XiaoChu is already running at http://localhost:4173'
    exit 0
  }
} catch {
  # A connection failure means a local server needs to be started.
}

Push-Location $projectRoot
try {
  & npm run build
  if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }

  Write-Host 'Checking local recipe catalogue...'
  $catalogStatusJson = (& node --import tsx scripts/content/catalog-status.ts | Select-Object -Last 1)
  if ($LASTEXITCODE -ne 0) { throw 'Unable to inspect the recipe catalogue.' }
  $catalogStatus = $catalogStatusJson | ConvertFrom-Json

  $canonicalCatalog = Join-Path $projectRoot 'content\canonical\recipes.jsonl'
  $sampleCatalog = Join-Path $projectRoot 'fixtures\recipes\mini-catalog.jsonl'
  if ($catalogStatus.active -eq 0) {
    Write-Host 'Preparing a small starter catalogue so the app can open immediately...'
    & node --import tsx scripts/content/import-catalog.ts --input $sampleCatalog --mode merge
    if ($LASTEXITCODE -notin @(0, 2)) { throw 'Starter recipe import failed.' }
  }

  $runtimeDirectory = Join-Path $env:LOCALAPPDATA 'XiaoChu\runtime'
  New-Item -ItemType Directory -Force -Path $runtimeDirectory | Out-Null
  $stdoutPath = Join-Path $runtimeDirectory 'server.stdout.log'
  $stderrPath = Join-Path $runtimeDirectory 'server.stderr.log'
  $pidPath = Join-Path $runtimeDirectory 'server.pid'
  $serverEntry = Join-Path $projectRoot 'apps\server\dist\index.js'
  $server = Start-Process node -ArgumentList @($serverEntry) -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
  Set-Content -LiteralPath $pidPath -Value $server.Id -Encoding ascii

  $ready = $false
  for ($attempt = 0; $attempt -lt 60; $attempt += 1) {
    if ($server.HasExited) { break }
    Start-Sleep -Milliseconds 500
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri $healthUrl -TimeoutSec 2
      if ($response.StatusCode -eq 200) { $ready = $true; break }
    } catch {
      # Keep waiting until the bounded startup deadline.
    }
  }
  if (-not $ready) {
    throw "XiaoChu did not start. Check $stderrPath"
  }
  Start-Process 'http://localhost:4173'
  Write-Host 'XiaoChu started at http://localhost:4173'
  Write-Host "Server PID: $($server.Id)"

  $fullCatalogAvailable = (Test-Path -LiteralPath $canonicalCatalog) -and (Get-Item -LiteralPath $canonicalCatalog).Length -gt 0
  $catalogImportPidPath = Join-Path $runtimeDirectory 'catalog-import.pid'
  $catalogImportRunning = $false
  if (Test-Path -LiteralPath $catalogImportPidPath) {
    $existingImportPid = Get-Content -LiteralPath $catalogImportPidPath -ErrorAction SilentlyContinue
    if ($existingImportPid -match '^\d+$') {
      $catalogImportRunning = Get-Process -Id ([int]$existingImportPid) -ErrorAction SilentlyContinue
    }
  }
  if ($catalogStatus.active -lt 10000 -and $fullCatalogAvailable -and -not $catalogImportRunning) {
    $catalogImportStdout = Join-Path $runtimeDirectory 'catalog-import.stdout.log'
    $catalogImportStderr = Join-Path $runtimeDirectory 'catalog-import.stderr.log'
    $importProcess = Start-Process node -ArgumentList @(
      '--import', 'tsx',
      'scripts/content/import-catalog.ts',
      '--input', $canonicalCatalog,
      '--mode', 'replace'
    ) -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $catalogImportStdout -RedirectStandardError $catalogImportStderr
    Set-Content -LiteralPath $catalogImportPidPath -Value $importProcess.Id -Encoding ascii
    Write-Host 'The full 10,520-recipe catalogue is importing in the background.'
    Write-Host "You can use the starter recipes now. Reload later to see the full catalogue. Import log: $catalogImportStdout"
  } elseif ($catalogImportRunning) {
    Write-Host 'The full recipe catalogue is already importing in the background.'
  }
} finally {
  Pop-Location
}
