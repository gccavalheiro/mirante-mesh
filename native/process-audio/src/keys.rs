//! Global key press and release, for push-to-talk.
//!
//! Electron's `globalShortcut` fires on press and never on release, which
//! is enough for a toggle and useless for holding. Push-to-talk is the
//! feature a voice app for gaming is most obviously missing, and it cannot
//! be built on an API that does not say when you let go.
//!
//! A low-level keyboard hook does say. It is also the only way to hear a
//! key while the game has focus, which is the entire point: a push-to-talk
//! that needs the app in front is a mute button with extra steps.
//!
//! The hook callback runs on a thread owned by the OS and blocks input
//! processing for the whole machine while it runs, so it does the smallest
//! possible thing — push two numbers down a channel — and returns.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::thread::JoinHandle;

use crossbeam_channel::{unbounded, Receiver, Sender};
use parking_lot::Mutex;
use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetMessageW, PostThreadMessageW, SetWindowsHookExW,
    TranslateMessage, UnhookWindowsHookEx, HHOOK, KBDLLHOOKSTRUCT, MSG, WH_KEYBOARD_LL,
    WM_KEYDOWN, WM_KEYUP, WM_QUIT, WM_SYSKEYDOWN, WM_SYSKEYUP,
};

/// One key event: the virtual-key code, and whether it went down.
pub type KeyEvent = (u32, bool);

static SENDER: OnceLock<Mutex<Option<Sender<KeyEvent>>>> = OnceLock::new();
static RUNNING: AtomicBool = AtomicBool::new(false);
static THREAD_ID: OnceLock<Mutex<u32>> = OnceLock::new();

fn sender() -> &'static Mutex<Option<Sender<KeyEvent>>> {
    SENDER.get_or_init(|| Mutex::new(None))
}

fn thread_id() -> &'static Mutex<u32> {
    THREAD_ID.get_or_init(|| Mutex::new(0))
}

unsafe extern "system" fn hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        let info = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
        let down = matches!(wparam.0 as u32, WM_KEYDOWN | WM_SYSKEYDOWN);
        let up = matches!(wparam.0 as u32, WM_KEYUP | WM_SYSKEYUP);
        if down || up {
            // Non-blocking by construction: this runs on the OS input
            // thread, and anything slow here is felt as the whole machine
            // lagging. The channel is unbounded so it never waits.
            if let Some(tx) = sender().lock().as_ref() {
                let _ = tx.send((info.vkCode, down));
            }
        }
    }
    // Never swallow the key. Push-to-talk listens; it does not intercept,
    // or the same key would stop reaching the game it was pressed in.
    CallNextHookEx(None, code, wparam, lparam)
}

/// Start watching. Returns the receiver; dropping it does not stop the hook.
pub fn start() -> Option<(Receiver<KeyEvent>, JoinHandle<()>)> {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return None;
    }
    let (tx, rx) = unbounded();
    *sender().lock() = Some(tx);

    let handle = std::thread::Builder::new()
        .name("mirante-keys".to_owned())
        .spawn(|| {
            // SAFETY: the hook is installed and removed on this same thread,
            // which is what Windows requires of WH_KEYBOARD_LL.
            unsafe {
                *thread_id().lock() = GetCurrentThreadId();
                let Ok(handle) = SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook), None, 0) else {
                    RUNNING.store(false, Ordering::SeqCst);
                    return;
                };

                // A low-level hook only delivers while its thread pumps
                // messages. Without this loop the callback is simply never
                // called, silently.
                let mut msg = MSG::default();
                while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }

                let _ = UnhookWindowsHookEx(HHOOK(handle.0));
            }
            RUNNING.store(false, Ordering::SeqCst);
        })
        .ok()?;

    Some((rx, handle))
}

pub fn stop() {
    let id = *thread_id().lock();
    if id != 0 {
        // SAFETY: posting WM_QUIT to the hook thread ends its message loop,
        // which is the only way to make GetMessageW return.
        unsafe {
            let _ = PostThreadMessageW(id, WM_QUIT, WPARAM(0), LPARAM(0));
        }
    }
    *sender().lock() = None;
}
