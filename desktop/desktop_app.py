"""Native Windows shell for the bundled OrbQuest web application."""

import atexit
import os
from pathlib import Path
import subprocess
import sys
import time
import socket
import shutil
import ctypes
from ctypes import wintypes
import json
import hashlib
import re
import secrets
import threading
from single_instance import SingleInstance, focus_existing_window


PORT = None
SERVER_PROCESS = None
SERVER_SHUTDOWN_TOKEN = None
# Only the window that opened /session with it may use the API (src/server/session.ts).
API_TOKEN = None
SERVER_LOG = None
# Folder that holds Games/ and icon-cache/; set by main().
DATA_ROOT = None
# The checked update to start once the window is closed (apply_update).
UPDATE_TO_RUN = None
WINDOW = None

APP_NAME = "OrbQuest"
APP_VERSION = "1.6.3"
# The window title starts with this; single_instance.focus_existing_window
# looks for it.
WINDOW_TITLE_PREFIX = f"{APP_NAME} v"

# A backend log larger than this is not kept as backend.log.1.
BACKEND_LOG_MAX_BYTES = 1024 * 1024

# Files only OrbQuest writes into its Games folder. A Games folder next to the
# exe without any of them is someone else's and is never moved.
LIBRARY_FILES = (".state.json", ".settings.json", ".special-games.json", ".game-database.json")


def hide_console_window() -> None:
    if sys.platform != "win32":
        return
    try:
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        user32 = ctypes.WinDLL("user32", use_last_error=True)
        kernel32.GetConsoleWindow.restype = wintypes.HWND
        console_window = kernel32.GetConsoleWindow()
        if console_window:
            user32.ShowWindow(console_window, 0)
    except (AttributeError, OSError):
        pass


def application_root() -> Path:
    """The folder of the packaged executable, or the repository when run from source."""
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent.parent


def asset_root() -> Path:
    """Return the directory containing bundled resources."""
    candidates = []
    meipass = getattr(sys, "_MEIPASS", None)
    if meipass:
        candidates.append(Path(meipass))
    candidates.extend(
        [
            application_root(),
            application_root() / "resources",
            application_root() / "_internal",
        ]
    )
    for candidate in candidates:
        if (candidate / "dist" / "server.cjs").is_file():
            return candidate.resolve()
    searched = ", ".join(str(candidate / "dist" / "server.cjs") for candidate in candidates)
    hint = (
        f" The backend bundle is created by 'npm run build' "
        f"and must be in the dist folder of {application_root()}"
    )
    raise FileNotFoundError(f"Bundled application files not found. Searched: {searched}.{hint}")


def resource_path(*parts: str) -> Path:
    return asset_root().joinpath(*parts)


def find_bundled_node() -> Path:
    roots = [asset_root(), application_root()]
    candidates = [
        root / "node" / "node.exe"
        for root in roots
    ] + [
        root / "node.exe"
        for root in roots
    ]
    for candidate in candidates:
        if candidate.is_file():
            return candidate.resolve()
    searched = ", ".join(str(path) for path in candidates)
    raise FileNotFoundError(f"Bundled Node runtime not found. Searched: {searched}")


def find_node_command() -> str:
    if not getattr(sys, "frozen", False):
        node_command = shutil.which("node")
        if node_command:
            return node_command
        raise FileNotFoundError(
            "Node.js not found. Install Node.js to run desktop_app.py "
            "or add node.exe to your PATH."
        )
    return str(find_bundled_node())


def log_directory() -> Path:
    base = Path(os.environ.get("LOCALAPPDATA", application_root()))
    return base / "OrbQuest"


def move_folder(source: Path, target: Path) -> bool:
    """Move a folder, also to another drive. On failure the source is kept."""
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        os.replace(source, target)
        return True
    except OSError:
        pass
    try:
        shutil.copytree(source, target)
    except (OSError, shutil.Error):
        shutil.rmtree(target, ignore_errors=True)
        return False
    shutil.rmtree(source, ignore_errors=True)
    return True


