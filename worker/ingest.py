#!/usr/bin/env python3
"""Inspect public VOD captions or fetch one bounded media interval with yt-dlp."""
import argparse
import html
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlsplit
from urllib.request import build_opener, HTTPRedirectHandler, Request


class IngestError(Exception):
    pass


YOUTUBE_ID = r"[A-Za-z0-9_-]{11}"
KICK_ID = r"[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}"
ORIGINS = {
    "YouTube": ("youtube.com", "googlevideo.com", "ytimg.com", "ggpht.com", "googleusercontent.com"),
    "Twitch": ("twitch.tv", "twitchcdn.net", "ttvnw.net", "jtvnw.net", "cloudfront.net", "twitch-contents.net"),
    "Kick": ("kick.com", "kickcdn.net", "stream-io-cdn.com", "live-video.net", "kicdo.com", "cloudfront.net"),
}
MAX_SUBTITLE_BYTES = 24 * 1024 * 1024
MAX_SECTION_SECONDS = 120
MAX_AUDIO_SECONDS = 604
CAPTION_EXTENSIONS = ("json3", "vtt", "srt")


def url_parts(value):
    if not isinstance(value, str) or len(value) > 8192 or re.search(r"[\s\\\x00-\x1f\x7f]", value):
        raise ValueError("Malformed URL")
    parts = urlsplit(value)
    if parts.scheme not in ("https", "http") or not parts.hostname:
        raise ValueError("Expected HTTP(S)")
    if parts.username is not None or parts.password is not None or parts.port not in (None, 443 if parts.scheme == "https" else 80):
        raise ValueError("Invalid authority")
    return parts


def canonical_source(value):
    try:
        parsed = url_parts(value.strip())
        host = parsed.hostname.lower()
        path = parsed.path.rstrip("/")
        if host in ("youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be", "www.youtu.be"):
            if host.endswith("youtu.be"):
                video_id = path[1:]
            elif path == "/watch":
                ids = parse_qs(parsed.query, max_num_fields=150).get("v", [])
                video_id = ids[0] if len(ids) == 1 else ""
            else:
                match = re.fullmatch(r"/(?:shorts|live)/(" + YOUTUBE_ID + ")", path)
                video_id = match[1] if match else ""
            if re.fullmatch(YOUTUBE_ID, video_id):
                return "YouTube", "https://www.youtube.com/watch?v=" + video_id
        elif host in ("twitch.tv", "www.twitch.tv", "m.twitch.tv"):
            match = re.fullmatch(r"/videos/([0-9]{1,20})", path)
            if match:
                return "Twitch", "https://www.twitch.tv/videos/" + match[1]
        elif host in ("kick.com", "www.kick.com"):
            match = re.fullmatch(r"/([A-Za-z0-9_-]{1,64})/videos/(" + KICK_ID + ")", path)
            if match:
                return "Kick", f"https://kick.com/{match[1]}/videos/{match[2].lower()}"
    except (ValueError, AttributeError):
        pass
    raise IngestError("Paste a YouTube video, Twitch /videos/ link, or Kick /channel/videos/ link to a public recording.")


def allowed_asset(value, provider):
    try:
        parsed = url_parts(value)
        host = parsed.hostname.lower()
        return parsed.scheme == "https" and any(host == domain or host.endswith("." + domain) for domain in ORIGINS[provider])
    except (ValueError, KeyError):
        return False


def describe_failure(stderr, fallback):
    message = stderr.lower()
    if "proxy" in message and ("tunnel connection failed" in message or "unable to connect" in message):
        return "This worker’s network proxy could not reach the source platform."
    if "not a bot" in message or "captcha" in message or "challenge" in message:
        return "The source platform challenged this worker. Try a different public VOD or import a local video."
    if any(term in message for term in ("private video", "unavailable", "not available", "404", "deleted", "members-only", "login required", "subscription")):
        return "This recording is unavailable. Use a public, finished VOD that plays without signing in."
    if "429" in message or "too many requests" in message:
        return "The source platform is rate-limiting requests. Try again later."
    if "403" in message or "forbidden" in message:
        return "The source platform denied access to this recording from the worker."
    if "requested format" in message:
        return "The platform did not expose a usable, seekable rendition for this recording."
    return fallback


