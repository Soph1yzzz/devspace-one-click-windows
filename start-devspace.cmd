@echo off
setlocal
echo Ensuring DevSpace and Cloudflare quick tunnel are running...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0ensure-devspace.ps1"
set "RESULT=%ERRORLEVEL%"
echo.
if not "%RESULT%"=="0" (
  echo Start failed. Review the message above.
)
echo.
pause
exit /b %RESULT%
