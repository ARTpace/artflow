@echo off
setlocal
cd /d "%~dp0"
echo Artflow Tauri Preview - independent desktop trial
echo First compile may download Rust crates and take several minutes.
powershell -NoProfile -Command "if (-not (Get-NetTCPConnection -State Listen -LocalPort 4002 -ErrorAction SilentlyContinue)) { exit 1 }"
if errorlevel 1 start "Artflow Vite" cmd /k "npm run dev"
call npm run tauri:dev
if errorlevel 1 pause
