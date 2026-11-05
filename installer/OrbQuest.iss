; Inno Setup script for OrbQuest-Setup-<version>.exe. build_windows_exe.bat
; runs it after PyInstaller has made release\OrbQuest\:
;     ISCC.exe /DAppVersion=1.6.0 installer\OrbQuest.iss
;
; Installs for the current user only (no administrator rights) into
; %LOCALAPPDATA%\Programs\OrbQuest, with a Start menu entry and an entry under
; Installed apps. The library stays in %LOCALAPPDATA%\OrbQuest and is kept on
; uninstall. Run with /RELAUNCH=1 (the in-app update does), it starts OrbQuest
; again when it is done.

#ifndef AppVersion
  #error Pass the version: ISCC.exe /DAppVersion=1.6.0 installer\OrbQuest.iss
#endif

[Setup]
AppId={{CC1493BD-002F-4032-9FB0-FB0B3AE7C49C}
AppName=OrbQuest
AppVersion={#AppVersion}
AppVerName=OrbQuest {#AppVersion}
AppPublisher=OrbQuest
AppPublisherURL=https://github.com/Ravan404/OrbQuest
AppSupportURL=https://github.com/Ravan404/OrbQuest/issues
AppUpdatesURL=https://github.com/Ravan404/OrbQuest/releases
VersionInfoVersion={#AppVersion}
DefaultDirName={localappdata}\Programs\OrbQuest
DisableProgramGroupPage=yes
DisableDirPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\release
OutputBaseFilename=OrbQuest-Setup-{#AppVersion}
SetupIconFile=..\assets\OrbQuest.ico
UninstallDisplayIcon={app}\OrbQuest.exe
UninstallDisplayName=OrbQuest
WizardStyle=modern
Compression=lzma2/max
SolidCompression=yes
; Closes a running OrbQuest before files are replaced.
CloseApplications=force
RestartApplications=no
LicenseFile=..\LICENSE

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[InstallDelete]
; Files of the previous version that the new one no longer has.
Type: filesandordirs; Name: "{app}\_internal"

[Files]
Source: "..\release\OrbQuest\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\OrbQuest"; Filename: "{app}\OrbQuest.exe"
Name: "{autodesktop}\OrbQuest"; Filename: "{app}\OrbQuest.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\OrbQuest.exe"; Description: "{cm:LaunchProgram,OrbQuest}"; Flags: nowait postinstall skipifsilent
Filename: "{app}\OrbQuest.exe"; Flags: nowait; Check: Relaunch

[Code]
function Relaunch: Boolean;
begin
  Result := ExpandConstant('{param:RELAUNCH|0}') = '1';
end;
