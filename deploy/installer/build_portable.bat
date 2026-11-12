@echo off
rem ============================================================
rem Builds the PORTABLE zip (no installation required)
rem Prereqs: 1) worker\build_exe.bat  2) UI exported to worker\ui
rem ============================================================
cd /d "%~dp0"
if not exist "..\worker\dist\MT5CopierEngine\MT5CopierEngine.exe" (
  echo Engine EXE not found. Run ..\worker\build_exe.bat first.
  exit /b 1
)
set OUT=MT5Copier-Portable
rd /s /q "%OUT%" 2>nul
mkdir "%OUT%" >nul
xcopy /e /i /y "..\worker\dist\MT5CopierEngine\*" "%OUT%\" >nul
xcopy /e /i /y "..\docs\FA\*" "%OUT%\docs\" >nul
copy /y "..\mql5\MT5CopierEA.mq5" "%OUT%\MT5CopierEA.mq5" >nul
copy /y "..\README-FA.md" "%OUT%\README-FA.md" >nul
copy /y "portable-start.bat" "%OUT%\start-copier.bat" >nul
powershell -NoProfile -Command "Compress-Archive -Path '%OUT%\*' -DestinationPath 'MT5Copier-Portable.zip' -Force"
echo.
echo PORTABLE OK: %CD%\MT5Copier-Portable.zip
exit /b 0
