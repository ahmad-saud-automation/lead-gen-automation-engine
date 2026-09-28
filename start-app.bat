@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

REM ---------------------------------------------------------------------------
REM Find a Python that actually RUNS.
REM `if exist` is not a test: a venv built on a different Windows profile leaves
REM Scripts\python.exe in place, but starting it fails with "No Python at ..."
REM because it points at an interpreter under the other profile. Launch it and
REM see, rather than trusting the file to be there.
REM ---------------------------------------------------------------------------
set "PY="
call :try "C:\ClaudeDeps\leadgen-venv\Scripts\python.exe"
call :try "C:\ClaudeDeps\docpipeline-venv\Scripts\python.exe"
call :try "python"
call :try "py"

if not defined PY (
  echo.
  echo   Could not find a working Python. Install Python 3.11+ and run this again.
  echo.
  pause
  exit /b 1
)

"%PY%" -c "import fastapi, uvicorn" 2>nul || "%PY%" -m pip install fastapi uvicorn
"%PY%" -c "import multipart" 2>nul || "%PY%" -m pip install python-multipart

REM Build the V2 interface once. If npm is missing this is skipped and the app still
REM starts - /legacy always works, and / explains how to build.
if not exist "webapp\dist\index.html" (
  echo Interface not built yet - building it once...
  call "%~dp0build-ui.bat"
)

echo.
echo   Lead Gen Automation Engine
echo   Python: %PY%
echo   opening http://127.0.0.1:8771
echo   (close this window to stop the app)
echo.

start "" http://127.0.0.1:8771
"%PY%" -m uvicorn webapp.server:app --host 127.0.0.1 --port 8771

exit /b 0

:try
if defined PY goto :eof
%~1 -c "import sys" >nul 2>&1
if errorlevel 1 goto :eof
set "PY=%~1"
goto :eof
