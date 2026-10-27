import { BUFFER_PRESET_DURATIONS, Game } from '../types';
import { escapeBatch, escapeBatchQuoted, escapePowerShell, safeScriptId } from './scriptEscape';

export type ScriptKind = 'bat' | 'ps1' | 'py';

export const SCRIPT_LABELS: Record<ScriptKind, string> = {
  bat: 'Batch (.bat)',
  ps1: 'PowerShell (.ps1)',
  py: 'Python (.py)',
};

export function scriptFileName(game: Pick<Game, 'id'>, kind: ScriptKind): string {
  return `run_${safeScriptId(game.id)}.${kind}`;
}

/**
 * Seconds the real game runs before a script closes it: the same timeline as
 * the placeholder (wait for Discord, the target, the final margin). 0 means
 * the script only starts the game (no limit, or "Stop at the end" is off).
 */
export function scriptRunSeconds(game: Pick<Game, 'targetMinutes' | 'bufferPreset' | 'autoStop'>): number {
  const targetMinutes = game.targetMinutes ?? 15;
  if (targetMinutes <= 0 || game.autoStop === false) return 0;
  const preset = BUFFER_PRESET_DURATIONS[game.bufferPreset ?? 'normal'] || BUFFER_PRESET_DURATIONS.normal;
  return preset.start + targetMinutes * 60 + preset.end;
}

/**
 * Start scripts for running the real game outside the app with the card's
 * timer. Each asks for the game's .exe, starts it, and closes every process of
 * that name once scriptRunSeconds have passed.
 */
export function buildStartScripts(
  game: Pick<Game, 'name' | 'executable' | 'targetMinutes' | 'bufferPreset' | 'autoStop'>
): Record<ScriptKind, string> {
  const seconds = scriptRunSeconds(game);
  const prompt = `Full path to ${game.executable}`;
  const timed = seconds > 0;
  const waitText = `Started. The game is closed in ${seconds} seconds (keep this window open).`;

  const bat = [
    '@echo off',
    `title ${escapeBatch(game.name)}`,
    `set /p "GAME_EXE=${escapeBatchQuoted(prompt)}: "`,
    'if not defined GAME_EXE goto notfound',
    'set "GAME_EXE=%GAME_EXE:"=%"',
    'if not exist "%GAME_EXE%" goto notfound',
    'for %%F in ("%GAME_EXE%") do (set "GAME_DIR=%%~dpF" & set "GAME_IMAGE=%%~nxF")',
    'start "" /d "%GAME_DIR%" "%GAME_EXE%"',
    ...(timed
      ? [
          `echo ${escapeBatch(waitText)}`,
          `powershell -NoProfile -Command "Start-Sleep -Seconds ${seconds}"`,
          'taskkill /im "%GAME_IMAGE%" /t /f >nul 2>&1',
          'echo Time is up. The game was closed.',
        ]
      : ['echo Started.']),
    'pause',
    'exit /b 0',
    ':notfound',
    'echo Executable not found.',
    'pause',
    'exit /b 1',
    '',
  ].join('\r\n');

  const ps1 = [
    "$ErrorActionPreference = 'Stop'",
    `$gameExe = (Read-Host '${escapePowerShell(prompt)}').Trim().Trim('"')`,
    "if (-not $gameExe -or -not (Test-Path -LiteralPath $gameExe -PathType Leaf)) { throw 'Executable not found.' }",
    'Start-Process -FilePath $gameExe -WorkingDirectory (Split-Path -Parent $gameExe)',
    ...(timed
      ? [
          `Write-Host '${escapePowerShell(waitText)}'`,
          `Start-Sleep -Seconds ${seconds}`,
          'Stop-Process -Name ([IO.Path]::GetFileNameWithoutExtension($gameExe)) -Force -ErrorAction SilentlyContinue',
          "Write-Host 'Time is up. The game was closed.'",
        ]
      : ["Write-Host 'Started.'"]),
    "Read-Host 'Press Enter to close'",
    '',
  ].join('\n');

  const py = [
    'import subprocess',
    ...(timed ? ['import time'] : []),
    'from pathlib import Path',
    '',
    `game_exe = Path(input(${JSON.stringify(`${prompt}: `)}).strip().strip('"'))`,
    'if not game_exe.is_file():',
    "    raise SystemExit('Executable not found.')",
    'subprocess.Popen([str(game_exe)], cwd=game_exe.parent)',
    ...(timed
      ? [
          `print(${JSON.stringify(waitText)})`,
          `time.sleep(${seconds})`,
          "subprocess.run(['taskkill', '/im', game_exe.name, '/t', '/f'], capture_output=True)",
          "print('Time is up. The game was closed.')",
        ]
      : ["print('Started.')"]),
    "input('Press Enter to close')",
    '',
  ].join('\n');

  return { bat, ps1, py };
}
