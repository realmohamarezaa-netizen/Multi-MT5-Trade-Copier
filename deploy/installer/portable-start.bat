@echo off
rem Portable launcher: starts the engine and opens the dashboard
cd /d "%~dp0"
start "" "MT5CopierEngine.exe"
timeout /t 2 >nul
start "" "http://127.0.0.1:8321"
