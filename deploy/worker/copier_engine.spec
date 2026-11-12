# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for the Multi-MT5 Trade Copier central engine.
# Build (on Windows):  pyinstaller --noconfirm copier_engine.spec
# Result: dist/MT5CopierEngine/MT5CopierEngine.exe  (onedir - fast startup)

import os

block_cipher = None

a = Analysis(
    ["copier_engine.py"],
    pathex=[os.getcwd()],
    binaries=[],
    datas=[],  # ./ui (dashboard) is copied next to the exe by the installer,
    hiddenimports=[],
    hookspath=[],
    runtime_hooks=[],
    excludes=["tkinter", "matplotlib", "numpy", "pandas"],
    cipher=block_cipher,
)
pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="MT5CopierEngine",
    debug=False,
    strip=False,
    upx=False,
    console=True,  # keep the console: live engine logs are useful on a trade PC
)
coll = COLLECT(exe, a.binaries, a.zipfiles, a.datas, name="MT5CopierEngine")
