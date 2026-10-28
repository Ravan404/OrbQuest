/**
 * placeholder_runtime.c
 *
 * Clean native Win32 GUI timer window for OrbQuest.
 *
 * Mirrors the exact timing and visual layout of placeholder_runtime.py while
 * replacing the 12.4 MB PyInstaller --onefile archive (which bundled unused
 * _socket.pyd, _ssl.pyd, libcrypto-3.dll, ctypes, and unpacked DLLs to %TEMP%,
 * triggering heuristic/ML antivirus false positives such as Bearfoos.A!ml).
 *
 * Links only against standard Windows GUI/system DLLs (kernel32.dll,
 * user32.dll, gdi32.dll) with zero network, crypto, registry, memory-protection
 * (VirtualProtect/VirtualAlloc), dynamic-loader (LoadLibrary/GetProcAddress),
 * or child-process APIs.
 */

#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#define WIN32_LEAN_AND_MEAN

#include <windows.h>

#define WINDOW_WIDTH  460
#define WINDOW_HEIGHT 230
#define TIMER_ID      1
#define TIMER_MS      200

/*
 * Black and white, like the app (src/index.css). Dark when DQR_THEME says
 * so, or when it is unset/"system" and Windows apps are set to dark.
 */
typedef struct {
    COLORREF bg, text, muted, faint, track, run, wait;
} Palette;

static const Palette PALETTE_LIGHT = {
    RGB(0xFA, 0xFA, 0xFA), RGB(0x11, 0x11, 0x11), RGB(0x5C, 0x5C, 0x5C), RGB(0x8C, 0x8C, 0x8C),
    RGB(0xE3, 0xE3, 0xE3), RGB(0x15, 0x80, 0x3D), RGB(0x1D, 0x4E, 0xD8),
};
static const Palette PALETTE_DARK = {
    RGB(0x0D, 0x0D, 0x0D), RGB(0xF0, 0xF0, 0xF0), RGB(0xA6, 0xA6, 0xA6), RGB(0x6E, 0x6E, 0x6E),
    RGB(0x26, 0x26, 0x26), RGB(0x4A, 0xDE, 0x80), RGB(0x7A, 0xA7, 0xFF),
};
static const Palette *g_pal = &PALETTE_LIGHT;

enum { PHASE_WAITING, PHASE_RUNNING, PHASE_FINISHING, PHASE_DONE };

/* Keep all working buffers in static storage so stack frames stay tiny (< 128 B) */
static wchar_t g_game_name[256];
static wchar_t g_exe_name[256];
static wchar_t g_running_as[300];
static wchar_t g_module_path[MAX_PATH];
static wchar_t g_dir_path[MAX_PATH];
static wchar_t g_name_file[MAX_PATH];
static wchar_t g_env_buf[256];
static char    g_file_raw[1024];

static LONGLONG  g_target_seconds     = 900;
static LONGLONG  g_buffer_start       = 5;
static LONGLONG  g_buffer_end         = 10;
static LONGLONG  g_resume_seconds     = 0;
static LONGLONG  g_initial_offset_sec = 0;
static ULONGLONG g_start_tick_ms      = 0;

static HBRUSH g_bg_brush    = NULL;
static HFONT  g_font_title  = NULL;
static HFONT  g_font_sub    = NULL;
static HFONT  g_font_timer  = NULL;
static HFONT  g_font_status = NULL;
static HFONT  g_font_small  = NULL;
static HICON  g_icon_big    = NULL;
static HICON  g_icon_small  = NULL;

/* Retain a relocated pointer so the PE image always includes a standard .reloc section for ASLR */
__attribute__((used))
static const wchar_t *g_window_class_ptr = L"OrbQuestPlaceholderWindow";

static size_t wlen(const wchar_t *s) {
    size_t n = 0;
    if (!s) return 0;
    while (s[n] != L'\0') n++;
    return n;
}

static void wcopy(wchar_t *dst, size_t cap, const wchar_t *src) {
    if (!dst || cap == 0) return;
    size_t i = 0;
    if (src) {
        while (i + 1 < cap && src[i] != L'\0') {
            dst[i] = src[i];
            i++;
        }
    }
    dst[i] = L'\0';
}