def run(args, cwd=None, timeout=120, failure="The media tool could not read this recording."):
    try:
        result = subprocess.run(args, cwd=cwd, stdin=subprocess.DEVNULL, capture_output=True,
                                text=True, encoding="utf-8", errors="replace", timeout=timeout, check=False)
    except FileNotFoundError as exc:
        raise IngestError(f"Missing server dependency: {Path(args[0]).name}.") from exc
    except subprocess.TimeoutExpired as exc:
        raise IngestError("The media request timed out. Retry with a shorter interval or another source.") from exc
    if result.returncode:
        raise IngestError(describe_failure(result.stderr, failure))
    return result.stdout


def ytdlp():
    return [
        os.environ.get("YT_DLP_BIN", "yt-dlp"), "--ignore-config", "--no-plugin-dirs", "--no-cache-dir",
        "--no-playlist", "--use-extractors", "youtube,twitch:vod,kick:vod", "--js-runtimes", "node",
        "--no-progress", "--no-colors", "--socket-timeout", "18", "--extractor-retries", "1",
        "--retries", "1", "--fragment-retries", "1", "--no-check-formats",
    ]


def finite(value, default=0):
    try:
        number = float(value)
    except (ValueError, TypeError, OverflowError):
        return default
    return number if math.isfinite(number) else default


def metadata(url, cwd):
    raw = run(ytdlp() + ["--skip-download", "--simulate", "--write-auto-subs", "--write-subs", "--sub-langs", "en.*,hi.*", "--ignore-no-formats-error", "-J", "--", url], cwd)
    try:
        info = json.loads(raw)
    except (ValueError, TypeError) as exc:
        raise IngestError("The platform returned unreadable recording metadata.") from exc
    if not isinstance(info, dict) or info.get("_type", "video") != "video":
        raise IngestError("Use a single finished video instead of a playlist or channel.")
    if info.get("is_live") or info.get("live_status") in ("is_live", "is_upcoming", "post_live"):
        raise IngestError("This recording is live or still processing. Try again once the VOD is complete.")
    if info.get("availability") in ("private", "needs_auth", "subscriber_only", "premium_only"):
        raise IngestError("This recording requires sign-in. Choose a public VOD.")
    if finite(info.get("duration")) <= 0:
        raise IngestError("The platform did not return a finished recording with a known duration.")
    return info


def clean_caption(value):
    return " ".join(html.unescape(re.sub(r"<[^>\n]*>", "", value)).replace("\u200b", "").replace("\ufeff", "").split())


def clock_time(text):
    fields = text.replace(",", ".").split(":")
    return sum(float(value) * 60 ** position for position, value in enumerate(reversed(fields)))


def parse_captions(raw, ext, duration):
    entries = []
    timings = {}
    if ext == "json3":
        data = json.loads(raw.lstrip("\ufeff"))
        for event in data.get("events", []):
            if not isinstance(event, dict) or not isinstance(event.get("segs"), list):
                continue
            start = finite(event.get("tStartMs"), -1) / 1000
            text = "".join(seg.get("utf8", "") for seg in event["segs"] if isinstance(seg, dict) and isinstance(seg.get("utf8"), str))
            pieces = [seg for seg in event["segs"] if isinstance(seg, dict) and clean_caption(str(seg.get("utf8", "")))]
            if any("tOffsetMs" in seg for seg in pieces):
                end = start + finite(event.get("dDurationMs")) / 1000
                positions = [start + finite(seg.get("tOffsetMs")) / 1000 for seg in pieces] + [end]
                words = []
                for idx, seg in enumerate(pieces):
                    tokens = clean_caption(seg["utf8"]).split()
                    begin, stop = positions[idx:idx+2]
                    for n, token in enumerate(tokens):
                        words.append({"text": token, "start": begin + (stop-begin)*n/len(tokens),
                                      "end": begin + (stop-begin)*(n+1)/len(tokens)})
                if words and all(w["end"] > w["start"] for w in words):
                    timings[start] = words
            entries.append((start, start + finite(event.get("dDurationMs")) / 1000, text))
    else:
        timestamp = r"((?:\d+:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?)"
        timing = re.compile(timestamp + r"\s*-->\s*" + timestamp)
        for block in re.split(r"\n\s*\n", raw.replace("\r\n", "\n").replace("\r", "\n")):
            lines = block.splitlines()
            for i, line in enumerate(lines):
                match = timing.match(line.strip())
                if match:
                    entries.append((clock_time(match[1]), clock_time(match[2]), " ".join(lines[i+1:])))
                    break
    cues = []
    previous_words, previous_end = [], -1.0
    for start, end, text in sorted(entries, key=lambda entry: entry[0]):
        if not 0 <= start < duration:
            continue
        end = min(duration, end if end > start else start + 2)
        words = clean_caption(text).split()
        if not words:
            continue
        folded = [word.casefold() for word in words]
        overlap = 0
        if start <= previous_end + .12:
            for size in range(min(64, len(previous_words), len(words)), 0, -1):
                if previous_words[-size:] == folded[:size] and (size > 1 or start < previous_end or len(folded) == 1):
                    overlap = size
                    break
        previous_words, previous_end = folded, end
        if overlap == len(words):
            if cues:
                cues[-1]["end"] = max(cues[-1]["end"], end)
            continue
        if cues and cues[-1]["end"] > start:
            if cues[-1]["start"] == start:
                cues[-1]["text"] += " " + " ".join(words[overlap:])
                cues[-1]["end"] = max(cues[-1]["end"], end)
                continue
            cues[-1]["end"] = start
        cues.append({"start": start, "end": end, "text": " ".join(words[overlap:])})
    for cue in cues:
        tokens = cue["text"].split()
        words = timings.get(cue["start"], [])[-len(tokens):]
        if [w["text"] for w in words] == tokens and all(w["start"] < cue["end"] for w in words):
            cue["words"] = [{**w, "end": min(w["end"], cue["end"])} for w in words]
    return cues


