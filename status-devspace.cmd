@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0devspace-control.ps1" status
set "RESULT=%ERRORLEVEL%"
echo.
pause
exit /b %RESULT%
