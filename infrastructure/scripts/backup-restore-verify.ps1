param(
  [string]$PgBinDir = "C:\Program Files\PostgreSQL\18\bin",
  [string]$PgHost = "localhost",
  [int]$PgPort = 5435,
  [string]$PgUser = "marketsphere",
  [string]$DbName = "marketsphere"
)

$ErrorActionPreference = "Stop"

if (-not $env:PGPASSWORD) {
  $envPath = Join-Path $PSScriptRoot "..\..\.env"
  if (Test-Path $envPath) {
    foreach ($line in Get-Content $envPath) {
      if ($line -match '^POSTGRES_PASSWORD=(.+)$') {
        $env:PGPASSWORD = $Matches[1].Trim().Trim('"', "'")
      }
      elseif (-not $env:PGPASSWORD -and $line -match '^DATABASE_URL=(.+)$') {
        $dbUrl = $Matches[1].Trim().Trim('"', "'")
        if ($dbUrl -match '^postgresql://[^:]+:([^@]+)@') {
          $env:PGPASSWORD = $Matches[1]
        }
      }
    }
  }
}

$timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$backupDir = Join-Path $PSScriptRoot "..\..\.local\backups"
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
$dumpFile = Join-Path $backupDir "marketsphere_$timestamp.dump"

Write-Host "Creating logical backup at $dumpFile..."
& "$PgBinDir\pg_dump.exe" -h $PgHost -p $PgPort -U $PgUser -Fc $DbName -f $dumpFile
if ($LASTEXITCODE -ne 0) { throw "pg_dump failed with exit code $LASTEXITCODE" }

$verifyDb = "${DbName}_restore_verify"
Write-Host "Restoring into verification DB $verifyDb..."
& "$PgBinDir\psql.exe" -h $PgHost -p $PgPort -U $PgUser -d postgres -c "DROP DATABASE IF EXISTS $verifyDb;" | Out-Null
& "$PgBinDir\psql.exe" -h $PgHost -p $PgPort -U $PgUser -d postgres -c "CREATE DATABASE $verifyDb;" | Out-Null
& "$PgBinDir\pg_restore.exe" -h $PgHost -p $PgPort -U $PgUser -d $verifyDb --no-owner $dumpFile
if ($LASTEXITCODE -ne 0) { throw "pg_restore failed with exit code $LASTEXITCODE" }

$tableCount = & "$PgBinDir\psql.exe" -h $PgHost -p $PgPort -U $PgUser -d $verifyDb -t -A -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public';"
Write-Host "Verified restored table count: $tableCount"
& "$PgBinDir\psql.exe" -h $PgHost -p $PgPort -U $PgUser -d postgres -c "DROP DATABASE IF EXISTS $verifyDb;" | Out-Null
