@echo off
rem ============================================================
rem  Multi-MT5 Trade Copier - portable launcher (no install)
rem  1) Removes the Windows "downloaded file" mark (MotW) from all
rem     files in this folder -> the blue SmartScreen window will
rem     NOT appear for the engine.
rem  2) Starts the engine. The engine itself opens the dashboard
rem     in your default browser automatically.
rem ============================================================
setlocal
cd /d "%~dp0"
chcp 65001 >nul
title Multi-MT5 Trade Copier

echo.
echo  [1/2] Removing Windows download-mark (Unblock-File)...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem -LiteralPath '%~dp0' -Recurse -File -ErrorAction SilentlyContinue | Unblock-File"
echo  [2/2] Starting MT5CopierEngine.exe ...
start "" "MT5CopierEngine.exe"
echo.
echo  Dashboard: http://127.0.0.1:8321
echo  The dashboard opens in your browser automatically.
echo  The engine console window stays open = engine is running.
echo  Close the engine window (or press Ctrl+C in it) to stop.
echo.
timeout /t 6 >nul
exit /b 0
