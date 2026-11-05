"""Single desktop instance.

A Windows named mutex is held for the entire UI lifetime. The kernel releases
it even after a crash, unlike PID files. The POSIX file lock is for local
source development; it is never part of the Windows distribution.
"""

import ctypes
from ctypes import wintypes
import os
from pathlib import Path
import sys


MUTEX_NAME = r"Local\OrbQuest.SingleInstance"
ERROR_ALREADY_EXISTS = 183


class SingleInstance:
    def __init__(self, lock_path: Path | None = None) -> None:
        self._lock_path = lock_path or Path.home() / ".orbquest.lock"
        self._mutex = None
        self._kernel32 = None
        self._file = None
        self.acquired = False

    def __enter__(self):
        self.acquired = self.acquire()
        return self

    def __exit__(self, _type, _value, _traceback) -> None:
        self.close()

    def acquire(self) -> bool:
        if self._mutex is not None or self._file is not None:
            raise RuntimeError("The instance lock has already been acquired.")

        if sys.platform == "win32":
            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel32.CreateMutexW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR]
            kernel32.CreateMutexW.restype = wintypes.HANDLE
            kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
            kernel32.CloseHandle.restype = wintypes.BOOL

            handle = kernel32.CreateMutexW(None, False, MUTEX_NAME)
            if not handle:
                raise OSError(ctypes.get_last_error(), "Could not create the application mutex")
            if ctypes.get_last_error() == ERROR_ALREADY_EXISTS:
                kernel32.CloseHandle(handle)
                return False
            self._kernel32 = kernel32
            self._mutex = handle
        else:
            import fcntl

            flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
            fd = os.open(self._lock_path, flags, 0o600)
            self._file = os.fdopen(fd, "r+b", buffering=0)
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                self._file.close()
                self._file = None
                return False
            except OSError:
                self._file.close()
                self._file = None
                raise
        self.acquired = True
        return True

    def close(self) -> None:
        if self._mutex is not None:
            self._kernel32.CloseHandle(self._mutex)
            self._mutex = None
            self._kernel32 = None
        if self._file is not None:
            # Closing the descriptor releases flock; never unlink the lock
            # file (a waiting process could otherwise lock a different inode).
            self._file.close()
            self._file = None
        self.acquired = False


def find_window_by_title_prefix(prefix: str):
    """First visible top-level window whose title starts with `prefix`.

    The window title carries the version ("OrbQuest v1.2.26"), so the
    old exact FindWindowW lookup for "OrbQuest" never matched.
    """
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    enum_proc_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    user32.EnumWindows.argtypes = [enum_proc_type, wintypes.LPARAM]
    user32.GetWindowTextLengthW.argtypes = [wintypes.HWND]
    user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    user32.IsWindowVisible.argtypes = [wintypes.HWND]
    found = []

    def callback(hwnd, _lparam):
        if not user32.IsWindowVisible(hwnd):
            return True
        length = user32.GetWindowTextLengthW(hwnd)
        if length <= 0:
            return True
        buffer = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, buffer, length + 1)
        if buffer.value.startswith(prefix):
            found.append(hwnd)
            return False
        return True

    user32.EnumWindows(enum_proc_type(callback), 0)
    return found[0] if found else None


def focus_existing_window(title_prefix: str = "OrbQuest v") -> bool:
    """Bring the already-open desktop window forward when possible."""
    if sys.platform != "win32":
        return False
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    user32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
    user32.SetForegroundWindow.argtypes = [wintypes.HWND]
    window = find_window_by_title_prefix(title_prefix)
    if not window:
        return False
    user32.ShowWindow(window, 9)  # SW_RESTORE (un-minimize)
    return bool(user32.SetForegroundWindow(window))