def data_root() -> Path:
    """Where the library (Games/) and the saved icons (icon-cache/) live.

    The packaged app keeps them in %LOCALAPPDATA%\\OrbQuest, next to its logs,
    so the folder the exe was downloaded to stays clean and a newer exe
    downloaded somewhere else finds the same library. Versions before 1.5.0
    kept both folders next to the exe; they are moved on the first start.
    If that fails, this run keeps using them where they are.
    """
    if os.environ.get("ORBQUEST_ROOT"):
        return Path(os.environ["ORBQUEST_ROOT"])
    old_root = application_root()
    if not getattr(sys, "frozen", False):
        return old_root
    new_root = log_directory()
    if new_root.resolve() == old_root.resolve():
        return new_root

    old_games, new_games = old_root / "Games", new_root / "Games"
    if not new_games.exists() and old_games.is_dir() and any((old_games / name).is_file() for name in LIBRARY_FILES):
        if not move_folder(old_games, new_games):
            return old_root
        old_icons, new_icons = old_root / "icon-cache", new_root / "icon-cache"
        if old_icons.is_dir():
            if new_icons.exists() or not move_folder(old_icons, new_icons):
                shutil.rmtree(old_icons, ignore_errors=True)
    return new_root


def install_kind() -> str | None:
    """How this copy runs: "installed" by OrbQuest-Setup (its uninstaller is
    next to the exe), "portable" (the single exe), or None (from source)."""
    if not getattr(sys, "frozen", False):
        return None
    return "installed" if (application_root() / "unins000.exe").is_file() else "portable"


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def checked_pending_update() -> dict | None:
    """The update the server downloaded and checked (src/server/updateInstall.ts),
    checked once more here: the right kind, a file where only an update can be,
    with the SHA-256 the release lists."""
    try:
        pending = json.loads((DATA_ROOT / "update" / "pending.json").read_text("utf-8"))
        kind, file, sha256 = pending.get("kind"), Path(pending.get("file", "")), pending.get("sha256", "")
    except (OSError, ValueError, AttributeError, TypeError):
        return None
    if kind != install_kind() or not file.is_file():
        return None
    if kind == "installed":
        expected_folder = (DATA_ROOT / "update").resolve()
        name_ok = re.fullmatch(r"OrbQuest-Setup-\d+\.\d+\.\d+\.exe", file.name)
    else:
        expected_folder = application_root().resolve()
        name_ok = re.fullmatch(r"OrbQuest-\d+\.\d+\.\d+\.exe", file.name)
    if file.resolve().parent != expected_folder or not name_ok:
        return None
    if not re.fullmatch(r"[0-9a-f]{64}", sha256) or file_sha256(file) != sha256:
        return None
    return {"kind": kind, "file": file.resolve()}


class DesktopApi:
    """What the window may ask of the desktop app (window.pywebview.api)."""

    def apply_update(self) -> dict:
        global UPDATE_TO_RUN
        update = checked_pending_update()
        if update is None:
            return {"ok": False, "error": "The downloaded update could not be checked."}
        UPDATE_TO_RUN = update
        threading.Timer(0.3, lambda: WINDOW.destroy() if WINDOW else None).start()
        return {"ok": True}


def run_pending_update() -> None:
    """Starts the update after OrbQuest has closed and released its lock."""
    if UPDATE_TO_RUN is None:
        return
    flags = getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    file = str(UPDATE_TO_RUN["file"])
    if UPDATE_TO_RUN["kind"] == "installed":
        arguments = [file, "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/RELAUNCH=1"]
    else:
        arguments = [file, "--replace", str(Path(sys.executable).resolve())]
    subprocess.Popen(arguments, creationflags=flags, close_fds=True)