def transcript_api(url, duration):
    from requests import Session, RequestException
    from youtube_transcript_api import YouTubeTranscriptApi, YouTubeTranscriptApiException

    class TimedSession(Session):
        def request(self, *args, **kwargs):
            kwargs.setdefault("timeout", (5, 12))
            return super().request(*args, **kwargs)

    try:
        with TimedSession() as http:
            tracks = list(YouTubeTranscriptApi(http_client=http).list(parse_qs(urlsplit(url).query)["v"][0]))
            tracks.sort(key=lambda t: (t.language_code.split("-")[0] not in ("en", "hi"), t.is_generated,
                                       t.language_code.split("-")[0] != "en"))
            for track in tracks[:2]:
                try:
                    rows = track.fetch()
                except YouTubeTranscriptApiException:
                    continue
                cues = []
                for row in rows:
                    start, end = max(0, finite(row.start)), min(duration, finite(row.start) + finite(row.duration))
                    text = clean_caption(row.text)
                    if text and end > start:
                        cues.append({"start": start, "end": end, "text": text})
                if cues:
                    return cues
    except (YouTubeTranscriptApiException, RequestException, ValueError, KeyError):
        pass
    return []


def caption_tracks(info, provider):
    seen = set()
    for group in ("subtitles", "automatic_captions"):
        choices = []
        for lang, tracks in (info.get(group) or {}).items():
            base = re.split(r"[-_]", lang.lower())[0]
            if base not in ("en", "hi") or not isinstance(tracks, list):
                continue
            for track in tracks:
                if not isinstance(track, dict):
                    continue
                ext, url = track.get("ext"), track.get("url")
                if ext not in CAPTION_EXTENSIONS or not allowed_asset(url, provider):
                    continue
                translated = "tlang=" in url
                choices.append(((translated, base != "en", "-orig" not in lang, CAPTION_EXTENSIONS.index(ext)), ext, url))
        for _, ext, url in sorted(choices):
            if url not in seen:
                seen.add(url)
                yield ext, url


