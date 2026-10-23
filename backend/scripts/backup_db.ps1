# ============================================================
#  Backup de la base de datos de Tukán (PostgreSQL de Railway)
# ------------------------------------------------------------
#  Hace una copia completa (.sql) de la base en la carpeta
#  backups\ con la fecha y hora en el nombre.
#
#  REQUISITO: tener pg_dump instalado (viene con PostgreSQL).
#    Descarga: https://www.postgresql.org/download/windows/
#    (solo necesitas las "Command Line Tools").
#
#  USO (desde la carpeta backend):
#    powershell -ExecutionPolicy Bypass -File scripts\backup_db.ps1
#
#  Lee DATABASE_URL del archivo .env automaticamente.
# ============================================================

$ErrorActionPreference = "Stop"

# --- Ubicar carpetas ---
$backendDir = Split-Path -Parent $PSScriptRoot
$envFile    = Join-Path $backendDir ".env"
$backupsDir = Join-Path $backendDir "backups"

if (-not (Test-Path $envFile)) {
    Write-Host "ERROR: no encuentro el archivo .env en $backendDir" -ForegroundColor Red
    exit 1
}

# --- Leer DATABASE_URL del .env ---
$dbUrl = $null
foreach ($line in Get-Content $envFile) {
    if ($line -match '^\s*DATABASE_URL\s*=\s*(.+)\s*$') {
        $dbUrl = $matches[1].Trim().Trim('"').Trim("'")
    }
}
if (-not $dbUrl) {
    Write-Host "ERROR: no encontre DATABASE_URL en .env" -ForegroundColor Red
    exit 1
}
if ($dbUrl -match '^(localhost|sqlite|.*\.db)') {
    Write-Host "La DATABASE_URL apunta a algo local, no a Railway. No hago backup." -ForegroundColor Yellow
    exit 1
}

# --- Comprobar pg_dump ---
$pgDump = Get-Command pg_dump -ErrorAction SilentlyContinue
if (-not $pgDump) {
    Write-Host "ERROR: no encuentro pg_dump. Instala las Command Line Tools de PostgreSQL" -ForegroundColor Red
    Write-Host "       https://www.postgresql.org/download/windows/" -ForegroundColor Yellow
    exit 1
}

# --- Carpeta de backups ---
if (-not (Test-Path $backupsDir)) { New-Item -ItemType Directory -Path $backupsDir | Out-Null }

$stamp = Get-Date -Format "yyyy-MM-dd_HH-mm"
$outFile = Join-Path $backupsDir "tukan_$stamp.sql"

Write-Host "Respaldando la base en:" -ForegroundColor Cyan
Write-Host "  $outFile"
Write-Host "Esto puede tardar un momento..." -ForegroundColor Cyan

# pg_dump acepta la URL completa como argumento
& pg_dump --no-owner --no-privileges --dbname=$dbUrl --file=$outFile

if ($LASTEXITCODE -eq 0 -and (Test-Path $outFile)) {
    $kb = [math]::Round((Get-Item $outFile).Length / 1KB, 1)
    Write-Host "LISTO. Backup creado ($kb KB)." -ForegroundColor Green
    # Opcional: borrar backups viejos (deja los ultimos 30)
    Get-ChildItem $backupsDir -Filter "tukan_*.sql" |
        Sort-Object LastWriteTime -Descending |
        Select-Object -Skip 30 |
        ForEach-Object { Remove-Item $_.FullName -Force; Write-Host "  (borrado viejo: $($_.Name))" -ForegroundColor DarkGray }
} else {
    Write-Host "ERROR: el backup fallo (codigo $LASTEXITCODE)." -ForegroundColor Red
    exit 1
}
