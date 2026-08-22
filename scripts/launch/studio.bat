@echo off
REM studio.bat — native-Windows launcher for the V1 baseline (ADR-0049).
REM Delegates to studio.ps1. Pass -Connected / -SetupOnly through.
REM Usage:  scripts\launch\studio.bat            (setup + demo studio)
REM         scripts\launch\studio.bat -Connected (connected backend)
setlocal
for %%I in ("%~dp0..\..") do set "REPO_ROOT=%%~fI"
cd /d "%REPO_ROOT%"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0studio.ps1" %*
endlocal
