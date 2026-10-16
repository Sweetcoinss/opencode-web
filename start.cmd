@echo off
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [!] Node.js غير مثبت. حمّله من https://nodejs.org
  pause
  exit /b 1
)

echo يتم تشغيل خادم opencode-web...
start "" /b cmd /c "ping -n 3 127.0.0.1 >nul & start "" http://127.0.0.1:8790"
node server.mjs
pause
