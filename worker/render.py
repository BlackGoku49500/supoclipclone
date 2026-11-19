#!/usr/bin/env python3
"""Render an ordered edit from local media into a vertical H.264/AAC MP4."""

import argparse
from dataclasses import dataclass
import json
import math
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import threading


FPS = 30
SAMPLE_RATE = 48000
MAX_SECONDS = 60
LOG_LIMIT = 65536


def run_process(command, *, cwd=None, timeout=60):
    """Drain child output continuously and retain only a bounded diagnostic tail."""
    process = subprocess.Popen(
        command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT, cwd=cwd, env={**os.environ, "LC_ALL": "C"},
    )
    tail = bytearray()

    def drain():
        with process.stdout:
            while chunk := process.stdout.read(8192):
                tail.extend(chunk)
                if len(tail) > LOG_LIMIT:
                    del tail[:-LOG_LIMIT]

    reader = threading.Thread(target=drain, daemon=True)
    reader.start()
    try:
        process.wait(timeout=timeout)
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(f"{Path(command[0]).name} exceeded the rendering time limit") from exc
    finally:
        if process.poll() is None:
            process.kill()
        process.wait()
        reader.join()
    result = tail.decode("utf-8", errors="replace")
    if process.returncode:
        raise RuntimeError(f"{Path(command[0]).name} failed: {result.strip()[-2500:]}")
    return result


def probe(path):
    return json.loads(run_process([
        "ffprobe", "-v", "error", "-protocol_whitelist", "file,pipe",
        "-show_entries", "format=duration:stream=index,codec_type,width,height,nb_frames,duration:stream_disposition=attached_pic",
        "-of", "json", str(path),
    ], timeout=30))


def number(value, label):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"{label} must be a finite number")
    return float(value)


def within(value, low, high, label):
    value = number(value, label)
    if value < low or value > high:
        raise ValueError(f"{label} must be between {low} and {high}")
    return value


@dataclass(frozen=True)
class Span:
    path: Path
    local_start: float
    local_end: float
    source_start: float
    source_end: float
    first_frame: int
    frames: int


def spans_from(request):
    segments = request["clip"]["segments"]
    inputs = request["inputs"]
    if not isinstance(inputs, list) or not isinstance(segments, list) or not inputs or len(inputs) != len(segments):
        raise ValueError("Each kept segment needs exactly one local input")
    if len(inputs) > 120:
        raise ValueError("A single clip supports up to 120 kept segments")
    spans = []
    total = 0.0
    first_frame = 0
    for item, segment in zip(inputs, segments):
        local_start, local_end = (number(item[k], f"input.{k}") for k in ("start", "end"))
        start, end = (number(segment[k], f"segment.{k}") for k in ("start", "end"))
        if min(local_start, start) < 0 or local_end <= local_start or end <= start:
            raise ValueError("Each segment needs increasing, nonnegative time bounds")
        if abs((end - start) - (local_end - local_start)) > 0.10:
            raise ValueError("Input and source segment durations differ")
        path = Path(item["path"]).resolve(strict=True)
        if not path.is_file():
            raise ValueError("Input must be a local media file")
        total += end - start
        final_frame = int(total * FPS + 0.5)
        if final_frame > first_frame:
            spans.append(Span(path, local_start, local_end, start, end, first_frame, final_frame - first_frame))
        first_frame = final_frame
    if total < 0.5 - 1e-6 or total > MAX_SECONDS + 1e-6:
        raise ValueError("Kept segments must total 0.5 to 60 seconds")
    return spans


def ass_time(value):
    cs = max(0, int(value * 100 + 0.5))
    return f"{cs // 360000}:{cs // 6000 % 60:02}:{cs // 100 % 60:02}.{cs % 100:02}"


def ass_text(value):
    # ASS override blocks, hard breaks and line separators must remain literal text.
    text = "".join(c if c.isprintable() else " " for c in str(value))
    return " ".join(text.translate(str.maketrans({"\\": "＼", "{": "｛", "}": "｝"})).split())


