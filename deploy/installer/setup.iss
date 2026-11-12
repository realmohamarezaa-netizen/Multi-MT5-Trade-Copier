; ============================================================
; Multi-MT5 Trade Copier - Inno Setup script (Windows x64)
; Build: run build_installer.bat (requires Inno Setup 6)
; Produces: Output/MT5Copier-Setup.exe
; ============================================================

#define MyAppName "Multi-MT5 Trade Copier"
#define MyAppVersion "1.0.0"
#define MyAppExeName "MT5CopierEngine.exe"

[Setup]
AppId={{8C1B6E9A-52D4-4B7E-9C3F-MT5COPIER100}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
DefaultDirName={autopf}\MT5Copier
DefaultGroupName={#MyAppName}
UninstallDisplayIcon={app}\{#MyAppExeName}
OutputBaseFilename=MT5Copier-Setup
Compression=lzma2
SolidCompression=yes
ArchitecturesInstallIn64BitMode=x64compatible
ArchitecturesAllowed=x64compatible
WizardStyle=modern
PrivilegesRequired=admin
; SetupIconFile=icon.ico
; Remove SetupIconFile line if icon.ico is not provided

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[CustomMessages]
eng.CreateDesktopIcon=Create a &desktop shortcut
eng.FirewallNote=Windows Firewall may ask for permission - the engine only listens on 127.0.0.1 (localhost) and never accesses the internet.

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "Additional icons:"
Name: "autostart"; Description: "Start the engine automatically at Windows login"; GroupDescription: "Additional icons:"; Flags: unchecked

[Files]
; ONEFILE engine: the dashboard UI is embedded inside the EXE; the SQLite DB
; is created in {app}\db at first run (granted user-write permissions below).
Source: "..\worker\dist\MT5CopierEngine.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\mql5\MT5CopierEA.mq5"; DestDir: "{app}\mql5"; Flags: ignoreversion
Source: "..\docs\FA\*"; DestDir: "{app}\docs"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\INSTALL-FA.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\README-FA.md"; DestDir: "{app}"; Flags: ignoreversion

[Dirs]
Name: "{app}\db"; Permissions: users-modify

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "MT5CopierEngine"; ValueData: """{app}\{#MyAppExeName}"""; Flags: uninsdeletevalue; Tasks: autostart

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "Launch {#MyAppName}"; Flags: nowait postinstall skipifsilent

[UninstallRun]
; Nothing else to clean - the engine does not install drivers or services.
