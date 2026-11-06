//! ytm: control the YouTube Music desktop app (HDC fork) through its agent socket.
//!
//! Prints the JSON result on stdout. Exit code 1 and the error on stderr when the app says no;
//! exit code 2 when the app is not running.

use std::{
    io::{BufRead, BufReader, Write},
    os::unix::net::UnixStream,
    time::Duration,
};

const USAGE: &str = "\
ytm - control the YouTube Music desktop app

  ytm state                         what's playing, play state, volume, up next
  ytm play [VIDEO_ID] [--playlist ID]   play a song/playlist; no ids = resume
  ytm pause | toggle | next | prev
  ytm like | dislike                thumbs up (also loves on Last.fm) / down
  ytm shuffle | mute | unmute
  ytm volume 0-100
  ytm seek SECONDS
  ytm queue VIDEO_ID [--next]       add to the queue (end, or play next)
  ytm queue --playlist ID [--next]
  ytm search QUERY [--filter songs|videos|albums|playlists|all] [--limit N]
  ytm lastfm METHOD [key=value ...]   read-only Last.fm, e.g.
        ytm lastfm user.getTopArtists period=1month limit=20
        ytm lastfm artist.getSimilar artist=Bicep limit=10
  ytm playlists                     your playlists with ids
  ytm playlist create TITLE [VIDEO_ID ...] [--desc TEXT] [--unlisted|--public]
                                    new playlist (private by default); no ids = current queue
  ytm playlist add PLAYLIST_ID VIDEO_ID ...
  ytm capture-test [SECONDS]        record a few seconds now; silent = copy-protected
  ytm capture-next | capture-status | capture-cancel
                                    record the next song start to end (for sing-along)
  ytm lastfm-login                  open the Last.fm approval page
  ytm raw '{\"cmd\":\"help\"}'        send any request as JSON

During a call, commands that start sound are refused; add --force to override.
Output is JSON. Socket: $YTM_SOCKET or ~/Library/Application Support/YouTube Music Desktop App/agent.sock";

