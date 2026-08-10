@echo off
REM run-windows.bat — native-Windows launcher for the V1 baseline (ADR-0049).
REM Delegates to run-windows.ps1 (PowerShell). Pass -Connected / -SetupOnly through.
REM Usage:  run-windows.bat            (setup + open the demo studio)
REM         run-windows.bat -Connected (setup + run the connected backend)
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-windows.ps1" %*
endlocal
