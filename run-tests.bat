@echo off
setlocal
cd /d "%~dp0"
set "PY=C:\ClaudeDeps\docpipeline-venv\Scripts\python.exe"
if not exist "%PY%" set "PY=python"

echo Running engine evals (offline, no keys, no cost)...
echo.
"%PY%" eval_organize.py
"%PY%" eval_emailgen.py
"%PY%" eval_verify.py
"%PY%" eval_cost.py
"%PY%" eval_gateway.py
"%PY%" eval_finders.py
"%PY%" eval_icebreaker.py
"%PY%" eval_instantly.py
"%PY%" eval_sheets.py
"%PY%" eval_schedule.py
"%PY%" eval_ledger.py
"%PY%" eval_retry.py
"%PY%" eval_pipeline.py
echo.
pause
endlocal
