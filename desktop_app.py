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
import secrets
from single_instance import SingleInstance, focus_existing_window


PORT = None
SERVER_PROCESS = None
SERVER_SHUTDOWN_TOKEN = None
SERVER_LOG = None

# Application metadata
APP_NAME = "OrbQuest"
APP_VERSION = "1.3.0"
# The window title starts with this; single_instance.focus_existing_window
# looks for it.
WINDOW_TITLE_PREFIX = f"{APP_NAME} v"

# A backend log larger than this is not kept as backend.log.1.
BACKEND_LOG_MAX_BYTES = 1024 * 1024


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
    """Return the writable folder beside the script or packaged executable."""
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


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
        f" The backend bundle is created by build_windows_exe.bat (or 'npm run build') "
        f"and must be in the same folder as desktop_app.py: {application_root()}"
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
        settings = json.loads((application_root() / "Games" / ".settings.json").read_text("utf-8"))
        if settings.get("theme") in ("light", "dark"):
            return light if settings["theme"] == "light" else dark
    except (OSError, ValueError, AttributeError):
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
        # Errors must still be logged on a headless/developer machine.
        pass


def wait_for_server(timeout: float = 30.0) -> None:
    import urllib.error
    import urllib.request

    deadline = time.monotonic() + timeout
    url = f"http://127.0.0.1:{PORT}/api/internal/ready"
    last_error = None
    while time.monotonic() < deadline:
        try:
            request = urllib.request.Request(url, headers={"X-DQR-Shutdown-Token": SERVER_SHUTDOWN_TOKEN})
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
    global SERVER_PROCESS, PORT, SERVER_SHUTDOWN_TOKEN, SERVER_LOG
    PORT = choose_port()
    SERVER_SHUTDOWN_TOKEN = secrets.token_urlsafe(32)
    bundled_server = resource_path("dist", "server.cjs")
    if not bundled_server.is_file():
        raise FileNotFoundError(f"Backend bundle not found: {bundled_server}")
    node_command = find_node_command()

    environment = os.environ.copy()
    environment.update(
        {
            "NODE_ENV": "production",
            "PORT": str(PORT),
            "DQR_ROOT": str(application_root()),
            "DQR_ASSET_ROOT": str(asset_root()),
            "DQR_BIND_HOST": "127.0.0.1",
            "DQR_SHUTDOWN_TOKEN": SERVER_SHUTDOWN_TOKEN,
        }
    )
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
                headers={"X-DQR-Shutdown-Token": SERVER_SHUTDOWN_TOKEN},
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
        webview.create_window(
            title=f"{WINDOW_TITLE_PREFIX}{APP_VERSION}",
            url=f"http://127.0.0.1:{PORT}",
            width=1180,
            height=760,
            min_size=(900, 600),
            background_color=window_background(),
        )
        if has_fixed_runtime:
            webview.start(gui="edgechromium", debug=False)
        else:
            webview.start(debug=False)
    except Exception as e:
        # Ensure backend is stopped if webview fails to start
        stop_backend_server()
        raise RuntimeError(f"Failed to start desktop window: {e}") from e


def run_desktop() -> None:
    hide_console_window()
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
    except Exception as error:
        report_startup_error(error)


if __name__ == "__main__":
    run_desktop()
