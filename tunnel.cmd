@echo off
chcp 65001 >nul
title رابط الموقع العمومي
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tunnel.ps1"
echo.
pause
