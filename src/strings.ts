/** Every piece of text the window shows. English only. */

const strings = {
  appTitle: 'OrbQuest',
  loading: 'Starting…',
  serverUnreachable: 'The local server is not answering.',
  retry: 'Try again',

  // Navigation and top bar
  navLibrary: 'Library',
  navCatalog: 'Catalog',
  navAbout: 'About',
  addGame: 'Add game',
  rescan: 'Rescan',
  rescanTitle: 'Look for new or removed game folders',
  soundOn: 'Sounds on',
  soundOff: 'Sounds off',
  themeSystem: 'Theme: follow Windows',
  themeLight: 'Theme: light',
  themeDark: 'Theme: dark',

  // Status bar
  nothingSelected: 'No game selected',
  runningCount: '{n} running',
  stopAll: 'Stop all',

  // Game states
  idle: 'Idle',
  running: 'Running',
  waiting: 'Starting · {n}s',
  finishing: 'Finishing · {n}s',
  done: 'Done',

  // Library
  search: 'Search',
  filterAll: 'All',
  filterRunning: 'Running',
  filterCustom: 'Custom',
  select: 'Select',
  doneSelecting: 'Done',
  selectAll: 'Select all',
  selectNone: 'Select none',
  selectGame: 'Select {name}',
  markedCount: '{n} selected',
  stopMarked: 'Stop',
  removeMarked: 'Remove',
  confirmRemoveMarked: 'Remove {n}?',
  libraryEmpty: 'Your library is empty',
  libraryEmptyHint: 'Pick a game from the catalog, or add one by its .exe name.',
  browseCatalog: 'Browse catalog',
  noMatch: 'Nothing matches "{query}"',
  filterEmpty: 'No games here right now.',
  tagCustom: 'Custom',

  // Game card
  launch: 'Launch',
  stop: 'Stop',
  timer: 'Timer',
  timerLocked: 'Stop the game to change the timer',
  script: 'Start script',
  edit: 'Edit',
  editLockedRunning: 'Stop the game to edit it',
  editLockedCatalog: 'Catalog games keep their name and file',
  remove: 'Remove',
  confirmRemove: 'Remove?',
  yes: 'Yes',
  cancel: 'Cancel',
  reset: 'Reset',
  resetTitle: 'Set the time back to 00:00',

  // Timer menu
  duration: 'Duration',
  noLimit: 'No limit',
  minutesShort: '{n}m',
  custom: 'Custom',
  minutes: 'min',
  set: 'Set',
  detection: 'Wait for Discord',
  detectionHelp: 'Seconds before the count starts, then 10 s extra at the end.',
  presetFast: 'Fast',
  presetNormal: 'Normal',
  presetLong: 'Long',
  presetOff: 'Off',
  presetSeconds: '{start}s + {end}s',
  stopAtEnd: 'Stop at the end',

  // Catalog
  catalogSearch: 'Search games',
  catalogFeatured: 'Games with Discord quests',
  catalogFeaturedHint: 'Search finds any of the {n} games Discord can detect.',
  catalogResults: '{n} games',
  catalogResultOne: '1 game',
  catalogNoMatch: 'Discord\'s game list has nothing called "{query}".',
  catalogAddCustom: 'Add it by its .exe name',
  executable: 'Executable',
  inLibrary: 'In library',
  add: 'Add',
  adding: 'Adding…',
  addFailed: 'Could not add the game.',

  // Add / edit dialog
  dialogAdd: 'Add game',
  dialogEdit: 'Edit game',
  fieldName: 'Name',
  fieldNamePlaceholder: 'Roblox',
  fieldExe: 'File name',
  fieldExePlaceholder: 'RobloxPlayerBeta.exe',
  fieldFolder: 'Folder',
  fieldFolderPlaceholder: 'Same as the name',
  fieldFolderLocked: 'Steam installs keep their folder and file.',
  fieldTimer: 'Timer',
  save: 'Save',
  saving: 'Saving…',
  addToLibrary: 'Add',

  // Script dialog
  scriptTitle: 'Start script',
  scriptHelp: "Asks for the real game's .exe and starts it. With Stop at the end on, it closes the game when the same timer is up.",
  copy: 'Copy',
  copied: 'Copied',
  copyFailed: 'Copy failed. Select the text and copy it.',
  download: 'Download',
  downloaded: 'Saved',

  // Notices
  noticeError: 'Something went wrong',
  noticeStarted: 'Started',
  noticeStartedText: '{name} is running.',
  noticeStopped: 'Stopped',
  noticeStoppedText: '{name} stopped.',
  noticeStoppedAll: '{n} games stopped.',
  noticeTimer: 'Timer',
  noticeTimerText: '{n} minutes.',
  noticeTimerNoLimit: 'No time limit.',
  noticeReset: 'Reset',
  noticeResetText: '{name} is back at 00:00.',
  noticeAdded: 'Added',
  noticeAddedText: '{name} is in your library.',
  noticeSaved: 'Saved',
  noticeSavedText: '{name} was updated.',
  noticeRemoved: 'Removed',
  noticeRemovedText: '{name} was removed.',
  noticeRemovedMany: '{n} games were removed.',
  noticeSteamKept: 'The Steam files were left in place.',
  noticePartial: '{done} of {total} worked. The rest failed.',
  noticeRescanned: 'Library',
  noticeRescannedText: 'Folders checked.',
  noticeFinished: 'Timer finished',
  noticeFinishedStopped: '{name} ran {mins} minutes and was stopped.',
  noticeFinishedRunning: '{name} ran {mins} minutes and is still open.',
  updateFailed: 'Could not save the change.',

  // About
  aboutTitle: 'About OrbQuest',
  aboutIntro:
    "Discord quests ask you to play a game for a while. OrbQuest lets that happen without the game: it puts a small stand-in program under the game's .exe name in a folder of its own, starts it, and closes it when your time is up. Discord sees a program with the right name and treats it as the game.",
  aboutSafe:
    "It never logs in to Discord, never reads your token and doesn't change the Discord app. All it does is start and stop that one program on your PC.",
  aboutLimitsTitle: "What it can't see",
  aboutLimits:
    "Whether the quest actually counted. When a timer finishes here, it only means the stand-in ran that long. Check the quest in Discord itself. Discord also only notices games while it's open, so keep it running during a timer.",
  aboutTimerTitle: 'How the timer runs',
  aboutTimer:
    'Discord needs a moment to notice a new game, so the count starts after a short wait: {fast}, {normal} or {long} seconds for Fast, Normal and Long, none for Off. Once the target is reached the stand-in keeps running for another {end} seconds so the last minute isn\'t cut short, then it stops. Untick "Stop at the end" if you want it to stay open.',
  aboutAddTitle: 'Getting games in',
  aboutAdd:
    "The catalog is Discord's own list of games it can detect, so the stand-in gets exactly the name and folder Discord looks for (for VALORANT that is win64\\valorant-win64-shipping.exe). The list is updated every six hours. A game Discord does not list yet can still be added by hand with Add game.",
  aboutScript:
    "If you'd rather run the real game, the start script button on a card saves a .bat, .ps1 or .py that starts it and closes it when the same timer is up.",
  aboutFilesTitle: 'Where things are',
  aboutFiles:
    "Everything sits in the Games folder next to the app. Each game has its own folder. Games\\.state.json keeps the times and timer settings, Games\\.settings.json keeps sound and theme. Closing the app stops any running timer and remembers where it was.",
  aboutLog:
    "If the app won't start, %LOCALAPPDATA%\\OrbQuest\\startup.log says why. Server messages go to backend.log next to it.",
  aboutRemoveTitle: 'Removing a game',
  aboutRemove:
    "Remove deletes the game's folder under Games. A real Steam install is never deleted; it only comes off the list.",
  aboutFacts: 'On this PC',
  aboutVersion: 'Version',
  aboutDbGames: 'Games in the database',
  aboutDbUpdated: 'Database updated',
  aboutGamesFolder: 'Games folder',
} as const;

export type StringKey = keyof typeof strings;
export type Translate = (key: StringKey, vars?: Record<string, string | number>) => string;

/** Looks up a string and fills `{name}` style placeholders. */
export const t: Translate = (key, vars) => {
  const template: string = strings[key];
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));
};
