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

  $canonicalCatalog = Join-Path $projectRoot 'content\canonical\recipes.jsonl'
  $sampleCatalog = Join-Path $projectRoot 'fixtures\recipes\mini-catalog.jsonl'
  $catalog = if ((Test-Path -LiteralPath $canonicalCatalog) -and (Get-Item -LiteralPath $canonicalCatalog).Length -gt 0) {
    $canonicalCatalog
  } else {
    $sampleCatalog
  }
  & npx tsx scripts/content/import-catalog.ts --input $catalog --mode merge
  if ($LASTEXITCODE -notin @(0, 2)) { throw 'Recipe import failed.' }

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
} finally {
  Pop-Location
}
