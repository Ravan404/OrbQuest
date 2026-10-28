# -*- mode: python ; coding: utf-8 -*-
# Single source of truth for the desktop package.
# build_windows_exe.bat resolves node.exe (DQR_NODE_EXE -> PATH -> default
# install), validates it, exports it as DQR_NODE_EXE and then runs this spec:
#     python -m PyInstaller --noconfirm --clean OrbQuest.spec
# The Node.js runtime location below is therefore resolved at build time;
# the C:\ path is only a last-resort fallback for manual runs.
import os
import shutil

_NODE_EXE = os.environ.get('DQR_NODE_EXE') or shutil.which('node.exe') or r'C:\Program Files\nodejs\node.exe'


a = Analysis(
    ['desktop_app.py'],
    pathex=[],
    binaries=[(_NODE_EXE, 'node')],
    datas=[('dist', 'dist'), ('placeholder_runtime.exe', '.')],
    hiddenimports=[],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=['unittest', 'pydoc', 'sqlite3', 'bz2', 'lzma', 'xmlrpc', 'multiprocessing'],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='OrbQuest',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
