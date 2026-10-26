@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Install it from https://nodejs.org and run this again. & pause & exit /b 1)
set NEEDINSTALL=0
if not exist node_modules set NEEDINSTALL=1
if not exist node_modules\.package-lock.json set NEEDINSTALL=1
for /f %%i in ('powershell -NoProfile -Command "if ((Get-Item package.json).LastWriteTime -gt (Get-Item node_modules\.package-lock.json -ErrorAction SilentlyContinue).LastWriteTime) {1} else {0}"') do set NEEDINSTALL=%%i
if "%NEEDINSTALL%"=="1" (echo Installing dependencies... & call npm.cmd install || (pause & exit /b 1))
start "" http://localhost:5173
call npm.cmd run dev
