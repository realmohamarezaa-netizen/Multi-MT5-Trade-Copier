@echo off
rem ============================================================
rem  Multi-MT5 Trade Copier - EASY INSTALL (no admin needed)
rem  - Installs to %LOCALAPPDATA%\MT5Copier (NOT Program Files)
rem  - Creates Desktop + Start Menu shortcuts
rem  - Starts the engine; the dashboard opens in your browser
rem  Requirements: nothing (no admin, no Python, no internet)
rem ============================================================
setlocal EnableExtensions
cd /d "%~dp0"
title MT5 Copier - Easy Install

set "SRC=%~dp0"
set "DEST=%LOCALAPPDATA%\MT5Copier"

echo.
echo  ============================================
echo   Multi-MT5 Trade Copier - Easy Install
echo  ============================================
echo   Install folder: %DEST%
echo.

if not exist "%SRC%MT5CopierEngine.exe" (
    echo   [ERROR] MT5CopierEngine.exe was not found next to this file.
    echo           Extract the WHOLE ZIP first, then run Easy-Install.bat
    echo.
    pause
    exit /b 1
)

rem Stop a running engine so the files are not locked
taskkill /f /im MT5CopierEngine.exe >nul 2>&1

echo   [1/4] Copying files...
robocopy . "%DEST%" /E /NFL /NDL /NJH /NJS /NP >nul
if errorlevel 8 (
    echo   [ERROR] Copy failed. Close all MT5 Copier windows and retry.
    pause
    exit /b 1
)

echo   [2/4] Removing Windows download-mark (so no SmartScreen popup)...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem -LiteralPath '%DEST%' -Recurse -File -ErrorAction SilentlyContinue | Unblock-File"

echo   [3/4] Creating shortcuts (Desktop + Start Menu)...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$d=[Environment]::GetFolderPath('Desktop'); $p=[Environment]::GetFolderPath('Programs'); $ws=New-Object -ComObject WScript.Shell; $s=$ws.CreateShortcut(($d+'\MT5 Copier.lnk')); $s.TargetPath='%DEST%\MT5CopierEngine.exe'; $s.WorkingDirectory='%DEST%'; $s.IconLocation='%DEST%\MT5CopierEngine.exe,0'; $s.Description='Multi-MT5 Trade Copier'; $s.Save(); $f=$p+'\MT5 Copier'; New-Item -ItemType Directory -Force -Path $f | Out-Null; $s2=$ws.CreateShortcut(($f+'\MT5 Copier.lnk')); $s2.TargetPath='%DEST%\MT5CopierEngine.exe'; $s2.WorkingDirectory='%DEST%'; $s2.IconLocation='%DEST%\MT5CopierEngine.exe,0'; $s2.Save(); $u=$ws.CreateShortcut(($f+'\Uninstall MT5 Copier.lnk')); $u.TargetPath='%DEST%\Easy-Uninstall.bat'; $u.WorkingDirectory='%DEST%'; $u.Save()"

echo.
echo   [4/4] Start MT5 Copier automatically at Windows login?
choice /C YN /N /M "   Press Y for yes, N for no: "
if errorlevel 2 goto :skipautostart
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v MT5CopierEngine /t REG_SZ /d "\"%DEST%\MT5CopierEngine.exe\"" /f >nul
echo   Autostart: ON
:skipautostart

echo.
echo   Starting MT5 Copier...
start "" "%DEST%\MT5CopierEngine.exe"
echo.
echo  ============================================
echo   DONE! The dashboard opens in your browser:
echo     http://127.0.0.1:8321
echo   Shortcuts created: Desktop + Start Menu
echo   Uninstall later: Easy-Uninstall.bat
echo  ============================================
echo.
timeout /t 5 >nul
exit /b 0