static void wappend(wchar_t *dst, size_t cap, const wchar_t *src) {
    if (!dst || cap == 0 || !src) return;
    size_t dlen = wlen(dst);
    if (dlen + 1 >= cap) return;
    wcopy(dst + dlen, cap - dlen, src);
}

static int is_wspace(wchar_t c) {
    return c == L' ' || c == L'\t' || c == L'\r' || c == L'\n';
}

static void trim_wide(wchar_t *s) {
    if (!s) return;
    size_t len = wlen(s);
    while (len > 0 && is_wspace(s[len - 1])) {
        s[--len] = L'\0';
    }
    size_t start = 0;
    while (is_wspace(s[start])) {
        start++;
    }
    if (start > 0) {
        size_t i = 0;
        while (s[start + i] != L'\0') {
            s[i] = s[start + i];
            i++;
        }
        s[i] = L'\0';
    }
}

static LONGLONG parse_int64_prefix(const wchar_t *s, int *ok) {
    *ok = 0;
    if (!s) return 0;
    while (is_wspace(*s)) s++;
    int neg = 0;
    if (*s == L'-') {
        neg = 1;
        s++;
    } else if (*s == L'+') {
        s++;
    }
    if (*s < L'0' || *s > L'9') {
        return 0;
    }
    *ok = 1;
    LONGLONG val = 0;
    while (*s >= L'0' && *s <= L'9') {
        val = (val * 10) + (LONGLONG)(*s - L'0');
        s++;
    }
    return neg ? -val : val;
}

static LONGLONG current_unix_epoch_ms(void) {
    FILETIME ft;
    ULARGE_INTEGER uli;
    GetSystemTimeAsFileTime(&ft);
    uli.LowPart  = ft.dwLowDateTime;
    uli.HighPart = ft.dwHighDateTime;
    /* Convert 100-ns intervals since 1601-01-01 to milliseconds since 1970-01-01 */
    if (uli.QuadPart <= 116444736000000000ULL) return 0;
    return (LONGLONG)((uli.QuadPart - 116444736000000000ULL) / 10000ULL);
}

static LONGLONG env_int(const wchar_t *name, LONGLONG fallback, LONGLONG minimum) {
    DWORD len = GetEnvironmentVariableW(name, g_env_buf, 64);
    if (len == 0 || len >= 64) {
        return fallback < minimum ? minimum : fallback;
    }
    int ok = 0;
    LONGLONG val = parse_int64_prefix(g_env_buf, &ok);
    if (!ok) {
        return fallback < minimum ? minimum : fallback;
    }
    return val < minimum ? minimum : val;
}

static int read_utf8_file_trimmed(const wchar_t *path, wchar_t *out, size_t out_cap) {
    HANDLE hFile = CreateFileW(
        path,
        GENERIC_READ,
        FILE_SHARE_READ | FILE_SHARE_WRITE,
        NULL,
        OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL,
        NULL
    );
    if (hFile == INVALID_HANDLE_VALUE) {
        return 0;
    }
    DWORD bytesRead = 0;
    BOOL ok = ReadFile(hFile, g_file_raw, (DWORD)(sizeof(g_file_raw) - 1), &bytesRead, NULL);
    CloseHandle(hFile);
    if (!ok || bytesRead == 0) {
        return 0;
    }
    g_file_raw[bytesRead] = '\0';
    const char *src = g_file_raw;
    if (bytesRead >= 3 &&
        (unsigned char)g_file_raw[0] == 0xEF &&
        (unsigned char)g_file_raw[1] == 0xBB &&
        (unsigned char)g_file_raw[2] == 0xBF) {
        src += 3;
    }
    int converted = MultiByteToWideChar(CP_UTF8, 0, src, -1, out, (int)out_cap);
    if (converted <= 0) {
        return 0;
    }
    out[out_cap - 1] = L'\0';
    trim_wide(out);
    return out[0] != L'\0';
}

