@echo off
rem ============================================================
rem Multi-MT5 Trade Copier - engine starter (Windows)
rem Starts the central Python engine (no console window).
rem ============================================================
cd /d "%~dp0"
if exist "MT5CopierEngine.exe" (
  start "" "MT5CopierEngine.exe"
  exit /b 0
)
where pythonw >nul 2>nul
if %errorlevel%==0 (
  start "" pythonw copier_engine.py
) else (
  echo Python not found. Install Python 3.11+ or use the packaged EXE.
  pause
)
