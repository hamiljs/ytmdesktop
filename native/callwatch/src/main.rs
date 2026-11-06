//! callwatch: prints one JSON line each time a call starts or ends.
//!
//! A call = a call app (Zoom, Teams, Meet in a browser, Slack, Discord, FaceTime, ...) is
//! reading from a microphone. It uses CoreAudio process objects (macOS 14+), which need no
//! permission prompt: we only ask *who* uses the mic, we never open it.
//! It does not look at windows: that would need Screen Recording permission.
//!
//! Output:  {"inCall":true,"apps":["us.zoom.xos"]}
//! Flags:   --list   print every app using the mic right now, then exit (for debugging)
//!          --extra-apps FILE   more bundle id prefixes that count as call apps, one per
//!                              line (# starts a comment); for your own apps
//! Exits when stdin closes, so it never outlives the app that started it.

use std::{ffi::c_void, io::Read, mem::size_of, thread, time::Duration};

#[repr(C)]
struct PropertyAddress {
    selector: u32,
    scope: u32,
    element: u32,
}

type CFStringRef = *const c_void;

#[link(name = "CoreAudio", kind = "framework")]
extern "C" {
    fn AudioObjectGetPropertyData(
        object: u32,
        address: *const PropertyAddress,
        qualifier_size: u32,
        qualifier: *const c_void,
        data_size: *mut u32,
        data: *mut c_void,
    ) -> i32;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFStringGetCString(s: CFStringRef, buf: *mut u8, size: isize, encoding: u32) -> u8;
    fn CFRelease(cf: *const c_void);
}

const fn fourcc(s: &[u8; 4]) -> u32 {
    (s[0] as u32) << 24 | (s[1] as u32) << 16 | (s[2] as u32) << 8 | s[3] as u32
}

const SYSTEM_OBJECT: u32 = 1;
const SCOPE_GLOBAL: u32 = fourcc(b"glob");
const PROCESS_OBJECT_LIST: u32 = fourcc(b"prs#");
const PROCESS_IS_RUNNING_INPUT: u32 = fourcc(b"piri");
const PROCESS_BUNDLE_ID: u32 = fourcc(b"pbid");
const UTF8: u32 = 0x0800_0100;

/// Bundle id prefixes of apps whose mic use means "in a call". Browser prefixes also
/// match their helper processes (com.google.Chrome.helper), which is where WebRTC runs.
const CALL_APPS: &[&str] = &[
    "us.zoom.",
    "com.microsoft.teams",
    "com.tinyspeck.slackmacgap",
    "com.hnc.Discord",
    "com.apple.FaceTime",
    "com.apple.avconferenced",
    "com.cisco.webex",
    "Cisco-Systems.Spark",
    "net.whatsapp.",
    "ru.keepcoder.Telegram",
    // Browsers: Google Meet and other web calls
    "com.google.Chrome",
    "org.chromium.",
    "com.citrolabs.ego",
    "com.brave.Browser",
    "com.microsoft.edgemac",
    "company.thebrowser.",
    "org.mozilla.firefox",
    "com.apple.Safari",
    "com.apple.WebKit",
];

fn get_u32(object: u32, selector: u32) -> Option<u32> {
    let addr = PropertyAddress { selector, scope: SCOPE_GLOBAL, element: 0 };
    let mut value: u32 = 0;
    let mut size = size_of::<u32>() as u32;
    let status = unsafe {
        AudioObjectGetPropertyData(object, &addr, 0, std::ptr::null(), &mut size, &mut value as *mut u32 as *mut c_void)
    };
    (status == 0).then_some(value)
}

fn bundle_id(object: u32) -> Option<String> {
    let addr = PropertyAddress { selector: PROCESS_BUNDLE_ID, scope: SCOPE_GLOBAL, element: 0 };
    let mut s: CFStringRef = std::ptr::null();
    let mut size = size_of::<CFStringRef>() as u32;
    let status = unsafe {
        AudioObjectGetPropertyData(object, &addr, 0, std::ptr::null(), &mut size, &mut s as *mut CFStringRef as *mut c_void)
    };
    if status != 0 || s.is_null() {
        return None;
    }
    let mut buf = [0u8; 512];
    let ok = unsafe { CFStringGetCString(s, buf.as_mut_ptr(), buf.len() as isize, UTF8) };
    unsafe { CFRelease(s) };
    if ok == 0 {
        return None;
    }
    let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
    let id = String::from_utf8_lossy(&buf[..end]).into_owned();
    (!id.is_empty()).then_some(id)
}

