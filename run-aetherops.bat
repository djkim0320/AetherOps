@echo off
setlocal

cd /d "%~dp0"
set SILENT=0
if /i "%~1"=="--silent" set SILENT=1

if not exist ".aetherops" mkdir ".aetherops"
set LOG_FILE=%CD%\.aetherops\launcher.log

echo.
echo ========================================
echo  AetherOps launcher
echo ========================================
echo.
echo [%DATE% %TIME%] Starting AetherOps launcher > "%LOG_FILE%"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js is not installed or not on PATH.
  echo [ERROR] Node.js is not installed or not on PATH. >> "%LOG_FILE%"
  echo Install Node.js 22 or newer, then run this file again.
  call :maybe_pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm is not installed or not on PATH.
  echo [ERROR] npm is not installed or not on PATH. >> "%LOG_FILE%"
  call :maybe_pause
  exit /b 1
)

if not exist "node_modules" (
  echo [1/3] Installing dependencies...
  call npm install >> "%LOG_FILE%" 2>&1
  if errorlevel 1 (
    echo [ERROR] npm install failed.
    echo [ERROR] npm install failed. See %LOG_FILE%
    call :maybe_pause
    exit /b 1
  )
) else (
  echo [1/3] Dependencies already installed.
)

echo [2/3] Building AetherOps...
call npm run build >> "%LOG_FILE%" 2>&1
if errorlevel 1 (
  echo [ERROR] Build failed.
  echo [ERROR] Build failed. See %LOG_FILE%
  call :maybe_pause
  exit /b 1
)

echo [3/3] Starting AetherOps...
set NODE_ENV=production
call npx electron . >> "%LOG_FILE%" 2>&1
set EXIT_CODE=%ERRORLEVEL%

if not "%EXIT_CODE%"=="0" (
  echo.
  echo [ERROR] AetherOps exited with code %EXIT_CODE%.
  echo [ERROR] AetherOps exited with code %EXIT_CODE%. >> "%LOG_FILE%"
  call :maybe_pause
  exit /b %EXIT_CODE%
)

endlocal
exit /b 0

:maybe_pause
if "%SILENT%"=="0" pause
exit /b 0
