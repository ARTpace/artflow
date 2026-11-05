@echo off
rem ============================================================
rem  Artflow Electron launcher -- DEBUG entry (visible console)
rem  1) Reuses Vite dev server on port 4002, or starts one
rem  2) Launches the Electron desktop window, main-process logs inline
rem
rem  Pair with start-electron.vbs: same launcher, no console at all.
rem  The desktop shortcut ("启动 Artflow.lnk") points at the .VBS, NOT here.
rem  Use this file when you actually want to watch the logs.
rem
rem  NOTE: the port below must match dev-server.config.json (the single source
rem  of truth read by vite.config.ts / main.cjs / launch-desktop.cjs).
rem  Batch cannot parse JSON, so the literal 4002 is duplicated here on purpose.
rem
rem  GPU: enabled by default. Pass --nogpu to fall back to
rem  software rendering (slow dragging, crash-safe mode).
rem ============================================================
setlocal enabledelayedexpansion
cd /d "%~dp0"

rem -- Clean environment (NODE_OPTIONS from other tools can crash Electron) --
set "NODE_OPTIONS="
set "PYTHONPATH="
set "NODE_ENV=development"

rem -- GPU mode: default ON; first arg --nogpu disables it --
set "GPU_FLAGS="
if /i "%~1"=="--nogpu" (
  set "ARTFLOW_DISABLE_GPU=1"
  set "GPU_FLAGS=--no-sandbox --disable-gpu --in-process-gpu"
  echo [Artflow] GPU disabled by flag - software rendering mode.
) else (
  echo [Artflow] GPU hardware acceleration enabled.
)

rem -- Step 1: ensure Vite dev server is serving on port 4002 --
curl -s -o nul -w "%%{http_code}" --max-time 2 http://localhost:4002/ 2>nul | findstr "200" >nul
if errorlevel 1 (
  echo [Artflow] Vite not found on 4002, starting dev server ...
  start "Artflow-Vite" /min cmd /c "npm run dev -- --port 4002 --strictPort"
  set /a tries=0
  :waitloop
  timeout /t 2 /nobreak >nul
  curl -s -o nul -w "%%{http_code}" --max-time 2 http://localhost:4002/ 2>nul | findstr "200" >nul
  if errorlevel 1 (
    set /a tries+=1
    if !tries! LSS 15 goto waitloop
    echo [Artflow] ERROR: Vite did not come up on port 4002 within 30s.
    echo             Check the minimized "Artflow-Vite" window for errors.
    pause
    exit /b 1
  )
)
echo [Artflow] Vite OK on http://localhost:4002

rem -- Step 2: run Electron in THIS console (debug entry: live main-process logs) --
rem   Deliberately NOT `start ... electron.cmd`: that spawns a *second* console with /K
rem   that stays open for the entire session (one console window per launch, forever).
rem   The no-console entry is start-electron.vbs.
echo [Artflow] Launching Electron (live logs below) ...
call "node_modules\.bin\electron.cmd" . %GPU_FLAGS%
echo.
echo [Artflow] Electron exited (code=%ERRORLEVEL%).
pause
endlocal
