@echo off
title Build OrbQuest
echo Building OrbQuest, Version: 1.6.0
echo.

set "ROOT=%~dp0"
cd /d "%ROOT%"

echo [1/7] Installing frontend and backend dependencies...
call npm ci
if errorlevel 1 exit /b 1
echo.

echo [2/7] Building production bundle (dist/ frontend + dist/server.cjs)...
rem The game database (src/server/gameDatabase.json, Discord's list of
rem detectable games) is baked into dist/server.cjs by this step. To take the
rem newest list from Discord first, run "npm run update-database" before this script.
call npm run build
if errorlevel 1 exit /b 1
if not exist "%ROOT%dist\server.cjs" (
  echo [ERROR] dist\server.cjs was not created in "%ROOT%dist".
  exit /b 1
)
echo         Backend bundle: "%ROOT%dist\server.cjs"
echo.

echo [3/7] Verifying the production bundle (versions, game database, offline search)...
rem Starts dist/server.cjs once in production mode: it must boot, report this
rem version, find a game in the bundled database without the network and write
rem its placeholder where Discord looks. Stops the build before packaging if not.
call npm run verify:dist
if errorlevel 1 (
  echo [ERROR] The production bundle failed verification - not packaging it.
  exit /b 1
)
echo.

echo [4/7] Installing Python packaging dependencies...
python -m pip install --quiet -r requirements-build.txt
if errorlevel 1 exit /b 1
echo.

echo [5/7] Checking the placeholder...
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

echo [6/7] Packaging release\OrbQuest\ and the portable exe (OrbQuest.spec)...
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
for /f "delims=" %%v in ('node -p "require('./package.json').version"') do set "VERSION=%%v"
if exist build rmdir /s /q build
if exist release rmdir /s /q release
python -m PyInstaller --noconfirm --clean --distpath release OrbQuest.spec
if errorlevel 1 (
  echo [ERROR] Packaging failed.
  exit /b 1
)
echo.

echo [7/7] Building the installer (installer\OrbQuest.iss)...
set "ISCC="
for /f "delims=" %%i in ('where ISCC.exe 2^>nul') do if not defined ISCC set "ISCC=%%i"
if not defined ISCC if exist "%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe" set "ISCC=%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe"
if not defined ISCC if exist "%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe" set "ISCC=%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe"
if not defined ISCC (
  echo [WARNING] Inno Setup 6 ^(ISCC.exe^) not found: no installer. Install it from https://jrsoftware.org/isinfo.php
  if defined CI exit /b 1
  goto checksums
)
"%ISCC%" /Q /DAppVersion=%VERSION% installer\OrbQuest.iss
if errorlevel 1 (
  echo [ERROR] The installer could not be built.
  exit /b 1
)

:checksums
rem SHA256SUMS.txt lists every release file; the in-app update checks its download against it.
pushd release
if exist SHA256SUMS.txt del /q SHA256SUMS.txt
for %%f in (OrbQuest-*.exe) do (
  for /f "tokens=*" %%h in ('certutil -hashfile "%%f" SHA256 ^| findstr /v ":"') do echo %%h  %%f>>SHA256SUMS.txt
)
popd

echo.
echo Done:
for %%f in (release\OrbQuest-*.exe) do echo   %%f
echo   release\OrbQuest\  (the installed files)
if not defined CI pause
