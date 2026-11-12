@echo off
rem ============================================================
rem Builds the PORTABLE zip (no installation required)
rem Prereq: worker\build_exe.bat  (ONEFILE engine, UI embedded)
rem ============================================================
cd /d "%~dp0"
if not exist "..\worker\dist\MT5CopierEngine.exe" (
  echo Engine EXE not found. Run ..\worker\build_exe.bat first.
  exit /b 1
)
set OUT=MT5Copier-Portable
rd /s /q "%OUT%" 2>nul
mkdir "%OUT%" >nul
copy /y "..\worker\dist\MT5CopierEngine.exe" "%OUT%\" >nul
copy /y "portable-start.bat" "%OUT%\start-copier.bat" >nul
copy /y "..\mql5\MT5CopierEA.mq5" "%OUT%\" >nul
xcopy /e /i /y "..\docs\FA\*" "%OUT%\docs\" >nul
copy /y "..\INSTALL-FA.md" "%OUT%\" >nul
copy /y "..\README-FA.md" "%OUT%\" >nul
powershell -NoProfile -Command "Compress-Archive -Path '%OUT%\*' -DestinationPath 'MT5Copier-Portable.zip' -Force"
echo.
echo PORTABLE OK: %CD%\MT5Copier-Portable.zip
exit /b 0
