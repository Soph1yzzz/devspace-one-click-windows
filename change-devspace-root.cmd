@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0change-devspace-root.ps1"
set "RESULT=%ERRORLEVEL%"
echo.
if not "%RESULT%"=="0" echo The operation failed. Review the message above.
pause
exit /b %RESULT%
