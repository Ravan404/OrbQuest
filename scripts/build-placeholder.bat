@echo off
rem ---------------------------------------------------------------------------
rem Rebuilds placeholder\placeholder_runtime.exe from its .c and .rc files with MinGW-w64 (gcc + windres on PATH, for example
rem from MSYS2: pacman -S mingw-w64-x86_64-gcc).
rem
rem The program has no C runtime: it starts at wWinMainCRTStartup and links
rem only kernel32, user32 and gdi32. verify-dist checks that the PE stack
rem commit is at least 0x20000, so it is set explicitly here.
rem
rem The build is byte-for-byte reproducible (no link timestamp) with the
rem pinned toolchain: WinLibs GCC 16.2.0 UCRT r3
rem (winlibs-x86_64-posix-seh-gcc-16.2.0-mingw-w64ucrt-14.0.0-r3.zip), the one CI
rem uses. "build-placeholder.bat --check" builds into build\ and only compares
rem the result with the committed placeholder_runtime.exe.
rem
rem After a rebuild, add the SHA-256 of the OLD placeholder_runtime.exe to
rem LEGACY_SHA256_HASHES in src/server/placeholderUpgrade.ts, so placeholders
rem already copied into users' Games folders are upgraded to the new one.
rem ---------------------------------------------------------------------------
setlocal
set "ROOT=%~dp0.."
cd /d "%ROOT%"

where gcc >nul 2>nul || (
  echo [ERROR] gcc not found. Install MinGW-w64 and add its bin folder to PATH.
  exit /b 1
)
where windres >nul 2>nul || (
  echo [ERROR] windres not found. It ships with MinGW-w64 binutils.
  exit /b 1
)

if not exist build mkdir build
windres placeholder\placeholder_runtime.rc -O coff -o build\placeholder_runtime.res.o
if errorlevel 1 exit /b 1

gcc -O2 -municode -mwindows -nostdlib -ffreestanding -fno-builtin ^
  -fno-tree-loop-distribute-patterns -fno-stack-protector ^
  -e wWinMainCRTStartup ^
  -Xlinker --stack -Xlinker 0x100000,0x20000 -Wl,--dynamicbase -Wl,--nxcompat -Wl,--high-entropy-va ^
  -Wl,--no-insert-timestamp ^
  -s -o build\placeholder_runtime.exe ^
  placeholder\placeholder_runtime.c build\placeholder_runtime.res.o ^
  -lkernel32 -luser32 -lgdi32 -lgcc
if errorlevel 1 exit /b 1

for /f %%h in ('powershell -NoProfile -Command "(Get-FileHash placeholder\placeholder_runtime.exe -Algorithm SHA256).Hash.ToLower()"') do set "OLD_HASH=%%h"
for /f %%h in ('powershell -NoProfile -Command "(Get-FileHash build\placeholder_runtime.exe -Algorithm SHA256).Hash.ToLower()"') do set "NEW_HASH=%%h"
if /i "%~1"=="--check" (
  if /i "%OLD_HASH%"=="%NEW_HASH%" (
    echo placeholder_runtime.exe matches its source: %NEW_HASH%
    exit /b 0
  )
  echo [ERROR] placeholder_runtime.exe does not match placeholder_runtime.c.
  echo         committed: %OLD_HASH%
  echo         built:     %NEW_HASH%
  exit /b 1
)
copy /y build\placeholder_runtime.exe placeholder\placeholder_runtime.exe >nul
if errorlevel 1 exit /b 1

echo.
echo Built placeholder_runtime.exe.
echo SHA-256 of the previous build (add it to LEGACY_SHA256_HASHES): %OLD_HASH%
endlocal
