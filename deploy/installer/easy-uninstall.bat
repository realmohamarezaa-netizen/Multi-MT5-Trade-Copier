@echo off
rem ============================================================
rem  Multi-MT5 Trade Copier - EASY UNINSTALL
rem  Removes shortcuts, autostart entry and the app folder
rem  (%LOCALAPPDATA%\MT5Copier created by Easy-Install.bat).
rem ============================================================
setlocal EnableExtensions
title MT5 Copier - Easy Uninstall
set "DEST=%LOCALAPPDATA%\MT5Copier"

echo.
echo  ============================================
echo   Multi-MT5 Trade Copier - Easy Uninstall
echo  ============================================
echo.
choice /C YN /N /M "   Remove MT5 Copier completely? [Y/N]: "
if errorlevel 2 (
    echo   Cancelled.
    timeout /t 2 >nul
    exit /b 0
)

echo   [1/4] Stopping the engine...
taskkill /f /im MT5CopierEngine.exe >nul 2>&1

echo   [2/4] Removing autostart entry...
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v MT5CopierEngine /f >nul 2>&1

echo   [3/4] Removing shortcuts (Desktop + Start Menu)...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$d=[Environment]::GetFolderPath('Desktop'); $p=[Environment]::GetFolderPath('Programs'); Remove-Item -LiteralPath ($d+'\MT5 Copier.lnk') -Force -ErrorAction SilentlyContinue; Remove-Item -LiteralPath ($p+'\MT5 Copier') -Recurse -Force -ErrorAction SilentlyContinue"

echo   [4/4] Removing app folder...
cd /d "%TEMP%"
rd /s /q "%DEST%" >nul 2>&1

echo.
echo   MT5 Copier was removed. Goodbye.
timeout /t 3 >nul
exit /b 0
