@echo off
rem ---------------------------------------------------------------------------
rem Rebuilds placeholder_runtime.exe from placeholder_runtime.c and
rem placeholder_runtime.rc with MinGW-w64 (gcc + windres on PATH, for example
rem from MSYS2: pacman -S mingw-w64-x86_64-gcc).
rem
rem The program has no C runtime: it starts at wWinMainCRTStartup and links
rem only kernel32, user32 and gdi32. verify-dist checks that the PE stack
rem commit is at least 0x20000, so it is set explicitly here.
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
windres placeholder_runtime.rc -O coff -o build\placeholder_runtime.res.o
if errorlevel 1 exit /b 1

gcc -O2 -municode -mwindows -nostdlib -ffreestanding -fno-builtin ^
  -fno-tree-loop-distribute-patterns -fno-stack-protector ^
  -e wWinMainCRTStartup ^
  -Xlinker --stack -Xlinker 0x100000,0x20000 -Wl,--dynamicbase -Wl,--nxcompat -Wl,--high-entropy-va ^
  -s -o build\placeholder_runtime.exe ^
  placeholder_runtime.c build\placeholder_runtime.res.o ^
  -lkernel32 -luser32 -lgdi32 -lgcc
if errorlevel 1 exit /b 1

for /f "tokens=*" %%h in ('certutil -hashfile placeholder_runtime.exe SHA256 ^| findstr /v ":"') do set "OLD_HASH=%%h"
copy /y build\placeholder_runtime.exe placeholder_runtime.exe >nul
if errorlevel 1 exit /b 1

echo.
echo Built placeholder_runtime.exe.
echo SHA-256 of the previous build (add it to LEGACY_SHA256_HASHES): %OLD_HASH%
endlocal
