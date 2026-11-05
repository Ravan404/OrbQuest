"""Placeholder window for development on Linux and macOS.

The Windows build uses placeholder_runtime.exe (placeholder_runtime.c); this
shows the same game name and timer. The server stops the process when the
timer ends.
"""

import os
from pathlib import Path
import sys
import time


def read_number(name: str, default: float = 0) -> float:
    """A numeric environment variable, or `default` when it is missing or not a number."""
    try:
        raw = os.environ.get(name, default)
        value = float(raw)
        if value != value:  # NaN check
            return default
        return max(0, value) if value < float('inf') else default
    except (ValueError, TypeError):
        return default


def timer_state(seconds: int, target: int, start: int, end: int, resume: int = 0):
    """Compute displayed timer and status message.

    Args:
        seconds: Seconds since process started (monotonic)
        target: Target quest duration in seconds
        start: Detection allowance before timer starts
        end: Final safety margin after target
        resume: Previously elapsed seconds (for resume)

    Returns:
        Tuple of (displayed_seconds, status_message)
    """
    # Resuming: base is max(start, previous_elapsed) plus the time since start
    if resume:
        elapsed = max(start, resume) + max(0, seconds - start)
    else:
        elapsed = seconds

    active = max(0, elapsed - start)
    shown = min(active, target) if target else active

    if seconds < start:
        status = f"Starting · {start - seconds}s"
    elif target and elapsed >= start + target + end:
        status = "Done"
    elif target and active >= target:
        remaining = start + target + end - elapsed
        status = f"Finishing · {max(0, remaining)}s"
    else:
        status = "Running"
    return shown, status


def main() -> None:
    try:
        import tkinter as tk
    except ImportError as e:
        # Without tkinter, sleep so the server can still track the process
        print(f"Tkinter not available, running headless placeholder: {e}", file=sys.stderr)
        try:
            # Runs until the server stops it
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            return

    exe_path = Path(sys.executable if getattr(sys, 'frozen', False) else sys.argv[0])
    name = os.environ.get('ORBQUEST_GAME_NAME', '').strip()
    if not name:
        try:
            name_file = exe_path.parent / '.game-name.txt'
            if name_file.is_file():
                name = name_file.read_text(encoding='utf-8').strip()
        except OSError:
            pass
    name = name or exe_path.stem or "Game"

    target = int(read_number('ORBQUEST_TARGET_SECONDS', 900))
    start = int(read_number('ORBQUEST_BUFFER_START', 5))
    end = int(read_number('ORBQUEST_BUFFER_END', 10))
    resume = int(read_number('ORBQUEST_RESUME_SECONDS', 0))

    # Count from the launch time, then use the monotonic clock
    launch = read_number('ORBQUEST_LAUNCHED_AT', time.time() * 1000) / 1000
    time_since_launch = max(0, time.time() - launch)
    started = time.monotonic() - time_since_launch

    try:
        root = tk.Tk()
    except Exception as e:
        print(f"Failed to create Tk window, running headless: {e}", file=sys.stderr)
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            return

    # Black and white like the app; ORBQUEST_THEME comes from the app's settings.
    if os.environ.get('ORBQUEST_THEME') == 'dark':
        bg, fg, faint = '#0d0d0d', '#f0f0f0', '#6e6e6e'
    else:
        bg, fg, faint = '#fafafa', '#111111', '#8c8c8c'

    root.title(name)
    root.geometry('460x230')
    root.configure(bg=bg)
    root.resizable(False, False)

    try:
        frame = tk.Frame(root, bg=bg)
        frame.pack(fill='both', expand=True, padx=28, pady=20)
        tk.Label(frame, text=name, fg=fg, bg=bg, anchor='w', font=('Segoe UI', 14, 'bold')).pack(fill='x')
        tk.Label(frame, text=exe_path.name, fg=faint, bg=bg, anchor='w', font=('Consolas', 9)).pack(fill='x')
        timer = tk.Label(frame, fg=fg, bg=bg, anchor='w', font=('Segoe UI', 28, 'bold'))
        timer.pack(fill='x', pady=(18, 0))
        status = tk.Label(frame, fg=faint, bg=bg, anchor='w', font=('Segoe UI', 11))
        status.pack(fill='x')
    except Exception:
        # The window can still run without its labels
        timer = tk.Label(root, text="00:00", fg=fg, bg=bg, font=('Segoe UI', 28))
        timer.pack(pady=20)
        status = tk.Label(root, text="", fg=faint, bg=bg, font=('Segoe UI', 11))
        status.pack()

    def update_timer() -> None:
        try:
            elapsed = int(time.monotonic() - started)
            shown, message = timer_state(elapsed, target, start, end, resume)
            timer.config(text=f'{shown // 60:02d}:{shown % 60:02d}')
            status.config(text=message)
        except Exception:
            # The next tick tries again
            pass
        # The server stops the process, including the final margin
        try:
            root.after(200, update_timer)
        except Exception:
            pass

    update_timer()
    try:
        root.mainloop()
    except KeyboardInterrupt:
        pass
    except Exception as e:
        print(f"Placeholder window error: {e}", file=sys.stderr)


if __name__ == '__main__':
    main()
