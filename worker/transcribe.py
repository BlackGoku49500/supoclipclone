"""Transcribe a whole recording on CPU, with bounded audio reads and durable chunk checkpoints."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import sys
import tempfile
import time
import wave

if __package__:
    from . import ingest
    from .model import REVISION
else:
    import ingest
    from model import REVISION

CHUNK = 300
CONTEXT = 2
VERSION = "whisper-base-int8-word-v1"


def atomic_json(path, value):
    with tempfile.NamedTemporaryFile("w", dir=path.parent, delete=False, encoding="utf8") as out:
        json.dump(value, out, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    os.replace(out.name, path)


def chunks(duration):
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError("A finite recording duration is required.")
    for i in range(math.ceil(duration / CHUNK)):
        left, right = i * CHUNK, min((i + 1) * CHUNK, duration)
        yield i, left, right, max(0, left - CONTEXT), min(duration, right + CONTEXT)


def phrases(words):
    rows, group = [], []
    for word in words:
        if group and (word["start"] - group[-1]["end"] > .75 or len(group) >= 12 or group[-1]["text"].endswith((".", "!", "?", "।"))):
            rows.append(group)
            group = []
        group.append(word)
    if group:
        rows.append(group)
    return [{"start": g[0]["start"], "end": g[-1]["end"], "text": " ".join(w["text"] for w in g),
             "words": g} for g in rows]


class AudioReader:
    def __init__(self, source, remote):
        self.source, self.remote = source, remote
        self.info, self.fetched = None, 0

    def __call__(self, start, end, path):
        if self.remote:
            # Signed rendition URLs are short-lived. Retry the same range with new metadata.
            for attempt in range(2):
                if not self.info or time.monotonic() - self.fetched > 900:
                    self.info = ingest.metadata(self.source, path.parent)
                    self.fetched = time.monotonic()
                try:
                    ingest.section(self.source, start, end, path, True, self.info)
                    return
                except ingest.IngestError:
                    self.info = None
                    if attempt:
                        raise
        else:
            ingest.run(["ffmpeg", "-nostdin", "-v", "error", "-threads", "1", "-protocol_whitelist", "file,pipe",
                        "-ss", str(start), "-i", self.source, "-t", str(end-start), "-map", "0:a:0", "-vn",
                        "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-y", str(path)], timeout=360,
                       failure="Could not read the recording's audio track.")
            ingest.verify_segment(path, end - start, True)


class Recognizer:
    def __init__(self):
        self.model = None

    def __call__(self, wav):
        import numpy as np
        # Cheap digital-silence fast path. VAD handles ordinary background noise.
        with wave.open(str(wav), "rb") as reader:
            samples = np.frombuffer(reader.readframes(reader.getnframes()), dtype="<i2")
        if not samples.size or (samples.max() <= 1 and samples.min() >= -1):
            return []
        if self.model is None:
            from faster_whisper import WhisperModel
            folder = os.environ.get("SUPO_MODEL_DIR", "data/models/whisper-base")
            if not (Path(folder) / "model.bin").is_file():
                raise ValueError("Local speech model is missing. Install it with make model.")
            self.model = WhisperModel(folder, device="cpu", compute_type="int8", local_files_only=True,
                                      cpu_threads=max(1, min(8, int(os.environ.get("SUPO_ASR_THREADS", "4")))), num_workers=1)
        segments, _ = self.model.transcribe(samples.astype(np.float32) / 32768, word_timestamps=True,
                                            beam_size=1, vad_filter=True, condition_on_previous_text=False,
                                            vad_parameters={"min_silence_duration_ms": 500})
        return [(w.start, w.end, w.word.strip()) for segment in segments for w in (segment.words or [])
                if w.word.strip() and w.end > w.start]


def transcribe(source, duration, directory, read_audio, recognize):
    directory.mkdir(parents=True, exist_ok=True)
    fingerprint = hashlib.sha256(f"{source}|{duration:.6f}|{REVISION}|{VERSION}|{CHUNK}".encode()).hexdigest()[:24]
    parts = directory / fingerprint
    parts.mkdir(exist_ok=True)
    all_words = []
    for index, left, right, read_start, read_end in chunks(duration):
        part = parts / f"{index:05}.json"
        if part.exists():
            words = json.loads(part.read_text(encoding="utf8"))
        else:
            # A fixed scratch filename also reclaims a WAV left by a killed worker on retry.
            wav = parts / "chunk.wav"
            try:
                read_audio(read_start, read_end, wav)
                words = []
                for begin, finish, token in recognize(wav):
                    start, end = read_start + begin, read_start + finish
                    if left <= (start + end) / 2 < right and start < duration and end > 0:
                        words.append({"start": round(max(0, start), 3), "end": round(min(duration, end), 3), "text": token})
                atomic_json(part, words)
            finally:
                wav.unlink(missing_ok=True)
        for word in words:
            if all_words and word["start"] < all_words[-1]["end"]:
                previous = all_words[-1]
                if word["text"].casefold() == previous["text"].casefold() and word["start"] <= previous["start"] + .35:
                    previous["end"] = max(previous["end"], word["end"])
                    continue
                word = {**word, "start": previous["end"]}
            if word["end"] > word["start"]:
                all_words.append(word)
        atomic_json(directory / "progress.json", {"seconds": right, "duration": duration})
    atomic_json(directory / "transcript.json", phrases(all_words))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--url")
    group.add_argument("--input")
    parser.add_argument("--duration", required=True, type=float)
    parser.add_argument("--dir", required=True, type=Path)
    args = parser.parse_args()
    source = ingest.canonical_source(args.url)[1] if args.url else str(Path(args.input).resolve(strict=True))
    transcribe(source, args.duration, args.dir, AudioReader(source, bool(args.url)), Recognizer())


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, RuntimeError, ingest.IngestError) as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
