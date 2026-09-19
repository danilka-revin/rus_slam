@echo off
rem ============================================================================
rem  start.bat — запуск веб-пульта РУС-SLAM на Windows
rem
rem  Использование (двойной клик или из командной строки):
rem    start.bat                — режим разработки (http://localhost:5173)
rem    start.bat --prod         — прод-сборка и локальный просмотр (порт 4173)
rem    start.bat --port 8080    — другой порт (работает с обоими режимами)
rem ============================================================================
chcp 65001 >nul
cd /d "%~dp0"

set MODE=dev
set PORT=

:parse
if "%~1"=="" goto :run
if /i "%~1"=="--prod"      ( set MODE=prod & shift & goto :parse )
if /i "%~1"=="--production" ( set MODE=prod & shift & goto :parse )
if /i "%~1"=="--build"     ( set MODE=prod & shift & goto :parse )
if /i "%~1"=="--port"      ( set PORT=%~2 & shift & shift & goto :parse )
if /i "%~1"=="-h"          goto :help
if /i "%~1"=="--help"      goto :help
echo Неизвестный аргумент: %~1 (см. start.bat --help)
exit /b 1

:help
echo start.bat — запуск веб-пульта РУС-SLAM на Windows
echo   start.bat                — режим разработки (http://localhost:5173)
echo   start.bat --prod         — прод-сборка и просмотр (порт 4173)
echo   start.bat --port 8080    — другой порт
exit /b 0

:run
rem --- 1. Node.js -----------------------------------------------------------
where node >nul 2>&1
if errorlevel 1 (
  echo [X] Node.js не найден. Установите его:
  echo     winget install OpenJS.NodeJS.LTS
  echo     или скачайте LTS с https://nodejs.org/ и перезапустите терминал.
  exit /b 1
)

rem --- 2. Зависимости -------------------------------------------------------
if not exist node_modules (
  echo =^> Первый запуск: устанавливаю зависимости (npm install)...
  call npm install --no-audit --no-fund
  if errorlevel 1 ( echo [X] npm install завершился с ошибкой & exit /b 1 )
)

rem --- 3. Запуск ------------------------------------------------------------
if "%MODE%"=="prod" goto :prod
if "%PORT%"=="" (
  echo =^> Режим разработки: откройте http://localhost:5173
  call npm run dev
) else (
  echo =^> Режим разработки: откройте http://localhost:%PORT%
  call npm run dev -- --port %PORT%
)
goto :eof

:prod
echo =^> Прод-сборка (typecheck + vite build)...
call npm run build
if errorlevel 1 ( echo [X] Сборка завершилась с ошибкой & exit /b 1 )
if "%PORT%"=="" (
  echo =^> Откройте http://localhost:4173
  call npm run preview
) else (
  echo =^> Откройте http://localhost:%PORT%
  call npm run preview -- --port %PORT%
)
goto :eof
