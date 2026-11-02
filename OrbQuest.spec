# -*- mode: python ; coding: utf-8 -*-
# PyInstaller recipe for the Windows packages. build_windows_exe.bat resolves
# node.exe (DQR_NODE_EXE -> PATH -> default install), checks it, exports it as
# DQR_NODE_EXE and then runs:
#     python -m PyInstaller --noconfirm --clean --distpath release OrbQuest.spec
# It makes two packages from one analysis:
#   release\OrbQuest\                the folder the installer (installer\OrbQuest.iss) installs;
#                                    it starts quickly because nothing is unpacked
#   release\OrbQuest-<version>.exe   the portable single file, unpacked to %TEMP% on every start
import json
import os
import shutil

from PyInstaller.utils.win32.versioninfo import (
    FixedFileInfo,
    StringFileInfo,
    StringStruct,
    StringTable,
    VarFileInfo,
    VarStruct,
    VSVersionInfo,
)

_NODE_EXE = os.environ.get('DQR_NODE_EXE') or shutil.which('node.exe') or r'C:\Program Files\nodejs\node.exe'
with open('package.json', encoding='utf-8') as package:
    _VERSION = json.load(package)['version']

# File version shown under Properties > Details.
_NUMBERS = tuple(int(part) for part in _VERSION.split('.')) + (0,)
_VERSION_INFO = VSVersionInfo(
    ffi=FixedFileInfo(filevers=_NUMBERS, prodvers=_NUMBERS),
    kids=[
        StringFileInfo([
            StringTable('040904B0', [
                StringStruct('CompanyName', 'OrbQuest'),
                StringStruct('FileDescription', 'OrbQuest'),
                StringStruct('FileVersion', _VERSION),
                StringStruct('InternalName', 'OrbQuest'),
                StringStruct('LegalCopyright', 'Copyright (c) 2026 OrbQuest. MIT License.'),
                StringStruct('OriginalFilename', 'OrbQuest.exe'),
                StringStruct('ProductName', 'OrbQuest'),
                StringStruct('ProductVersion', _VERSION),
            ])
        ]),
        VarFileInfo([VarStruct('Translation', [1033, 1200])]),
    ],
)

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

_EXE_OPTIONS = dict(
    icon='assets/OrbQuest.ico',
    version=_VERSION_INFO,
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

# Installed package: OrbQuest.exe next to its files.
installed = EXE(pyz, a.scripts, [], exclude_binaries=True, name='OrbQuest', **_EXE_OPTIONS)
COLLECT(installed, a.binaries, a.datas, strip=False, upx=False, name='OrbQuest')

# Portable package: one file.
EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name=f'OrbQuest-{_VERSION}',
    upx_exclude=[],
    runtime_tmpdir=None,
    **_EXE_OPTIONS,
)