def remove_replaced_exe() -> None:
    """A portable update starts with --replace <old exe>: delete the old exe
    once its process has gone, unless it is this one."""
    if "--replace" not in sys.argv:
        return
    index = sys.argv.index("--replace")
    if index + 1 >= len(sys.argv):
        return
    old = Path(sys.argv[index + 1])
    current = Path(sys.executable).resolve()
    if not getattr(sys, "frozen", False) or old.resolve() == current or old.parent.resolve() != current.parent:
        return
    if not re.fullmatch(r"OrbQuest(-\d+\.\d+\.\d+)?\.exe", old.name):
        return

    def remove() -> None:
        for _ in range(120):
            try:
                old.unlink()
                return
            except FileNotFoundError:
                return
            except OSError:
                time.sleep(0.5)

    threading.Thread(target=remove, daemon=True).start()


def startup_log_path() -> Path:
    return log_directory() / "startup.log"


def backend_log_path() -> Path:
    return log_directory() / "backend.log"


def open_backend_log():
    """Open the file that receives the backend's stdout and stderr.

    The backend used to write stderr into a pipe that nobody read while the
    window was open. Once the pipe buffer was full, Node blocked on its next
    warning and the app stopped answering. A file never fills up that way.
    The previous run's log is kept as backend.log.1.
    """
    path = backend_log_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.is_file():
            if path.stat().st_size > BACKEND_LOG_MAX_BYTES:
                path.unlink()
            else:
                os.replace(path, path.with_name(path.name + ".1"))
        return open(path, "wb")
    except OSError:
        return subprocess.DEVNULL


def close_backend_log() -> None:
    global SERVER_LOG
    if SERVER_LOG is not None and SERVER_LOG is not subprocess.DEVNULL:
        try:
            SERVER_LOG.close()
        except OSError:
            pass
    SERVER_LOG = None


def read_backend_log_tail(max_bytes: int = 4000) -> str:
    """The end of the backend log, for a startup error message."""
    if SERVER_LOG is not None and SERVER_LOG is not subprocess.DEVNULL:
        try:
            SERVER_LOG.flush()
        except (OSError, ValueError):
            pass
    try:
        with open(backend_log_path(), "rb") as handle:
            handle.seek(0, os.SEEK_END)
            handle.seek(max(0, handle.tell() - max_bytes))
            return handle.read().decode("utf-8", errors="replace").strip()
    except OSError:
        return ""


def window_background() -> str:
    """Page colour of the theme the app will show, so the window does not flash
    the other colour while it loads. Follows Games/.settings.json, then the
    Windows app theme."""
    light, dark = "#fafafa", "#0d0d0d"
    try:
        settings = json.loads((DATA_ROOT / "Games" / ".settings.json").read_text("utf-8"))
        if settings.get("theme") in ("light", "dark"):
            return light if settings["theme"] == "light" else dark
    except (OSError, ValueError, AttributeError, TypeError):
        pass
    if sys.platform == "win32":
        try:
            import winreg

            with winreg.OpenKey(
                winreg.HKEY_CURRENT_USER,
                r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize",
            ) as key:
                apps_use_light, _ = winreg.QueryValueEx(key, "AppsUseLightTheme")
                return light if apps_use_light else dark
        except OSError:
            pass
    return light


def choose_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


def local_http_open(request, timeout: float):
    import urllib.request
    # Do not leak the desktop control token to an inherited HTTP_PROXY.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    return opener.open(request, timeout=timeout)


def report_startup_error(error: Exception) -> None:
    message = f"OrbQuest v{APP_VERSION} failed to start:\n\n{error}"
    try:
        log_path = startup_log_path()
        log_path.parent.mkdir(parents=True, exist_ok=True)
        log_path.write_text(message, encoding="utf-8")
    except OSError:
        pass
    try:
        import tkinter as tk
        from tkinter import messagebox
        root = tk.Tk()
        root.withdraw()
        messagebox.showerror("OrbQuest", message)
        root.destroy()
    except Exception:
        # No display: the log file has the error.
        pass


