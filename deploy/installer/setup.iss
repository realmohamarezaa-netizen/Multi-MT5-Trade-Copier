; ============================================================
; Multi-MT5 Trade Copier - Inno Setup script (Windows x64)
; Build: run build_installer.bat (requires Inno Setup 6)
; Produces: Output/MT5Copier-Setup.exe
; ============================================================

#define MyAppName "Multi-MT5 Trade Copier"
#define MyAppVersion "2.2.0"
#define MyAppExeName "MT5CopierEngine.exe"

[Setup]
AppId={{8C1B6E9A-52D4-4B7E-9C3F-MT5COPIER100}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher=Multi-MT5 Trade Copier Project
AppCopyright=MIT License
DefaultDirName={autopf}\MT5Copier
DefaultGroupName={#MyAppName}
UninstallDisplayIcon={app}\{#MyAppExeName}
SetupLogging=yes
OutputBaseFilename=MT5Copier-Setup
Compression=lzma2
SolidCompression=yes
ArchitecturesInstallIn64BitMode=x64compatible
ArchitecturesAllowed=x64compatible
WizardStyle=modern
PrivilegesRequired=admin
SetupIconFile=icon.ico
; Gracefully close a running engine during install/uninstall (Restart Manager)
CloseApplications=yes
RestartApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "Additional icons:"

[Files]
; ONEFILE engine: the dashboard UI is embedded inside the EXE; the SQLite DB
; is created in {app}\db at first run (granted user-write permissions below).
Source: "..\worker\dist\MT5CopierEngine.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\docs\FA\*"; DestDir: "{app}\docs"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\INSTALL-FA.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\README-FA.md"; DestDir: "{app}"; Flags: ignoreversion

[Dirs]
Name: "{app}\db"; Permissions: users-modify

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
; The engine opens its native desktop window by itself (splash skeleton,
; then the dashboard) - no browser needed.
Filename: "{app}\{#MyAppExeName}"; Description: "Launch {#MyAppName}"; Flags: nowait postinstall skipifsilent
; v2.1.0: autostart was removed - clean up the Run value written by v2.0.x
Filename: "{sys}\reg.exe"; Parameters: "DELETE HKCU\Software\Microsoft\Windows\CurrentVersion\Run /v MT5CopierEngine /f"; Flags: runhidden

[UninstallRun]
; Force-stop the console engine before file deletion (exit 0 = never blocks).
Filename: "{sys}\cmd.exe"; Parameters: "/C taskkill /f /im MT5CopierEngine.exe & exit /b 0"; Flags: runhidden; RunOnceId: "KillEngine"
