@echo off
rem ============================================================
rem Multi-MT5 Trade Copier - one-click launcher (portable)
rem 1) Removes the Windows "downloaded file" mark (MotW) from all
rem    files in this folder -> the blue SmartScreen window will
rem    NOT appear for the engine.
rem 2) Starts the engine and opens the dashboard.
rem ============================================================
setlocal
cd /d "%~dp0"
chcp 65001 >nul
title Multi-MT5 Trade Copier Launcher

echo.
echo  [1/2] Removing Windows download-mark (Unblock-File)...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem -LiteralPath '%~dp0' -Recurse -File -ErrorAction SilentlyContinue | Unblock-File"
echo  [2/2] Starting MT5CopierEngine.exe ...
start "" "MT5CopierEngine.exe"
timeout /t 4 >nul
start "" "http://127.0.0.1:8321"
echo.
echo  Dashboard: http://127.0.0.1:8321  (browser opens automatically)
echo  Engine console window stays open = engine is running. Close it to stop.
echo.
pause