def asset_opener(provider):
    class PlatformRedirects(HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            if not allowed_asset(newurl, provider):
                raise IngestError("Media redirect left the platform's approved HTTPS hosts.")
            return super().redirect_request(req, fp, code, msg, headers, newurl)
    return build_opener(PlatformRedirects())


def fetch_caption(url, provider):
    if not allowed_asset(url, provider):
        raise IngestError("The platform returned an unsupported caption URL.")
    request = Request(url, headers={"User-Agent": "Mozilla/5.0", "Accept-Encoding": "identity"})
    with asset_opener(provider).open(request, timeout=16) as response:
        content = response.read(MAX_SUBTITLE_BYTES + 1)
    if len(content) > MAX_SUBTITLE_BYTES:
        raise IngestError("The source's caption file is too large to analyze.")
    return content.decode("utf-8-sig", errors="replace")


def analyze(url, directory):
    provider, url = canonical_source(url)
    directory.mkdir(parents=True, exist_ok=True)
    info = metadata(url, directory)
    duration = finite(info.get("duration"))
    cues = []
    for attempt, (ext, track_url) in enumerate(caption_tracks(info, provider)):
        if attempt >= 4:
            break
        try:
            cues = parse_captions(fetch_caption(track_url, provider), ext, duration)
        except (HTTPError, URLError, OSError, ValueError, TypeError, AttributeError, IngestError):
            continue
        if cues:
            break
    if not cues and provider == "YouTube":
        cues = transcript_api(url, duration)
    source = max((fmt for fmt in info.get("formats") or [] if fmt.get("vcodec") != "none" and finite(fmt.get("height")) <= 1080),
                 key=lambda fmt: finite(fmt.get("height")), default=info)
    thumb = info.get("thumbnail")
    return {"url": url, "provider": provider, "title": str(info.get("title") or info.get("id") or "Recording")[:500],
            "duration": duration, "width": int(finite(source.get("width"))), "height": int(finite(source.get("height"))),
            "thumbnail": thumb if allowed_asset(thumb, provider) else "", "cues": cues}


def safe_formats(info, provider):
    # Feed only inspected platform URLs and media descriptors into the downloader.
    # In particular, never inherit extractor-supplied ffmpeg arguments or sidecar files.
    fields = ("format_id", "ext", "url", "protocol", "vcodec", "acodec", "width", "height", "fps",
              "tbr", "abr", "vbr", "language", "language_preference", "source_preference", "manifest_stream_number")
    result = []
    for fmt in info.get("formats") or []:
        if not isinstance(fmt, dict) or fmt.get("has_drm") or fmt.get("protocol") not in ("https", "m3u8", "m3u8_native"):
            continue
        if fmt.get("vcodec") in ("images", "mhtml") or not allowed_asset(fmt.get("url"), provider):
            continue
        entry = {key: fmt[key] for key in fields if fmt.get(key) is not None}
        headers = fmt.get("http_headers") or info.get("http_headers") or {}
        entry["http_headers"] = {key: str(value) for key, value in headers.items()
                                 if key.lower() in ("user-agent", "origin", "referer", "accept", "accept-language")
                                 and not re.search(r"[\r\n]", str(value))}
        result.append(entry)
    return result


def seekable_formats(formats, provider, audio):
    # HLS has fragment-level seeking. Progressive files must actually support byte ranges.
    # Probe only the best few choices in each category, once per signed URL per worker.
    accepted = [fmt for fmt in formats if fmt["protocol"].startswith("m3u8")]
    progressive = [fmt for fmt in formats if fmt["protocol"] == "https" and finite(fmt.get("height")) <= 1080]
    def audio_only(fmt):
        return fmt.get("vcodec") == "none" and fmt.get("acodec") != "none"
    groups = [sorted((f for f in progressive if audio_only(f)), key=lambda f: finite(f.get("abr")), reverse=True)]
    video = [f for f in progressive if f.get("vcodec") != "none"]
    for silent in ((False,) if audio else (True, False)):
        group = [f for f in video if (f.get("acodec") == "none") == silent]
        groups.append(sorted(group, key=lambda f: (finite(f.get("height")), finite(f.get("tbr"))), reverse=not audio))
    for group in groups:
        for fmt in group[:4]:
            url = fmt["url"]
            if url not in _seekability:
                req = Request(url, headers={**fmt.get("http_headers", {}), "Range": "bytes=0-0", "Accept-Encoding": "identity"})
                try:
                    with asset_opener(provider).open(req, timeout=6) as response:
                        valid = response.status == 206 and response.headers.get("Content-Range", "").lower().startswith("bytes 0-0/")
                except (OSError, IngestError):
                    valid = False
                if len(_seekability) > 256:
                    _seekability.clear()
                _seekability[url] = valid
            if _seekability[url]:
                accepted.append(fmt)
                break
        if audio and any(audio_only(f) for f in accepted):
            break
    return accepted


_seekability = {}


def verify_segment(file, span, audio):
    try:
        output = run([os.environ.get("FFPROBE_BIN", "ffprobe"), "-v", "error", "-show_format", "-show_streams",
                      "-of", "json", str(file)], timeout=20, failure="The downloaded interval is not readable.")
        probe = json.loads(output)
        streams = probe.get("streams", [])
        length = finite(probe["format"]["duration"])
    except (ValueError, KeyError) as exc:
        raise IngestError("The platform returned an unreadable media interval.") from exc
    audio_streams = [s for s in streams if s.get("codec_type") == "audio"]
    if abs(length - span) > max(.32, min(span * .02, .65)):
        raise IngestError("The platform returned an incomplete interval. Select another part of this VOD.")
    if not audio_streams:
        raise IngestError("This interval has no playable audio track.")
    if audio and not any(s.get("codec_name") == "pcm_s16le" and s.get("sample_rate") == "16000" and s.get("channels") == 1 for s in audio_streams):
        raise IngestError("The selected audio interval could not be converted to mono WAV.")
    if not audio and not any(s.get("codec_type") == "video" and s.get("codec_name") == "h264" for s in streams):
        raise IngestError("This interval has no playable video track.")
    return length


def section(url, start, end, out, audio=False, info=None):
    provider, url = canonical_source(url)
    limit = MAX_AUDIO_SECONDS if audio else MAX_SECTION_SECONDS
    if not all(math.isfinite(t) for t in (start, end)) or start < 0 or end <= start or end - start > limit:
        raise IngestError(f"Select a positive interval of at most {limit} seconds.")
    out = out.resolve()
    expected = ".wav" if audio else ".mp4"
    if out.suffix.lower() != expected:
        raise IngestError(f"The output must have a {expected} extension.")
    out.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".section-", dir=out.parent) as temp:
        temp = Path(temp)
        info = info or metadata(url, temp)
        duration = finite(info.get("duration"))
        if start >= duration or end > duration + .25:
            raise IngestError("The selected interval is outside the recorded source.")
        end = min(end, duration)
        span = end - start
        formats = seekable_formats(safe_formats(info, provider), provider, audio)
        if not formats:
            raise IngestError("This recording has no supported, seekable public media rendition.")
        # Omit webpage_url to prevent an automatic extractor retry from this snapshot.
        snapshot = {key: info[key] for key in ("id", "title", "extractor", "extractor_key", "duration") if info.get(key) is not None}
        snapshot["formats"] = formats
        info_file = temp / "source.json"
        info_file.write_text(json.dumps(snapshot), encoding="utf-8")
        segment = temp / ("interval" + expected)
        if audio:
            selector = "ba/worst[acodec!=none]"
            output = "-vn -sn -dn -c:a pcm_s16le -bsf:a null -ac 1 -ar 16000 -f wav"
        else:
            selector = "bv[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080][ext=mp4]/bv[height<=1080]+ba/b[height<=1080]"
            output = "-sn -dn -c:v libx264 -preset veryfast -crf 18 -pix_fmt yuv420p -c:a aac -b:a 160k -movflags +faststart -f mp4"
        command = ytdlp() + [
            "--load-info-json", str(info_file), "--format", selector, "--downloader", "ffmpeg",
            "--download-sections", f"*{start:.6f}-{end:.6f}", "--force-keyframes-at-cuts",
            "--downloader-args", "ffmpeg_i:-protocol_whitelist https,tls,tcp,crypto -rw_timeout 15000000 -analyzeduration 1500000 -probesize 1048576",
            "--downloader-args", f"ffmpeg_o:{output} -threads 2 -map_metadata -1 -t {span:.6f}",
            "--fixup", "never", "--no-part", "--no-simulate", "--output", str(segment),
        ]
        run(command, temp, timeout=360, failure="The platform could not serve this interval. Choose another segment or source.")
        length = verify_segment(segment, span, audio)
        os.replace(segment, out)
    return {"duration": length, "start": start, "end": end, "provider": provider}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_subparsers(dest="mode", required=True)
    inspect_parser = modes.add_parser("analyze")
    inspect_parser.add_argument("--url", required=True)
    inspect_parser.add_argument("--dir", type=Path, required=True)
    for mode in ("section", "audio"):
        cut = modes.add_parser(mode)
        cut.add_argument("--url", required=True)
        cut.add_argument("--start", type=float, required=True)
        cut.add_argument("--end", type=float, required=True)
        cut.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    try:
        result = analyze(args.url, args.dir) if args.mode == "analyze" else section(args.url, args.start, args.end, args.out, args.mode == "audio")
        print(json.dumps(result, ensure_ascii=False, allow_nan=False))
    except (IngestError, OSError) as exc:
        print(str(exc), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