/// Bundle ids of every process reading from any microphone right now.
fn mic_users() -> Vec<String> {
    let addr = PropertyAddress { selector: PROCESS_OBJECT_LIST, scope: SCOPE_GLOBAL, element: 0 };
    let mut ids = [0u32; 1024];
    let mut size = size_of::<[u32; 1024]>() as u32;
    let status = unsafe {
        AudioObjectGetPropertyData(SYSTEM_OBJECT, &addr, 0, std::ptr::null(), &mut size, ids.as_mut_ptr() as *mut c_void)
    };
    if status != 0 {
        return vec![];
    }
    let mut users: Vec<String> = ids[..(size as usize / size_of::<u32>())]
        .iter()
        .filter(|&&obj| get_u32(obj, PROCESS_IS_RUNNING_INPUT).unwrap_or(0) != 0)
        .map(|&obj| bundle_id(obj).unwrap_or_else(|| "(unknown)".into()))
        .collect();
    users.sort();
    users.dedup();
    users
}

fn is_call_app(bundle: &str, extra: &[String]) -> bool {
    CALL_APPS.iter().any(|p| bundle.starts_with(p)) || extra.iter().any(|p| bundle.starts_with(p.as_str()))
}

fn read_extra_apps(path: &str) -> Vec<String> {
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .map(|l| l.split('#').next().unwrap_or("").trim().to_string())
        .filter(|l| !l.is_empty())
        .collect()
}

fn json_line(in_call: bool, apps: &[String]) -> String {
    let list = apps.iter().map(|a| format!("\"{}\"", a.replace('\\', "\\\\").replace('"', "\\\""))).collect::<Vec<_>>().join(",");
    format!("{{\"inCall\":{in_call},\"apps\":[{list}]}}")
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let extra = args
        .iter()
        .position(|a| a == "--extra-apps")
        .and_then(|i| args.get(i + 1))
        .map(|p| read_extra_apps(p))
        .unwrap_or_default();

    if args.iter().any(|a| a == "--list") {
        for app in mic_users() {
            println!("{app}\t{}", if is_call_app(&app, &extra) { "call app" } else { "ignored" });
        }
        return;
    }

    // Stop when the parent app goes away and our stdin closes
    thread::spawn(|| {
        let mut sink = [0u8; 64];
        let mut stdin = std::io::stdin();
        while matches!(stdin.read(&mut sink), Ok(n) if n > 0) {}
        std::process::exit(0);
    });

    let mut last: Option<bool> = None;
    loop {
        let apps: Vec<String> = mic_users().into_iter().filter(|a| is_call_app(a, &extra)).collect();
        let in_call = !apps.is_empty();
        if last != Some(in_call) {
            println!("{}", json_line(in_call, &apps));
            last = Some(in_call);
        }
        thread::sleep(Duration::from_millis(1500));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_call_apps_and_browser_helpers() {
        assert!(is_call_app("us.zoom.xos", &[]));
        assert!(is_call_app("com.microsoft.teams2", &[]));
        assert!(is_call_app("com.google.Chrome.helper", &[]));
        assert!(is_call_app("com.citrolabs.ego.lite.helper", &[]));
        assert!(!is_call_app("com.apple.corespeechd", &[]));
        assert!(!is_call_app("com.example.dictation", &[]));
        assert!(is_call_app("com.example.recorder", &["com.example.recorder".into()]));
    }

    #[test]
    fn json_escapes() {
        assert_eq!(json_line(true, &["a\"b".into()]), r#"{"inCall":true,"apps":["a\"b"]}"#);
        assert_eq!(json_line(false, &[]), r#"{"inCall":false,"apps":[]}"#);
    }
}
