@echo off
setlocal

cd /d "%~dp0"
set SILENT=0
if /i "%~1"=="--silent" set SILENT=1

if not exist ".aetherops" mkdir ".aetherops"
set LOG_FILE=%CD%\.aetherops\launcher.log
set AETHEROPS_DATA_DIR=%CD%\.aetherops
set AETHEROPS_HOST=127.0.0.1
set AETHEROPS_PORT=5179

echo.
echo ========================================
echo  AetherOps web launcher
echo ========================================
echo.
echo [%DATE% %TIME%] Starting AetherOps web launcher > "%LOG_FILE%"
echo [INFO] Storage root: %AETHEROPS_DATA_DIR% >> "%LOG_FILE%"

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
    echo [ERROR] npm install failed. See %LOG_FILE%
    call :maybe_pause
    exit /b 1
  )
) else (
  echo [1/3] Dependencies already installed.
)

echo [2/3] Building AetherOps web app...
call npm run build >> "%LOG_FILE%" 2>&1
if errorlevel 1 (
  echo [ERROR] Build failed. See %LOG_FILE%
  call :maybe_pause
  exit /b 1
)

echo [3/3] Starting AetherOps web app...
echo [INFO] Open http://127.0.0.1:5179 in your browser. >> "%LOG_FILE%"
start "" "http://127.0.0.1:5179"
call npm run start >> "%LOG_FILE%" 2>&1
set EXIT_CODE=%ERRORLEVEL%

if not "%EXIT_CODE%"=="0" (
  echo.
  echo [ERROR] AetherOps exited with code %EXIT_CODE%. See %LOG_FILE%
  call :maybe_pause
  exit /b %EXIT_CODE%
)

endlocal
exit /b 0

:maybe_pause
if "%SILENT%"=="0" pause
exit /b 0