def wait_for_server(timeout: float = 30.0) -> None:
    import urllib.error
    import urllib.request

    deadline = time.monotonic() + timeout
    url = f"http://127.0.0.1:{PORT}/api/internal/ready"
    last_error = None
    while time.monotonic() < deadline:
        try:
            request = urllib.request.Request(url, headers={"X-OrbQuest-Shutdown-Token": SERVER_SHUTDOWN_TOKEN})
            with local_http_open(request, timeout=0.5) as response:
                if json.load(response).get("ok") is not True:
                    raise RuntimeError("The local port is already occupied by another server.")
                return
        except urllib.error.HTTPError as error:
            last_error = error
            if SERVER_PROCESS is not None and SERVER_PROCESS.poll() is not None:
                details = read_backend_log_tail()
                suffix = f"\n{details}" if details else ""
                raise RuntimeError(f"Backend returned HTTP {error.code}.{suffix}") from error
            time.sleep(0.15)
        except (urllib.error.URLError, TimeoutError) as error:
            last_error = error
            if SERVER_PROCESS is not None and SERVER_PROCESS.poll() is not None:
                details = read_backend_log_tail()
                if details:
                    raise RuntimeError(f"Backend process exited:\n{details}") from error
                raise RuntimeError(f"Backend process exited unexpectedly (code {SERVER_PROCESS.returncode}).") from error
            time.sleep(0.15)
    raise RuntimeError(f"Local backend did not start within {timeout:g}s: {last_error}")


def start_backend_server() -> None:
    """Start the bundled backend on loopback."""
    global SERVER_PROCESS, PORT, SERVER_SHUTDOWN_TOKEN, API_TOKEN, SERVER_LOG
    PORT = choose_port()
    SERVER_SHUTDOWN_TOKEN = secrets.token_urlsafe(32)
    API_TOKEN = secrets.token_urlsafe(32)
    bundled_server = resource_path("dist", "server.cjs")
    if not bundled_server.is_file():
        raise FileNotFoundError(f"Backend bundle not found: {bundled_server}")
    node_command = find_node_command()

    environment = os.environ.copy()
    environment.update(
        {
            "NODE_ENV": "production",
            "PORT": str(PORT),
            "ORBQUEST_ROOT": str(DATA_ROOT),
            "ORBQUEST_ASSET_ROOT": str(asset_root()),
            "ORBQUEST_BIND_HOST": "127.0.0.1",
            "ORBQUEST_SHUTDOWN_TOKEN": SERVER_SHUTDOWN_TOKEN,
            "ORBQUEST_API_TOKEN": API_TOKEN,
        }
    )
    kind = install_kind()
    if kind:
        environment["ORBQUEST_INSTALL_KIND"] = kind
        environment["ORBQUEST_APP_EXE"] = str(Path(sys.executable).resolve())
    startup_info = None
    creation_flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    if sys.platform == "win32":
        startup_info = subprocess.STARTUPINFO()
        startup_info.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        startup_info.wShowWindow = subprocess.SW_HIDE

    SERVER_LOG = open_backend_log()
    try:
        SERVER_PROCESS = subprocess.Popen(
            [node_command, str(bundled_server)],
            cwd=str(application_root()),
            env=environment,
            stdout=SERVER_LOG,
            stderr=subprocess.STDOUT,
            startupinfo=startup_info,
            creationflags=creation_flags,
        )
    except FileNotFoundError as e:
        raise FileNotFoundError(f"Failed to start Node.js backend: {e}. Ensure Node.js is installed and accessible.") from e
    except OSError as e:
        raise RuntimeError(f"Failed to launch backend process: {e}") from e

    wait_for_server()


