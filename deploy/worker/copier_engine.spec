# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for the Multi-MT5 Trade Copier central engine.
#
# ONEFILE + WINDOWED (desktop app) build: a single self-contained
# MT5CopierEngine.exe that opens a NATIVE desktop window (WebView2/Edge,
# via pywebview) with the Persian dashboard - no browser, no black console.
# While the engine starts, a native splash window with a skeleton loader
# is shown, then the dashboard window replaces it automatically.
#
# Everything is embedded inside the binary:
#   - the dashboard UI (deploy/worker/ui -> Tree "ui")
#   - the splash skeleton (embedded HTML string in copier_engine.py)
#   - the official MetaTrader5 Python API (bridge workers)
#   - pywebview + pythonnet/clr_loader (native window support)
#
# Bridge subprocesses are spawned from the same EXE as
#   MT5CopierEngine.exe --bridge <cfg.json>
# and talk to the engine over loopback TCP (127.0.0.1) because a windowed
# build has no usable stdio handles.
#
# Build (on Windows):  pyinstaller --noconfirm --clean copier_engine.spec
# Result: dist/MT5CopierEngine.exe  (single file)

block_cipher = None

import os  # noqa: E402  (used for pathex below)
from PyInstaller.utils.hooks import collect_all

# Embed the prebuilt dashboard (deploy/worker/ui) inside the EXE.
ui_tree = Tree("ui", prefix="ui")

datas = []
binaries = []
hiddenimports = []

# The real bridge workers need the official MetaQuotes package.
for pkg in ("MetaTrader5",):
    pdatas, pbinaries, phidden = collect_all(pkg)
    datas += pdatas
    binaries += pbinaries
    hiddenimports += phidden

# Native desktop window (pywebview uses Edge WebView2 on Windows 10/11,
# which ships with the OS; pythonnet/clr_loader drive the WinForms layer).
for pkg in ("webview", "clr_loader", "pythonnet"):
    pdatas, pbinaries, phidden = collect_all(pkg)
    datas += pdatas
    binaries += pbinaries
    hiddenimports += phidden

# MetaTrader5's C extension links against the numpy C API at load time;
# without numpy bundled the bridge subprocess would crash on import.
for pkg in ("numpy",):
    pdatas, pbinaries, phidden = collect_all(pkg)
    datas += pdatas
    binaries += pbinaries
    hiddenimports += phidden

a = Analysis(
    ["copier_engine.py"],
    pathex=[os.getcwd()],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=["tkinter", "matplotlib", "pandas"],
    cipher=block_cipher,
)
pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas + ui_tree,
    name="MT5CopierEngine",
    debug=False,
    strip=False,
    upx=False,
    console=False,  # WINDOWED: the EXE itself is the desktop app (no console)
    exclude_binaries=False,  # ONEFILE: pack everything into the EXE
    icon="icon.ico",           # app icon (embedded resource)
    version="version_info.txt" # Windows file Properties -> Details metadata
)