static void resolve_game_and_exe_names(void) {
    DWORD len = GetModuleFileNameW(NULL, g_module_path, MAX_PATH);
    if (len == 0 || len >= MAX_PATH) {
        wcopy(g_module_path, MAX_PATH, L"placeholder_runtime.exe");
    }

    wcopy(g_dir_path, MAX_PATH, g_module_path);

    int last_sep_idx = -1;
    for (int i = 0; g_dir_path[i] != L'\0'; i++) {
        if (g_dir_path[i] == L'\\' || g_dir_path[i] == L'/') {
            last_sep_idx = i;
        }
    }

    if (last_sep_idx >= 0) {
        wcopy(g_exe_name, 256, g_dir_path + last_sep_idx + 1);
        g_dir_path[last_sep_idx + 1] = L'\0';
    } else {
        wcopy(g_exe_name, 256, g_module_path);
        g_dir_path[0] = L'\0';
    }

    wcopy(g_running_as, 300, g_exe_name);

    /* 1. Check DQR_GAME_NAME environment variable */
    DWORD env_len = GetEnvironmentVariableW(L"DQR_GAME_NAME", g_env_buf, 256);
    if (env_len > 0 && env_len < 256) {
        trim_wide(g_env_buf);
        if (g_env_buf[0] != L'\0') {
            wcopy(g_game_name, 256, g_env_buf);
            return;
        }
    }

    /* 2. Check .game-name.txt in the executable directory */
    if (g_dir_path[0] != L'\0') {
        wcopy(g_name_file, MAX_PATH, g_dir_path);
        wappend(g_name_file, MAX_PATH, L".game-name.txt");
        if (read_utf8_file_trimmed(g_name_file, g_game_name, 256)) {
            return;
        }
    }

    /* 3. Fallback to executable stem with underscores/hyphens replaced by spaces */
    wcopy(g_game_name, 256, g_exe_name);
    int last_dot = -1;
    for (int i = 0; g_game_name[i] != L'\0'; i++) {
        if (g_game_name[i] == L'.') last_dot = i;
    }
    if (last_dot > 0) {
        g_game_name[last_dot] = L'\0';
    }
    for (int i = 0; g_game_name[i] != L'\0'; i++) {
        if (g_game_name[i] == L'_' || g_game_name[i] == L'-') {
            g_game_name[i] = L' ';
        }
    }
    trim_wide(g_game_name);
    if (g_game_name[0] == L'\0') {
        wcopy(g_game_name, 256, L"Game");
    }
}

static void write_int_str(LONGLONG val, wchar_t *out) {
    if (val <= 0) {
        out[0] = L'0';
        out[1] = L's';
        out[2] = L'\0';
        return;
    }
    wchar_t rev[24];
    int n = 0;
    while (val > 0 && n < 20) {
        rev[n++] = (wchar_t)(L'0' + (val % 10));
        val /= 10;
    }
    int i = 0;
    while (n > 0) {
        out[i++] = rev[--n];
    }
    out[i++] = L's';
    out[i]   = L'\0';
}

/**
 * Exact C port of placeholder_runtime.py's timer_state(seconds, target, start, end, resume).
 */
static void compute_timer_state(LONGLONG *out_shown, int *out_phase, LONGLONG *out_countdown) {
    ULONGLONG now_ms = GetTickCount64();
    LONGLONG seconds = g_initial_offset_sec;
    if (now_ms > g_start_tick_ms) {
        seconds += (LONGLONG)((now_ms - g_start_tick_ms) / 1000ULL);
    }
    if (seconds < 0) seconds = 0;

    LONGLONG start  = g_buffer_start;
    LONGLONG target = g_target_seconds;
    LONGLONG end    = g_buffer_end;
    LONGLONG resume = g_resume_seconds;

    LONGLONG elapsed;
    if (resume > 0) {
        LONGLONG base = (start > resume) ? start : resume;
        LONGLONG beyond = (seconds > start) ? (seconds - start) : 0;
        elapsed = base + beyond;
    } else {
        elapsed = seconds;
    }

    LONGLONG active = (elapsed > start) ? (elapsed - start) : 0;
    LONGLONG shown  = (target > 0 && active > target) ? target : active;
    *out_shown = shown;

    *out_countdown = 0;
    if (seconds < start) {
        *out_phase = PHASE_WAITING;
        *out_countdown = start - seconds;
    } else if (target > 0 && elapsed >= start + target + end) {
        *out_phase = PHASE_DONE;
    } else if (target > 0 && active >= target) {
        LONGLONG remaining = start + target + end - elapsed;
        *out_phase = PHASE_FINISHING;
        *out_countdown = remaining < 0 ? 0 : remaining;
    } else {
        *out_phase = PHASE_RUNNING;
    }
}

