@echo off
title OrbQuest - Build Windows .EXE
color 0b

echo ========================================================
echo   OrbQuest - Native Windows Desktop Packager
echo   Version: 1.2.26
echo ========================================================
echo.

set "ROOT=%~dp0"
cd /d "%ROOT%"

echo [1/6] Installing frontend and backend dependencies...
call npm ci
if errorlevel 1 exit /b 1
echo.

echo [2/6] Building production bundle (dist/ frontend + dist/server.cjs)...
rem The quest database (src/server/redditCache.json), its update date
rem (src/server/questDatabaseInfo.ts) and the game list (catalog_cache.json)
rem are baked into dist/server.cjs by this step. To update the database from
rem r/DiscordQuests first, run "npm run update-database" before this script.
call npm run build
if errorlevel 1 exit /b 1
if not exist "%ROOT%dist\server.cjs" (
  echo [ERROR] dist\server.cjs was not created in "%ROOT%dist".
  exit /b 1
)
echo         Backend bundle: "%ROOT%dist\server.cjs"
echo.

echo [3/6] Verifying the production bundle (versions, quest database date, offline search)...
rem Starts dist/server.cjs once in production mode: it must boot, report this
rem version, answer a known game from the local database without Reddit and
rem show one catalog card per game. Stops the build before packaging if not.
call npm run verify:dist
if errorlevel 1 (
  echo [ERROR] The production bundle failed verification - not packaging it.
  exit /b 1
)
echo.

echo [4/6] Installing Python packaging dependencies...
python -m pip install --quiet -r requirements-build.txt
if errorlevel 1 exit /b 1
echo.

echo [5/6] Verifying local placeholder runtime...
if exist "%ROOT%placeholder_runtime.exe" (
  echo         Using the committed native placeholder_runtime.exe ^(rebuild it with scripts\build-placeholder.bat^).
) else (
  echo         Building fallback placeholder_runtime.exe...
  python -m PyInstaller --noconfirm --clean --onefile --noconsole --noupx ^
    --exclude-module _socket --exclude-module socket --exclude-module _ssl --exclude-module ssl ^
    --exclude-module ctypes --exclude-module _ctypes --exclude-module hashlib --exclude-module _hashlib ^
    --exclude-module urllib --exclude-module http --exclude-module email --exclude-module xml ^
    --exclude-module unittest --exclude-module pydoc --exclude-module sqlite3 ^
    --exclude-module bz2 --exclude-module _bz2 --exclude-module lzma --exclude-module _lzma ^
    --exclude-module zstd --exclude-module _zstd --exclude-module multiprocessing --exclude-module asyncio ^
    --name placeholder_runtime placeholder_runtime.py
  if errorlevel 1 exit /b 1
  copy /y dist\placeholder_runtime.exe placeholder_runtime.exe >nul
  if errorlevel 1 exit /b 1
)
echo.

echo [6/6] Packaging single standalone executable (OrbQuest.spec)...
rem --- Resolve node.exe: DQR_NODE_EXE (env) -> PATH -> default install ---
set "NODE_EXE="
if defined DQR_NODE_EXE set "NODE_EXE=%DQR_NODE_EXE%"
if not defined NODE_EXE (
  for /f "delims=" %%i in ('where node.exe 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%i"
)
if not defined NODE_EXE (
  if exist "C:\Program Files\nodejs\node.exe" set "NODE_EXE=C:\Program Files\nodejs\node.exe"
)
if not defined NODE_EXE (
  echo [ERROR] node.exe not found. Add it to PATH or set DQR_NODE_EXE environment variable.
  exit /b 1
)
echo         node.exe: %NODE_EXE%
rem Keep the node.exe path quoted inside ( ) blocks: an unquoted path such as
rem C:\Program Files (x86)\nodejs\node.exe would close the block early.
if not exist "%NODE_EXE%" (
  echo [ERROR] Invalid node.exe path: "%NODE_EXE%"
  exit /b 1
)
set "DQR_NODE_EXE=%NODE_EXE%"
if exist build rmdir /s /q build
if exist dist\OrbQuest.exe del /q dist\OrbQuest.exe
python -m PyInstaller --noconfirm --clean OrbQuest.spec
if errorlevel 1 (
  echo [ERROR] Packaging failed.
  exit /b 1
)

echo.
echo ========================================================
echo [SUCCESS] Your standalone OrbQuest.exe is ready!
echo Location: dist\OrbQuest.exe
echo Backend bundle for desktop_app.py: "%ROOT%dist\server.cjs"
echo ========================================================
if not defined CI pause
