#ifndef ChromeExtensionId
  #define ChromeExtensionId ""
#endif
#ifndef EdgeExtensionId
  #define EdgeExtensionId ""
#endif
#ifndef CompanionVersion
  #define CompanionVersion "0.3.0"
#endif

[Setup]
AppId={{AA501108-DA15-45D7-BCDB-29BDF6A662E5}
AppName=Crawlcast Companion
AppVersion={#CompanionVersion}
AppPublisher=Crawlcast
DefaultDirName={localappdata}\Crawlcast Companion
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=dist
OutputBaseFilename=Crawlcast-Companion-{#CompanionVersion}-Windows-x64
Compression=lzma2
SolidCompression=yes
UninstallDisplayName=Crawlcast Companion
WizardStyle=modern

[Files]
Source: "staging\crawlcast_host.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "staging\bin\ffmpeg.exe"; DestDir: "{app}\bin"; Flags: ignoreversion
Source: "staging\bin\ffprobe.exe"; DestDir: "{app}\bin"; Flags: ignoreversion
Source: "staging\com.crawlcast.downloader.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "staging\THIRD-PARTY-NOTICES.txt"; DestDir: "{app}"; Flags: ignoreversion

[Registry]
Root: HKCU; Subkey: "Software\Google\Chrome\NativeMessagingHosts\com.crawlcast.downloader"; ValueType: string; ValueName: ""; ValueData: "{app}\com.crawlcast.downloader.json"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Microsoft\Edge\NativeMessagingHosts\com.crawlcast.downloader"; ValueType: string; ValueName: ""; ValueData: "{app}\com.crawlcast.downloader.json"; Flags: uninsdeletekey

[Code]
function InitializeSetup(): Boolean;
begin
  Result := ('{#ChromeExtensionId}' <> '') or ('{#EdgeExtensionId}' <> '');
  if not Result then
    MsgBox('The installer was built without a Chrome or Edge extension ID.', mbError, MB_OK);
end;

[Run]
Filename: "{cmd}"; Parameters: "/C echo Crawlcast Companion installed. Restart Chrome or Edge before downloading."; Flags: postinstall skipifsilent runhidden