static void write_two_digits(wchar_t *dst, LONGLONG val) {
    if (val < 0) val = 0;
    if (val > 99) val = val % 100;
    dst[0] = (wchar_t)(L'0' + (val / 10));
    dst[1] = (wchar_t)(L'0' + (val % 10));
}

static void format_mm_ss(LONGLONG seconds, wchar_t *out) {
    if (seconds < 0) seconds = 0;
    LONGLONG minutes = seconds / 60;
    LONGLONG rem     = seconds % 60;
    if (minutes >= 100) {
        LONGLONG hundreds = (minutes / 100) % 10;
        out[0] = (wchar_t)(L'0' + hundreds);
        write_two_digits(out + 1, minutes % 100);
        out[3] = L':';
        write_two_digits(out + 4, rem);
        out[6] = L'\0';
    } else {
        write_two_digits(out, minutes);
        out[2] = L':';
        write_two_digits(out + 3, rem);
        out[5] = L'\0';
    }
}

static HFONT create_ui_font(int pt_size, int weight, const wchar_t *face) {
    HDC screen = GetDC(NULL);
    int dpi_y = screen ? GetDeviceCaps(screen, LOGPIXELSY) : 96;
    if (screen) ReleaseDC(NULL, screen);
    int height = -MulDiv(pt_size, dpi_y, 72);
    return CreateFontW(
        height, 0, 0, 0, weight,
        FALSE, FALSE, FALSE,
        DEFAULT_CHARSET,
        OUT_DEFAULT_PRECIS,
        CLIP_DEFAULT_PRECIS,
        CLEARTYPE_QUALITY,
        DEFAULT_PITCH | FF_SWISS,
        face
    );
}

static int wequal(const wchar_t *a, const wchar_t *b) {
    while (*a && *a == *b) { a++; b++; }
    return *a == *b;
}

typedef LONG (WINAPI *RegGetValueW_fn)(HKEY, LPCWSTR, LPCWSTR, DWORD, LPDWORD, PVOID, LPDWORD);
typedef HRESULT (WINAPI *DwmSetWindowAttribute_fn)(HWND, DWORD, LPCVOID, DWORD);

/* advapi32 and dwmapi are loaded at run time so the link line stays kernel32/user32/gdi32. */
static BOOL windows_apps_use_dark(void) {
    BOOL dark = FALSE;
    HMODULE advapi = LoadLibraryW(L"advapi32.dll");
    if (!advapi) return FALSE;
    RegGetValueW_fn get = (RegGetValueW_fn)(void *)GetProcAddress(advapi, "RegGetValueW");
    DWORD value = 1;
    DWORD size = sizeof(value);
    if (get && get(HKEY_CURRENT_USER, L"Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize",
                   L"AppsUseLightTheme", 0x00000010 /* RRF_RT_REG_DWORD */, NULL, &value, &size) == ERROR_SUCCESS) {
        dark = (value == 0);
    }
    FreeLibrary(advapi);
    return dark;
}

static void pick_palette(void) {
    BOOL dark;
    DWORD n = GetEnvironmentVariableW(L"DQR_THEME", g_env_buf, 256);
    if (n > 0 && n < 256 && wequal(g_env_buf, L"dark")) dark = TRUE;
    else if (n > 0 && n < 256 && wequal(g_env_buf, L"light")) dark = FALSE;
    else dark = windows_apps_use_dark();
    g_pal = dark ? &PALETTE_DARK : &PALETTE_LIGHT;
    if (g_bg_brush) DeleteObject(g_bg_brush);
    g_bg_brush = CreateSolidBrush(g_pal->bg);
}

static void apply_title_bar(HWND hwnd) {
    HMODULE dwm = LoadLibraryW(L"dwmapi.dll");
    if (!dwm) return;
    DwmSetWindowAttribute_fn set = (DwmSetWindowAttribute_fn)(void *)GetProcAddress(dwm, "DwmSetWindowAttribute");
    if (set) {
        BOOL dark = (g_pal == &PALETTE_DARK);
        set(hwnd, 20 /* DWMWA_USE_IMMERSIVE_DARK_MODE */, &dark, sizeof(dark));
    }
    FreeLibrary(dwm);
}

