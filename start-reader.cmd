@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo 未检测到 Node.js。请先安装 Node.js 18 或更高版本：
  echo https://nodejs.org/
  pause
  exit /b 1
)

set "PORT=8787"
if not "%~1"=="" set "PORT=%~1"

echo.
echo  灯下 · 本地阅读
echo  地址：http://127.0.0.1:%PORT%/reader/
echo  书库：%~dp0book\
echo.
echo  关闭此窗口即可停止服务。
echo.

start "" "http://127.0.0.1:%PORT%/reader/"
node server.mjs --port %PORT%

if errorlevel 1 pause
endlocal
