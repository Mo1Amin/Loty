@echo off
setlocal
rem Runs Loty on this PC and opens it to the internet through ngrok.
rem No hosting and no card needed; the PC has to stay on while you watch.
cd /d "%~dp0"

if not exist node_modules (
  echo Installing packages...
  call npm install || goto :fail
)

rem Your ngrok domain is remembered here, outside git.
if exist .ngrok-domain set /p NGROK_DOMAIN=<.ngrok-domain
if "%NGROK_DOMAIN%"=="" (
  echo.
  echo Your free static domain is on https://dashboard.ngrok.com/domains
  set /p NGROK_DOMAIN=ngrok domain, for example name.ngrok-free.dev: 
)
if "%NGROK_DOMAIN%"=="" goto :fail
> .ngrok-domain echo %NGROK_DOMAIN%

echo Building...
call npm run build || goto :fail

start "Loty server" cmd /k "set PORT=4000&& npm start"
timeout /t 3 /nobreak >nul

echo.
echo Loty: https://%NGROK_DOMAIN%
echo Close this window to stop sharing.
echo.
call npx --yes ngrok http --domain=%NGROK_DOMAIN% 4000
goto :eof

:fail
echo Something went wrong. Scroll up for the error.
pause
