; The Windows installer, compiled by package.sh with Inno Setup 6. It installs
; for the current user, so it needs no administrator rights.
; package.sh defines AppVersion, SourceDir, IconFile, OutputDir and
; OutputBaseFilename.

[Setup]
; Windows knows the app by this id across versions; never change it.
AppId={{4D124364-06A0-41FD-8E73-90EBD78BC730}
AppName=Repotted
AppVersion={#AppVersion}
AppPublisher=TheLunchTrae
AppPublisherURL=https://github.com/TheLunchTrae/repotted
DefaultDirName={autopf}\Repotted
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
SetupIconFile={#IconFile}
UninstallDisplayIcon={app}\Repotted.exe
OutputDir={#OutputDir}
OutputBaseFilename={#OutputBaseFilename}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs

[Icons]
Name: "{autoprograms}\Repotted"; Filename: "{app}\Repotted.exe"

[Run]
Filename: "{app}\Repotted.exe"; Description: "Open Repotted"; Flags: nowait postinstall skipifsilent