def make_subtitles(clip, settings, spans):
    palette = {
        "neon": ("&H00FFFFFF", "&H006EFFAD", 1),
        "yellow": ("&H00FFFFFF", "&H003FE8FF", 1),
        "white": ("&H00C7C7C7", "&H00FFFFFF", 1),
        "box": ("&H00F5F5F5", "&H00ACF7FF", 3),
    }
    color, highlight, border = palette[settings.get("captionStyle", "neon")]
    styles = [
        "[Script Info]", "ScriptType: v4.00+", "PlayResX: 1080", "PlayResY: 1920",
        "ScaledBorderAndShadow: yes", "WrapStyle: 0", "", "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
        f"Style: Caption,DejaVu Sans,69,{color},&H00000000,&H00111116,&H90000000,-1,0,0,0,100,100,0,0,{border},5,2,2,60,60,310,1",
        "Style: Hook,DejaVu Sans,66,&H00FFFFFF,&H00000000,&H00101012,&H60000000,-1,0,0,0,100,100,0,0,1,5,2,8,68,68,100,1",
        "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]
    duration = (spans[-1].first_frame + spans[-1].frames) / FPS

    def dialogue(layer, start, end, style, text):
        begin, finish = ass_time(start), ass_time(end)
        if begin != finish and text:
            styles.append(f"Dialogue: {layer},{begin},{finish},{style},,0,0,0,,{text}")

    if settings.get("hook", True):
        title = ass_text(clip.get("hookTitle") or clip.get("title", ""))[:150]
        dialogue(2, 0, min(duration, 3), "Hook", title)

    cues = sorted(clip.get("captions", []), key=lambda c: number(c["start"], "caption.start"))
    for span in spans:
        for index, cue in enumerate(cues):
            start = number(cue["start"], "caption.start")
            if start >= span.source_end:
                break
            end = number(cue["end"], "caption.end")
            visible_end = min(end, cues[index + 1]["start"]) if index + 1 < len(cues) else end
            if visible_end <= max(start, span.source_start):
                continue
            words = ass_text(cue["text"]).split()
            if not words:
                continue
            step = (end - start) / len(words)
            audible = []
            for j, word in enumerate(words):
                timing = cue["words"][j] if len(cue.get("words", [])) == len(words) else None
                begin = number(timing["start"], "word.start") if timing else start + j * step
                finish = number(timing["end"], "word.end") if timing else start + (j + 1) * step
                lo = max(begin, start, span.source_start)
                hi = min(finish, visible_end, span.source_end)
                if hi > lo:
                    output_start = span.first_frame / FPS
                    offset = lambda t: output_start + min((t - span.source_start), span.frames / FPS)
                    audible.append((word, offset(lo), offset(hi)))
            for base in range(0, len(audible), 5):
                phrase = audible[base:base + 5]
                for active, (_, lo, hi) in enumerate(phrase):
                    tokens = [v[0] for v in phrase]
                    # The word-level event clock resets on every highlight.
                    tokens[active] = (r"{\1c" + highlight + r"&\fscx113\fscy113\t(0,110,\fscx100\fscy100)}"
                                      + tokens[active] + r"{\rCaption}")
                    dialogue(1, lo, hi, "Caption", " ".join(tokens))
    return "\n".join(styles) + "\n"


def crop_cover(width, height, pan):
    aspect = width / height
    frame_pan = pan if isinstance(pan, str) else f"{pan:.6f}"
    return (f"crop=w='max(2,trunc(min(iw,ih*{aspect:.10f})/2)*2)':"
            f"h='max(2,trunc(min(ih,iw/{aspect:.10f})/2)*2)':"
            f"x='(iw-ow)*({frame_pan})':y='(ih-oh)/2',scale={width}:{height}:flags=bicubic,setsar=1")


def compose(request, spans, folder, target):
    width, height = (540, 960) if request.get("preview") else (1080, 1920)
    settings, clip = request["settings"], request["clip"]
    mode = settings.get("mode", "split")
    if mode not in {"split", "smart", "speaker"}:
        raise ValueError("Choose a supported vertical layout")
    pan = within(settings.get("pan", 0.5), 0, 1, "pan")
    box = settings.get("facecam", {"x": 0, "y": 0, "w": 0.3, "h": 0.3})
    if mode == "split":
        x, y, w, h = (within(box[k], 0, 1, "facecam." + k) for k in ("x", "y", "w", "h"))
        if not w or not h or x + w > 1.000001 or y + h > 1.000001:
            raise ValueError("The facecam crop must fit inside the source frame")
    hype = [number(value, "hype moment") for value in clip.get("hypeMoments", [])]
    if len(hype) > 512:
        raise ValueError("Too many hype timestamps in this clip")
    (folder / "captions.ass").write_text(make_subtitles(clip, settings, spans), encoding="utf-8")
    command = ["ffmpeg", "-hide_banner", "-nostdin", "-loglevel", "error", "-xerror", "-y",
               "-filter_complex_threads", "2"]
    graphs, probes = [], {}
    for i, span in enumerate(spans):
        if span.path not in probes:
            probes[span.path] = probe(span.path)
        streams = probes[span.path].get("streams", [])
        video = next((s for s in streams if s["codec_type"] == "video" and
                      not s.get("disposition", {}).get("attached_pic", 0)), None)
        if not video:
            raise ValueError("A supplied input contains no playable video stream")
        audio = next((s for s in streams if s["codec_type"] == "audio"), None)
        command += ["-threads", "1", "-protocol_whitelist", "file,pipe", "-ss", f"{span.local_start:.8f}",
                    "-t", f"{span.local_end - span.local_start:.8f}", "-i", str(span.path)]
        # Work in square display pixels after FFmpeg's input autorotation.
        base = (f"[{i}:{video['index']}]setpts=PTS-STARTPTS,fps={FPS}:start_time=0,"
                "scale=w='max(2,trunc(iw*if(gt(sar,0),sar,1)/2)*2)':h=ih,setsar=1,"
                f"tpad=stop_mode=clone:stop_duration={span.frames / FPS:.8f},"
                f"trim=end_frame={span.frames},setpts=N/({FPS}*TB)")
        if mode == "split":
            top = round(height * 0.35)
            graphs.append(base + f",split=2[face{i}][game{i}]")
            graphs.append(f"[face{i}]crop=w='max(2,trunc(iw*{w:.7f}/2)*2)':"
                          f"h='max(2,trunc(ih*{h:.7f}/2)*2)':x='iw*{x:.7f}':y='ih*{y:.7f}',"
                          + crop_cover(width, top, 0.5) + f"[top{i}]")
            graphs.append(f"[game{i}]" + crop_cover(width, height - top, pan) + f"[bottom{i}]")
            graphs.append(f"[top{i}][bottom{i}]vstack=inputs=2,format=yuv420p[v{i}]")
        else:
            frame_pan = pan
            if mode == "speaker":
                if __package__:
                    from . import speaker
                else:
                    import speaker
                centers = speaker.frame_centers(span.path, span.local_start, span.local_end - span.local_start,
                                                video["width"], video["height"])
                frame_pan = speaker.pan_expression(centers, video["width"], video["height"], pan)
            base += "," + crop_cover(width, height, frame_pan)
            windows = []
            for mark in hype:
                lo, hi = max(span.source_start, mark - 0.15), min(span.source_end, mark + 1.15)
                if hi > lo:
                    first = math.floor((lo - span.source_start) * FPS + 1e-7)
                    last = math.ceil((hi - span.source_start) * FPS - 1e-7) - 1
                    windows.append(f"between(on,{first},{last})")
            if windows:
                expression = "+".join(windows)
                base += (f",zoompan=z='if(gt({expression},0),1.2,1)':x='(iw-iw/zoom)/2':"
                         f"y='(ih-ih/zoom)/2':d=1:s={width}x{height}:fps={FPS}")
            graphs.append(base + f",setsar=1,format=yuv420p[v{i}]")
        samples = span.frames * (SAMPLE_RATE // FPS)
        audio_filter = (f"[{i}:{audio['index']}]aresample={SAMPLE_RATE}:async=1:first_pts=0,"
                        "aformat=sample_fmts=fltp:channel_layouts=stereo,apad"
                        if audio else f"anullsrc=r={SAMPLE_RATE}:cl=stereo,aformat=sample_fmts=fltp")
        graphs.append(audio_filter + f",atrim=end_sample={samples},asetpts=N/SR/TB[a{i}]")
    labels = "".join(f"[v{i}][a{i}]" for i in range(len(spans)))
    graphs.extend([labels + f"concat=n={len(spans)}:v=1:a=1[edit][sound]",
                   "[edit]ass=filename=captions.ass:original_size=1080x1920,setsar=1[picture]"])
    (folder / "graph.txt").write_text(";\n".join(graphs), encoding="utf-8")
    command += ["-filter_complex_script", "graph.txt", "-map", "[picture]", "-map", "[sound]",
                "-map_metadata", "-1", "-map_chapters", "-1", "-c:v", "libx264", "-threads:v", "2",
                "-preset", "veryfast", "-crf", "25" if request.get("preview") else "21",
                "-r", str(FPS), "-pix_fmt", "yuv420p", "-c:a", "aac", "-threads:a", "1",
                "-b:a", "160k", "-ar", str(SAMPLE_RATE), "-ac", "2",
                "-movflags", "+faststart", "-f", "mp4", str(target)]
    run_process(command, cwd=folder, timeout=900)
    streams = probe(target)["streams"]
    expected = spans[-1].first_frame + spans[-1].frames
    counts = [int(s.get("nb_frames", 0)) for s in streams if s["codec_type"] == "video"]
    if counts != [expected] or not any(s["codec_type"] == "audio" for s in streams):
        raise RuntimeError("The source ended before every requested frame could be rendered")


def render(request, output):
    spans = spans_from(request)
    target = Path(output).resolve()
    if any(span.path == target for span in spans):
        raise ValueError("Output must be a different file from the source")
    target.parent.mkdir(exist_ok=True, parents=True)
    with tempfile.TemporaryDirectory(prefix=".supoclip-", dir=target.parent) as directory:
        folder = Path(directory)
        staged = folder / "clip.mp4"
        compose(request, spans, folder, staged)
        os.replace(staged, target)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--request", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    if args.request.stat().st_size > 2 * 1024 * 1024:
        raise ValueError("Render request exceeds 2 MiB")
    render(json.loads(args.request.read_text(encoding="utf-8")), args.output)


if __name__ == "__main__":
    def terminate(_signum, _frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, terminate)
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
    except (ValueError, TypeError, KeyError, OSError, RuntimeError) as error:
        print(f"Render failed: {error}", file=sys.stderr)
        sys.exit(1)
