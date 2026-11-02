import { test } from 'node:test';
import assert from 'node:assert/strict';

const { buildRedditSupplement } = await import('../src/server/reddit/supplement.ts');
const { buildGameDatabase } = await import('../src/server/gameDatabaseSource.ts');

const discordList = [
  {
    id: '700136079562375258',
    name: 'VALORANT',
    aliases: [],
    icon_hash: '11f81959f4fdd76ca6c39c59eac256c1',
    executables: [{ os: 'win32', name: 'win64/valorant-win64-shipping.exe', is_launcher: false }],
  },
  { id: '1442729602559643668', name: 'Firefox', aliases: [], icon_hash: null, executables: [] },
  { id: '1450685090098315376', name: 'Comet', aliases: [], icon_hash: 'bd866e2c67c057ab1c8a8b6a39520052', executables: [] },
];
const discord = buildGameDatabase(discordList, '2026-01-01T00:00:00.000Z');

const entry = (gameName: string, executableName: string) => ({
  gameName,
  executableName,
  folderPath: 'Not found',
  url: 'https://www.reddit.com/r/DiscordQuests/comments/abc123/x/',
  confidence: 'medium' as const,
  source: 'reddit' as const,
});

test('r/DiscordQuests only fills in what Discord gives no executable for', () => {
  const supplement = buildRedditSupplement(
    [
      entry('Firefox', 'firefox.exe'),
      entry('Firefox', 'Mozilla Firefox\\firefox.exe'),
      entry('Comet AI Browser', 'comet.exe'),
      entry('Opera GX', 'opera.exe'),
      entry('VALORANT', 'VALORANT.exe'),
      entry('Some Game', 'VALORANT-Win64-Shipping.exe'),
      entry('Resident evil.exe', 'evil.exe'),
    ],
    discordList,
    discord.games
  );
  const byName = Object.fromEntries(supplement.map((game) => [game.name, game]));
  assert.deepEqual(Object.keys(byName).sort(), ['Comet AI Browser', 'Firefox', 'Opera GX']);

  assert.equal(byName.Firefox.id, '1442729602559643668', "Discord's id for an app it lists without executables");
  assert.deepEqual(byName.Firefox.executables, ['firefox.exe'], 'one entry per program, executables merged');
  assert.equal(byName.Firefox.icon, undefined, 'Discord has no icon for it');
  assert.equal(byName['Comet AI Browser'].id, '1450685090098315376', '"Comet AI Browser" is "Comet" in Discord');
  assert.equal(byName['Comet AI Browser'].icon, 'bd866e2c67c057ab1c8a8b6a39520052');
  assert.equal(byName['Opera GX'].id, 'r-operagx', 'a program Discord does not know gets its own id');
  assert.equal(byName.Firefox.site, 'firefox.com', 'a program without a Discord icon gets its website for one');
  assert.equal(byName['Comet AI Browser'].site, undefined, "Discord's icon is used when there is one");
  for (const game of supplement) {
    assert.equal(game.source, 'reddit');
    assert.match(game.url ?? '', /^https:\/\/www\.reddit\.com\//);
  }
});

test('r/DiscordQuests entries survive the file format and the published download checks', async () => {
  const { toDatabaseGame } = await import('../src/server/gameDatabaseSource.ts');
  const kept = toDatabaseGame({
    id: 'r-operagx',
    name: 'Opera GX',
    source: 'reddit',
    url: 'https://www.reddit.com/r/DiscordQuests/comments/abc123/x/',
    executables: [{ os: 'win32', name: 'opera.exe' }],
  });
  assert.deepEqual(kept, {
    id: 'r-operagx',
    name: 'Opera GX',
    executables: ['opera.exe'],
    source: 'reddit',
    url: 'https://www.reddit.com/r/DiscordQuests/comments/abc123/x/',
  });
  const foreignUrl = toDatabaseGame({ id: 'r-x', name: 'X', source: 'reddit', url: 'https://evil.example/', executables: [{ os: 'win32', name: 'x.exe' }] });
  assert.equal(foreignUrl?.url, undefined, 'only reddit.com links are kept');
  assert.equal(toDatabaseGame({ id: 'r-../x', name: 'X', executables: [{ os: 'win32', name: 'x.exe' }] }), null);
});

test('a Steam-manifest quest keeps its Steam app id, folder and the executable inside it', () => {
  const steamEntry = (gameName: string, executableName: string, folderPath: string, steamAppId: number, manifestContent?: string) => ({
    ...entry(gameName, executableName),
    folderPath,
    questMethod: 'steam-manifest' as const,
    steamAppId,
    ...(manifestContent ? { manifestContent } : {}),
  });
  const [fc27, demo] = buildRedditSupplement(
    [
      entry('EA SPORTS FC 27', 'fc27.exe'),
      steamEntry('EA SPORTS FC 27', 'fc27.exe', 'steamapps/common/EA SPORTS FC 27', 4080220, '"AppState"\n{\n "appid" "4080220"\n "installdir" "EA SPORTS FC 27"\n}'),
      steamEntry('Toxic Commando Demo', 'Toxic Commando.exe', 'SteamLibrary/steamapps/common/Toxic Commando Demo/client_pc/bin', 4354730),
    ],
    discordList,
    discord.games
  );
  assert.deepEqual(fc27.steam, { appId: 4080220, installDir: 'EA SPORTS FC 27' }, 'the post with the Steam setup wins');
  assert.deepEqual(fc27.executables, ['fc27.exe']);
  assert.deepEqual(demo.steam, { appId: 4354730, installDir: 'Toxic Commando Demo' });
  assert.deepEqual(demo.executables, ['client_pc/bin/toxic commando.exe']);
});

test('Steam and website fields are checked when a database is read', async () => {
  const { toDatabaseGame } = await import('../src/server/gameDatabaseSource.ts');
  const base = { id: 'r-x', name: 'X', source: 'reddit', executables: [{ os: 'win32', name: 'x.exe' }] };
  assert.deepEqual(toDatabaseGame({ ...base, steam: { appId: 5, installDir: 'X Game' }, site: 'x.com' })?.steam, { appId: 5, installDir: 'X Game' });
  assert.equal(toDatabaseGame({ ...base, site: 'x.com' })?.site, 'x.com');
  assert.equal(toDatabaseGame({ ...base, steam: { appId: 5, installDir: '../Windows' } })?.steam, undefined);
  assert.equal(toDatabaseGame({ ...base, steam: { appId: -1, installDir: 'X' } })?.steam, undefined);
  assert.equal(toDatabaseGame({ ...base, site: 'https://evil.example/x' })?.site, undefined);
  assert.equal(toDatabaseGame({ ...base, source: undefined, steam: { appId: 5, installDir: 'X' } })?.steam, undefined, "only r/DiscordQuests entries");
});
