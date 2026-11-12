# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for the Multi-MT5 Trade Copier central engine.
#
# ONEFILE build: a single self-contained MT5CopierEngine.exe with the
# dashboard UI embedded inside the binary (extracted to _MEIPASS at runtime).
# Nothing else is needed next to the EXE except itself:
#   - the SQLite DB is created in  db\  next to the EXE (writable location)
#   - the dashboard is served from the embedded  ui\  payload
#
# Build (on Windows):  pyinstaller --noconfirm --clean copier_engine.spec
# Result: dist/MT5CopierEngine.exe  (single file)

block_cipher = None

# Embed the prebuilt dashboard (deploy/worker/ui) inside the EXE.
ui_tree = Tree("ui", prefix="ui")

a = Analysis(
    ["copier_engine.py"],
    pathex=[os.getcwd()],
    binaries=[],
    datas=[],
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
    a.binaries,
    a.zipfiles,
    a.datas + ui_tree,
    name="MT5CopierEngine",
    debug=False,
    strip=False,
    upx=False,
    console=True,  # keep the console: live engine logs are useful on a trade PC
    exclude_binaries=False,  # ONEFILE: pack everything into the EXE
    icon=None,
)
