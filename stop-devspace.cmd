@echo off
setlocal
echo Stopping DevSpace and Cloudflare Quick Tunnel...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0devspace-control.ps1" stop
set "RESULT=%ERRORLEVEL%"
echo.
if not "%RESULT%"=="0" echo Stop failed. Review the message above.
pause
exit /b %RESULT%
