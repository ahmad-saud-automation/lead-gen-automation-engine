@echo off
setlocal
cd /d "%~dp0ui"

REM ---------------------------------------------------------------------------
REM Builds the V2 interface into ..\webapp\dist, which the app serves.
REM
REM node_modules is ~82 MB and this whole folder syncs to Google Drive, so it must
REM NOT live here. `npm install` DELETES a junction and rebuilds a real folder every
REM time, so the order is always: install first, then move it out and re-link.
REM
REM ⚠️ The target folder MUST itself be called "node_modules". Node follows the junction
REM to the real path and then walks UP looking for a folder named node_modules, so a
REM target named "leadgen-node_modules" breaks every import with ERR_MODULE_NOT_FOUND.
REM Hence C:\ClaudeDeps\leadgen-ui\node_modules, not C:\ClaudeDeps\leadgen-node_modules.
REM ---------------------------------------------------------------------------

where npm >nul 2>&1
if errorlevel 1 (
  echo.
  echo   npm was not found. Install Node.js 18+ from https://nodejs.org and run this again.
  echo   The app still works without it - open http://127.0.0.1:8771/legacy
  echo.
  exit /b 1
)

echo Installing UI dependencies...
call npm install --no-fund --no-audit
if errorlevel 1 (
  echo   npm install failed.
  exit /b 1
)

echo Moving node_modules out of the synced folder...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$src=Join-Path $PWD 'node_modules'; $dst='C:\ClaudeDeps\leadgen-ui\node_modules';" ^
  "$i=Get-Item $src -Force -ErrorAction SilentlyContinue;" ^
  "if ($i -and -not $i.LinkType) {" ^
  "  if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }" ^
  "  New-Item -ItemType Directory -Force -Path (Split-Path $dst) | Out-Null;" ^
  "  Move-Item $src $dst;" ^
  "  New-Item -ItemType Junction -Path $src -Target $dst | Out-Null;" ^
  "  Write-Host '  moved to' $dst 'and linked back'" ^
  "} else { Write-Host '  already a junction - nothing to move' }"

echo Building...
call npm run build
if errorlevel 1 (
  echo   Build failed.
  exit /b 1
)

echo.
echo   Built into webapp\dist
echo.
exit /b 0
