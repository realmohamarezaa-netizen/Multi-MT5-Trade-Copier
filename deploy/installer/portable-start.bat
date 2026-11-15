@echo off
rem ============================================================
rem  Multi-MT5 Trade Copier - portable launcher (no install)
rem  1) Removes the Windows "downloaded file" mark (MotW) from all
rem     files in this folder -> the blue SmartScreen window will
rem     NOT appear for the app.
rem  2) Starts the DESKTOP APP: a native window with a loading
rem     skeleton opens, then the dashboard appears in the same app
rem     window. No browser, no console window.
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
echo  The MT5 Copier desktop window opens by itself:
echo  first a loading screen (skeleton), then the dashboard.
echo  Closing the app window stops the copier.
echo.
timeout /t 6 >nul
exit /b 0