fn esc(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// A JSON value from a command-line word: numbers stay numbers, everything else is a string.
fn value(s: &str) -> String {
    if !s.is_empty() && s.parse::<f64>().is_ok() && !s.starts_with('+') && !(s.len() > 1 && s.starts_with('0') && !s.starts_with("0.")) {
        s.to_string()
    } else {
        esc(s)
    }
}

struct Args {
    words: Vec<String>,
}

impl Args {
    /// Removes `--name VALUE` and returns VALUE.
    fn option(&mut self, name: &str) -> Result<Option<String>, String> {
        match self.words.iter().position(|w| w == name) {
            None => Ok(None),
            Some(i) if i + 1 < self.words.len() => {
                let v = self.words.remove(i + 1);
                self.words.remove(i);
                Ok(Some(v))
            }
            Some(_) => Err(format!("{name} needs a value")),
        }
    }
    /// Removes `--name` and says whether it was there.
    fn flag(&mut self, name: &str) -> bool {
        match self.words.iter().position(|w| w == name) {
            Some(i) => {
                self.words.remove(i);
                true
            }
            None => false,
        }
    }
}

fn build_request(argv: Vec<String>) -> Result<String, String> {
    let mut args = Args { words: argv };
    if args.words.is_empty() {
        return Err(USAGE.into());
    }
    let cmd = args.words.remove(0);
    let simple = |c: &str| Ok(format!("{{\"cmd\":{}}}", esc(c)));
    match cmd.as_str() {
        "help" | "-h" | "--help" => Err(USAGE.into()),
        "state" | "status" => simple("state"),
        "pause" => simple("pause"),
        "toggle" => simple("playPause"),
        "next" => simple("next"),
        "prev" | "previous" => simple("previous"),
        "like" => simple("toggleLike"),
        "dislike" => simple("toggleDislike"),
        "shuffle" => simple("shuffle"),
        "mute" => simple("mute"),
        "unmute" => simple("unmute"),
        "play" => {
            let playlist = args.option("--playlist")?;
            let mut fields = vec!["\"cmd\":\"play\"".to_string()];
            if let Some(v) = args.words.first() {
                fields.push(format!("\"videoId\":{}", esc(v)));
            }
            if let Some(p) = playlist {
                fields.push(format!("\"playlistId\":{}", esc(&p)));
            }
            Ok(format!("{{{}}}", fields.join(",")))
        }
        "volume" => {
            let v = args.words.first().ok_or("volume needs a number 0-100")?;
            Ok(format!("{{\"cmd\":\"volume\",\"value\":{}}}", value(v)))
        }
        "seek" => {
            let v = args.words.first().ok_or("seek needs seconds")?;
            Ok(format!("{{\"cmd\":\"seek\",\"seconds\":{}}}", value(v)))
        }
        "queue" => {
            let next = args.flag("--next");
            let playlist = args.option("--playlist")?;
            let target = match (playlist, args.words.first()) {
                (Some(p), None) => format!("\"playlistId\":{}", esc(&p)),
                (None, Some(v)) => format!("\"videoId\":{}", esc(v)),
                _ => return Err("queue needs a VIDEO_ID or --playlist ID (not both)".into()),
            };
            let position = if next { "\"next\"" } else { "\"end\"" };
            Ok(format!("{{\"cmd\":\"queueAdd\",{target},\"position\":{position}}}"))
        }
        "search" => {
            let filter = args.option("--filter")?.unwrap_or_else(|| "songs".into());
            let limit = args.option("--limit")?.unwrap_or_else(|| "10".into());
            if args.words.is_empty() {
                return Err("search needs a query".into());
            }
            let query = args.words.join(" ");
            Ok(format!("{{\"cmd\":\"search\",\"query\":{},\"filter\":{},\"limit\":{}}}", esc(&query), esc(&filter), value(&limit)))
        }
        "lastfm" => {
            if args.words.is_empty() {
                return Err("lastfm needs a METHOD, e.g. user.getTopArtists".into());
            }
            let method = args.words.remove(0);
            let mut params = Vec::new();
            for w in &args.words {
                let (k, v) = w.split_once('=').ok_or_else(|| format!("lastfm params are key=value, got \"{w}\""))?;
                params.push(format!("{}:{}", esc(k), esc(v)));
            }
            Ok(format!("{{\"cmd\":\"lastfm\",\"method\":{},\"params\":{{{}}}}}", esc(&method), params.join(",")))
        }
        "lastfm-login" => simple("lastfmLogin"),
        "playlists" => simple("playlists"),
        "media-info" => simple("mediaInfo"),
        "capture-test" => {
            let s = args.words.first().cloned().unwrap_or_else(|| "5".into());
            Ok(format!("{{\"cmd\":\"captureTest\",\"seconds\":{}}}", value(&s)))
        }
        "capture-next" => simple("captureNext"),
        "capture-status" => simple("captureStatus"),
        "capture-cancel" => simple("captureCancel"),
        "playlist" => {
            if args.words.is_empty() {
                return Err("playlist needs: create TITLE [IDS...] | add PLAYLIST_ID IDS...".into());
            }
            let sub = args.words.remove(0);
            let ids = |words: &[String]| words.iter().map(|w| esc(w)).collect::<Vec<_>>().join(",");
            match sub.as_str() {
                "create" => {
                    let privacy = if args.flag("--public") {
                        "PUBLIC"
                    } else if args.flag("--unlisted") {
                        "UNLISTED"
                    } else {
                        "PRIVATE"
                    };
                    let description = args.option("--desc")?.unwrap_or_default();
                    if args.words.is_empty() {
                        return Err("playlist create needs a TITLE".into());
                    }
                    let title = args.words.remove(0);
                    let mut fields = vec![
                        "\"cmd\":\"createPlaylist\"".to_string(),
                        format!("\"title\":{}", esc(&title)),
                        format!("\"description\":{}", esc(&description)),
                        format!("\"privacy\":\"{privacy}\""),
                    ];
                    if !args.words.is_empty() {
                        fields.push(format!("\"videoIds\":[{}]", ids(&args.words)));
                    }
                    Ok(format!("{{{}}}", fields.join(",")))
                }
                "add" => {
                    if args.words.len() < 2 {
                        return Err("playlist add needs a PLAYLIST_ID and at least one VIDEO_ID".into());
                    }
                    let playlist = args.words.remove(0);
                    Ok(format!("{{\"cmd\":\"addToPlaylist\",\"playlistId\":{},\"videoIds\":[{}]}}", esc(&playlist), ids(&args.words)))
                }
                other => Err(format!("unknown playlist command \"{other}\"")),
            }
        }
        "raw" => args.words.first().cloned().ok_or_else(|| "raw needs a JSON request".into()),
        other => Err(format!("unknown command \"{other}\"\n\n{USAGE}")),
    }
}

fn socket_path() -> String {
    std::env::var("YTM_SOCKET").unwrap_or_else(|_| {
        let home = std::env::var("HOME").unwrap_or_default();
        format!("{home}/Library/Application Support/YouTube Music Desktop App/agent.sock")
    })
}

fn main() {
    let mut argv: Vec<String> = std::env::args().skip(1).collect();
    let force = argv.iter().position(|a| a == "--force").map(|i| argv.remove(i)).is_some();
    let request = match build_request(argv).map(|r| if force && r.ends_with('}') { format!("{},\"force\":true}}", &r[..r.len() - 1]) } else { r }) {
        Ok(r) => r,
        Err(msg) => {
            eprintln!("{msg}");
            std::process::exit(if msg == USAGE { 0 } else { 1 });
        }
    };

    let path = socket_path();
    let mut stream = match UnixStream::connect(&path) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("YouTube Music app is not reachable at {path}: {e}\n(is the app running, with agent control on?)");
            std::process::exit(2);
        }
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(40)));
    if let Err(e) = stream.write_all(format!("{request}\n").as_bytes()) {
        eprintln!("could not send to the app: {e}");
        std::process::exit(2);
    }

    let mut line = String::new();
    if let Err(e) = BufReader::new(&stream).read_line(&mut line) {
        eprintln!("no answer from the app: {e}");
        std::process::exit(2);
    }
    let line = line.trim_end();
    const OK: &str = "{\"ok\":true,\"result\":";
    if let Some(rest) = line.strip_prefix(OK) {
        println!("{}", rest.strip_suffix('}').unwrap_or(rest));
    } else {
        eprintln!("{line}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn req(s: &str) -> String {
        build_request(s.split(' ').map(String::from).collect()).unwrap()
    }

    #[test]
    fn builds_requests() {
        assert_eq!(req("state"), r#"{"cmd":"state"}"#);
        assert_eq!(req("play abc --playlist PL1"), r#"{"cmd":"play","videoId":"abc","playlistId":"PL1"}"#);
        assert_eq!(req("play"), r#"{"cmd":"play"}"#);
        assert_eq!(req("queue abc --next"), r#"{"cmd":"queueAdd","videoId":"abc","position":"next"}"#);
        assert_eq!(req("search bicep glue --limit 3"), r#"{"cmd":"search","query":"bicep glue","filter":"songs","limit":3}"#);
        assert_eq!(
            req("lastfm user.getTopArtists period=1month limit=5"),
            r#"{"cmd":"lastfm","method":"user.getTopArtists","params":{"period":"1month","limit":"5"}}"#
        );
        assert_eq!(req("volume 40"), r#"{"cmd":"volume","value":40}"#);
        assert_eq!(
            req("playlist create Mix aaaaaaaaaaa bbbbbbbbbbb"),
            r#"{"cmd":"createPlaylist","title":"Mix","description":"","privacy":"PRIVATE","videoIds":["aaaaaaaaaaa","bbbbbbbbbbb"]}"#
        );
        assert_eq!(req("playlist create Mix --unlisted"), r#"{"cmd":"createPlaylist","title":"Mix","description":"","privacy":"UNLISTED"}"#);
        assert_eq!(req("playlist add PL1 aaaaaaaaaaa"), r#"{"cmd":"addToPlaylist","playlistId":"PL1","videoIds":["aaaaaaaaaaa"]}"#);
    }

    #[test]
    fn video_ids_that_look_numeric_stay_strings() {
        assert_eq!(value("0123"), "\"0123\"");
        assert_eq!(value("42"), "42");
        assert_eq!(esc("a\"b\\c"), r#""a\"b\\c""#);
    }

    #[test]
    fn rejects_bad_input() {
        assert!(build_request(vec!["queue".into()]).is_err());
        assert!(build_request(vec!["lastfm".into(), "m".into(), "nokey".into()]).is_err());
        assert!(build_request(vec!["bogus".into()]).is_err());
    }
}