/*
 * The app writes the game's icon next to the placeholder as .game-icon.ico
 * (a PNG inside an .ico). When it is there, the window and its taskbar
 * button use it; otherwise they keep the default icon.
 */
static void apply_game_icon(HWND hwnd) {
    if (g_dir_path[0] == L'\0') return;
    wcopy(g_name_file, MAX_PATH, g_dir_path);
    wappend(g_name_file, MAX_PATH, L".game-icon.ico");
    if (GetFileAttributesW(g_name_file) == INVALID_FILE_ATTRIBUTES) return;

    g_icon_big = (HICON)LoadImageW(NULL, g_name_file, IMAGE_ICON,
                                   GetSystemMetrics(SM_CXICON), GetSystemMetrics(SM_CYICON), LR_LOADFROMFILE);
    g_icon_small = (HICON)LoadImageW(NULL, g_name_file, IMAGE_ICON,
                                     GetSystemMetrics(SM_CXSMICON), GetSystemMetrics(SM_CYSMICON), LR_LOADFROMFILE);
    if (g_icon_big) SendMessageW(hwnd, WM_SETICON, ICON_BIG, (LPARAM)g_icon_big);
    if (g_icon_small) SendMessageW(hwnd, WM_SETICON, ICON_SMALL, (LPARAM)g_icon_small);
}

static void fill_rect(HDC dc, int left, int top, int right, int bottom, COLORREF color) {
    RECT r = { left, top, right, bottom };
    HBRUSH brush = CreateSolidBrush(color);
    FillRect(dc, &r, brush);
    DeleteObject(brush);
}

static void draw_window_contents(HWND hwnd, HDC hdc) {
    RECT rc;
    GetClientRect(hwnd, &rc);
    const int pad = 28;
    const int width = rc.right - rc.left;

    HDC memDC = CreateCompatibleDC(hdc);
    HBITMAP memBmp = CreateCompatibleBitmap(hdc, rc.right - rc.left, rc.bottom - rc.top);
    HBITMAP oldBmp = (HBITMAP)SelectObject(memDC, memBmp);

    FillRect(memDC, &rc, g_bg_brush);
    SetBkMode(memDC, TRANSPARENT);

    LONGLONG shown_sec = 0;
    LONGLONG countdown = 0;
    int phase = PHASE_RUNNING;
    compute_timer_state(&shown_sec, &phase, &countdown);

    wchar_t timer_text[16];
    format_mm_ss(shown_sec, timer_text);

    /* Game name and the executable it runs as */
    RECT rTitle = { pad, 22, width - pad, 50 };
    SelectObject(memDC, g_font_title);
    SetTextColor(memDC, g_pal->text);
    DrawTextW(memDC, g_game_name, -1, &rTitle, DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS);

    RECT rSub = { pad, 50, width - pad, 70 };
    SelectObject(memDC, g_font_sub);
    SetTextColor(memDC, g_pal->faint);
    DrawTextW(memDC, g_running_as, -1, &rSub, DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS);

    /* Elapsed time, then the target in a lighter colour */
    RECT rTimer = { pad, 88, width - pad, 140 };
    SelectObject(memDC, g_font_timer);
    SetTextColor(memDC, g_pal->text);
    DrawTextW(memDC, timer_text, -1, &rTimer, DT_LEFT | DT_SINGLELINE | DT_BOTTOM);
    SIZE timer_size;
    GetTextExtentPoint32W(memDC, timer_text, (int)wlen(timer_text), &timer_size);

    if (g_target_seconds > 0) {
        wchar_t target_text[24];
        wcopy(target_text, 24, L"/ ");
        format_mm_ss(g_target_seconds, target_text + 2);
        RECT rTarget = { pad + timer_size.cx + 10, 88, width - pad, 134 };
        SelectObject(memDC, g_font_status);
        SetTextColor(memDC, g_pal->faint);
        DrawTextW(memDC, target_text, -1, &rTarget, DT_LEFT | DT_SINGLELINE | DT_BOTTOM);
    }

    /* Phase, right-aligned on the timer line */
    wchar_t status_text[40];
    wchar_t number[24];
    COLORREF status_color = g_pal->run;
    if (phase == PHASE_WAITING || phase == PHASE_FINISHING) {
        wcopy(status_text, 40, phase == PHASE_WAITING ? L"Starting \x00B7 " : L"Finishing \x00B7 ");
        write_int_str(countdown, number);
        wappend(status_text, 40, number);
        status_color = g_pal->wait;
    } else {
        wcopy(status_text, 40, phase == PHASE_DONE ? L"Done" : L"Running");
    }
    RECT rStatus = { pad, 88, width - pad, 134 };
    SelectObject(memDC, g_font_status);
    SetTextColor(memDC, status_color);
    DrawTextW(memDC, status_text, -1, &rStatus, DT_RIGHT | DT_SINGLELINE | DT_BOTTOM);

    /* Progress line */
    const int barTop = 156;
    fill_rect(memDC, pad, barTop, width - pad, barTop + 4, g_pal->track);
    if (g_target_seconds > 0) {
        LONGLONG span = width - 2 * pad;
        LONGLONG filled = (phase == PHASE_DONE) ? span : (span * shown_sec) / g_target_seconds;
        if (filled > span) filled = span;
        if (filled > 0) {
            fill_rect(memDC, pad, barTop, pad + (int)filled, barTop + 4, phase == PHASE_WAITING ? g_pal->wait : g_pal->text);
        }
    }

    RECT rHint = { pad, 176, width - pad, 204 };
    SelectObject(memDC, g_font_small);
    SetTextColor(memDC, g_pal->faint);
    DrawTextW(memDC, L"OrbQuest stand-in. Keep Discord open while it runs.", -1, &rHint,
              DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS);

    BitBlt(hdc, 0, 0, rc.right - rc.left, rc.bottom - rc.top, memDC, 0, 0, SRCCOPY);

    SelectObject(memDC, oldBmp);
    DeleteObject(memBmp);
    DeleteDC(memDC);
}

