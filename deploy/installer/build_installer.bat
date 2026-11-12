@echo off
rem ============================================================
rem Builds the Windows installer (Inno Setup 6 required)
rem Prereqs: 1) worker\build_exe.bat  2) UI exported to worker\ui
rem ============================================================
cd /d "%~dp0"
if not exist "..\worker\dist\MT5CopierEngine\MT5CopierEngine.exe" (
  echo Engine EXE not found. Run ..\worker\build_exe.bat first.
  exit /b 1
)
set ISCC="%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe"
if not exist %ISCC% set ISCC="%ProgramFiles%\Inno Setup 6\ISCC.exe"
if not exist %ISCC% (
  echo Inno Setup 6 not found. Install from https://jrsoftware.org/isinfo.php
  exit /b 1
)
%ISCC% setup.iss || exit /b 1
echo.
echo INSTALLER OK: Output\MT5Copier-Setup.exe
exit /b 0