def stop_backend_server() -> None:
    if SERVER_PROCESS is None or SERVER_PROCESS.poll() is not None:
        return
    # Popen.terminate() on Windows uses TerminateProcess: Node's SIGTERM
    # handler never runs and the game processes would outlive the window.
    # First ask the loopback backend to stop all runners and save state.
    if PORT and SERVER_SHUTDOWN_TOKEN:
        import urllib.request
        try:
            request = urllib.request.Request(
                f"http://127.0.0.1:{PORT}/api/internal/shutdown",
                data=b"",
                method="POST",
                headers={"X-OrbQuest-Shutdown-Token": SERVER_SHUTDOWN_TOKEN},
            )
            with local_http_open(request, timeout=2):
                pass
            SERVER_PROCESS.wait(timeout=5)
            return
        except Exception:
            # Unreachable or too slow: fall through to a hard stop.
            pass
    if sys.platform == "win32" and SERVER_PROCESS.pid:
        try:
            subprocess.run(
                ["taskkill", "/pid", str(SERVER_PROCESS.pid), "/t", "/f"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0), timeout=5,
            )
            SERVER_PROCESS.wait(timeout=3)
            return
        except Exception:
            pass
    try:
        SERVER_PROCESS.terminate()
        SERVER_PROCESS.wait(timeout=3)
    except subprocess.TimeoutExpired:
        try:
            SERVER_PROCESS.kill()
            SERVER_PROCESS.wait(timeout=3)
        except Exception:
            pass
    except Exception:
        pass


atexit.register(stop_backend_server)
atexit.register(close_backend_log)


def main() -> None:
    global DATA_ROOT, WINDOW
    # Runs under the instance lock: only one copy moves an old library.
    DATA_ROOT = data_root()
    # An update that was installed (or given up) leaves its download behind.
    shutil.rmtree(DATA_ROOT / "update", ignore_errors=True)
    # Imported after the instance lock is acquired. The second launch must
    # never unpack assets or spawn a second Node backend.
    try:
        import webview
    except ImportError as e:
        raise ImportError(
            "pywebview is not installed. Install it with:\n"
            "  pip install pywebview\n"
            "Or use the packaged executable which includes all dependencies."
        ) from e

    runtime_dir = application_root() / "WebView2Runtime"
    has_fixed_runtime = (runtime_dir / "msedgewebview2.exe").is_file()
    if has_fixed_runtime:
        # pywebview 6 uses the bundled Fixed Version, even on a clean Windows
        # installation without the system-wide WebView2 Evergreen runtime.
        webview.settings["WEBVIEW2_RUNTIME_PATH"] = str(runtime_dir)

    start_backend_server()
    try:
        WINDOW = webview.create_window(
            title=f"{WINDOW_TITLE_PREFIX}{APP_VERSION}",
            url=f"http://127.0.0.1:{PORT}/session?token={API_TOKEN}",
            width=1180,
            height=760,
            min_size=(900, 600),
            background_color=window_background(),
            js_api=DesktopApi(),
        )
        if has_fixed_runtime:
            webview.start(gui="edgechromium", debug=False)
        else:
            webview.start(debug=False)
    except Exception as e:
        stop_backend_server()
        raise RuntimeError(f"Failed to start desktop window: {e}") from e


def run_desktop() -> None:
    hide_console_window()
    remove_replaced_exe()
    try:
        # One mutex for every copy of the app. A crash releases it.
        with SingleInstance() as instance:
            if not instance.acquired:
                if not focus_existing_window(WINDOW_TITLE_PREFIX):
                    try:
                        import tkinter as tk
                        from tkinter import messagebox
                        root = tk.Tk()
                        root.withdraw()
                        messagebox.showinfo("OrbQuest", f"OrbQuest v{APP_VERSION} is already running.")
                        root.destroy()
                    except Exception:
                        pass
                return
            try:
                main()
            finally:
                # Keep the mutex until the Node backend and child game
                # processes have been shut down.
                stop_backend_server()
        # The lock is released: the update may start OrbQuest again.
        run_pending_update()
    except Exception as error:
        report_startup_error(error)


if __name__ == "__main__":
    run_desktop()