static LRESULT CALLBACK WndProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam) {
    switch (msg) {
        case WM_CREATE:
            SetTimer(hwnd, TIMER_ID, TIMER_MS, NULL);
            return 0;

        case WM_TIMER:
            if (wParam == TIMER_ID) {
                InvalidateRect(hwnd, NULL, FALSE);
            }
            return 0;

        case WM_ERASEBKGND:
            return 1;

        case WM_SETTINGCHANGE:
            /* Windows switched between light and dark apps */
            if (lParam && wequal((const wchar_t *)lParam, L"ImmersiveColorSet")) {
                pick_palette();
                apply_title_bar(hwnd);
                InvalidateRect(hwnd, NULL, FALSE);
            }
            return 0;

        case WM_PAINT: {
            PAINTSTRUCT ps;
            HDC hdc = BeginPaint(hwnd, &ps);
            draw_window_contents(hwnd, hdc);
            EndPaint(hwnd, &ps);
            return 0;
        }

        case WM_CLOSE:
            DestroyWindow(hwnd);
            return 0;

        case WM_DESTROY:
            KillTimer(hwnd, TIMER_ID);
            PostQuitMessage(0);
            return 0;

        default:
            return DefWindowProcW(hwnd, msg, wParam, lParam);
    }
}

static int run_app(HINSTANCE hInstance) {
    g_start_tick_ms = GetTickCount64();
    resolve_game_and_exe_names();

    g_target_seconds = env_int(L"DQR_TARGET_SECONDS", 900, 0);
    g_buffer_start   = env_int(L"DQR_BUFFER_START", 5, 0);
    g_buffer_end     = env_int(L"DQR_BUFFER_END", 10, 0);
    g_resume_seconds = env_int(L"DQR_RESUME_SECONDS", 0, 0);

    LONGLONG launched_raw = env_int(L"DQR_LAUNCHED_AT", 0, 0);
    g_initial_offset_sec = 0;
    if (launched_raw > 0) {
        LONGLONG now_ms = current_unix_epoch_ms();
        /* Accept both millisecond (Date.now()) and second timestamps */
        LONGLONG launch_ms = (launched_raw < 10000000000LL) ? (launched_raw * 1000LL) : launched_raw;
        if (now_ms > launch_ms) {
            LONGLONG diff_sec = (now_ms - launch_ms) / 1000LL;
            /* Ignore bogus clock offsets greater than 60s */
            if (diff_sec > 0 && diff_sec <= 60) {
                g_initial_offset_sec = diff_sec;
            }
        }
    }

    pick_palette();
    g_font_title  = create_ui_font(14, FW_SEMIBOLD, L"Segoe UI");
    g_font_sub    = create_ui_font(9,  FW_NORMAL,   L"Consolas");
    g_font_timer  = create_ui_font(28, FW_SEMIBOLD, L"Segoe UI");
    g_font_status = create_ui_font(11, FW_NORMAL,   L"Segoe UI");
    g_font_small  = create_ui_font(9,  FW_NORMAL,   L"Segoe UI");

    WNDCLASSEXW wc;
    wc.cbSize        = sizeof(WNDCLASSEXW);
    wc.style         = CS_HREDRAW | CS_VREDRAW;
    wc.lpfnWndProc   = WndProc;
    wc.cbClsExtra    = 0;
    wc.cbWndExtra    = 0;
    wc.hInstance     = hInstance;
    wc.hIcon         = LoadIconW(NULL, IDI_APPLICATION);
    wc.hCursor       = LoadCursorW(NULL, IDC_ARROW);
    wc.hbrBackground = g_bg_brush;
    wc.lpszMenuName  = NULL;
    wc.lpszClassName = g_window_class_ptr;
    wc.hIconSm       = wc.hIcon;

    if (!RegisterClassExW(&wc)) {
        return 1;
    }

    DWORD style = WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX;
    RECT winRect = { 0, 0, WINDOW_WIDTH, WINDOW_HEIGHT };
    AdjustWindowRect(&winRect, style, FALSE);
    int totalW = winRect.right - winRect.left;
    int totalH = winRect.bottom - winRect.top;

    int screenW = GetSystemMetrics(SM_CXSCREEN);
    int screenH = GetSystemMetrics(SM_CYSCREEN);
    int posX = (screenW > totalW) ? (screenW - totalW) / 2 : CW_USEDEFAULT;
    int posY = (screenH > totalH) ? (screenH - totalH) / 2 : CW_USEDEFAULT;

    HWND hwnd = CreateWindowExW(
        0,
        wc.lpszClassName,
        g_game_name,
        style,
        posX, posY, totalW, totalH,
        NULL, NULL, hInstance, NULL
    );

    if (!hwnd) {
        return 1;
    }
    apply_title_bar(hwnd);
    apply_game_icon(hwnd);

    /*
     * On Windows, the VERY FIRST call to ShowWindow in a GUI process uses
     * STARTUPINFO.wShowWindow if STARTF_USESHOWWINDOW was set by the parent
     * (e.g., SW_HIDE when spawned with windowsHide). Calling ShowWindow twice
     * consumes the STARTUPINFO override on the first call and guarantees the
     * window is visibly shown on the second call.
     */
    ShowWindow(hwnd, SW_SHOWNORMAL);
    ShowWindow(hwnd, SW_SHOW);
    UpdateWindow(hwnd);

    MSG msg;
    while (GetMessageW(&msg, NULL, 0, 0) > 0) {
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }

    if (g_font_title)  DeleteObject(g_font_title);
    if (g_font_sub)    DeleteObject(g_font_sub);
    if (g_font_timer)  DeleteObject(g_font_timer);
    if (g_font_status) DeleteObject(g_font_status);
    if (g_font_small)  DeleteObject(g_font_small);
    if (g_icon_big)    DestroyIcon(g_icon_big);
    if (g_icon_small)  DestroyIcon(g_icon_small);
    if (g_bg_brush)    DeleteObject(g_bg_brush);

    return (int)msg.wParam;
}

void WINAPI wWinMainCRTStartup(void) {
    HINSTANCE hInstance = GetModuleHandleW(NULL);
    int code = run_app(hInstance);
    ExitProcess((UINT)code);
}
