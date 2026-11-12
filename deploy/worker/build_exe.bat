@echo off
rem ============================================================
rem Builds the Windows EXE for the central engine (PyInstaller).
rem Requirements: Python 3.11+ x64 and pip install pyinstaller
rem ============================================================
cd /d "%~dp0"
python -m pip install --upgrade pyinstaller || goto :err
python -m PyInstaller --noconfirm --clean copier_engine.spec || goto :err
echo.
echo BUILD OK: dist\MT5CopierEngine.exe  (single file, dashboard embedded)
echo Next: run installer\build_installer.bat or build_portable.bat
exit /b 0
:err
echo BUILD FAILED
exit /b 1
