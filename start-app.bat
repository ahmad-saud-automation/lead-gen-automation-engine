@echo off
setlocal
cd /d "%~dp0"

set "PY=C:\ClaudeDeps\docpipeline-venv\Scripts\python.exe"
if not exist "%PY%" set "PY=python"

"%PY%" -c "import fastapi, uvicorn" 2>nul || "%PY%" -m pip install fastapi uvicorn
"%PY%" -c "import multipart" 2>nul || "%PY%" -m pip install python-multipart

echo.
echo   Lead Gen Automation Engine - Accountancy Outreach V7
echo   opening http://127.0.0.1:8771
echo   (close this window to stop the app)
echo.

start "" http://127.0.0.1:8771
"%PY%" -m uvicorn webapp.server:app --host 127.0.0.1 --port 8771

endlocal
