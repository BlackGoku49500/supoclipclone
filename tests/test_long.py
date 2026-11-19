import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from worker import ingest, render, speaker, transcribe


class LongRecordings(unittest.TestCase):
    def test_ten_hour_restart_and_overlap(self):
        reads = []
        def read(start, end, path):
            self.assertLessEqual(end - start, transcribe.CHUNK + 2 * transcribe.CONTEXT)
            reads.append(start)
            path.write_text(str(start))
        def recognize(path):
            start = float(path.read_text())
            if start == 898:
                raise RuntimeError("interruption")
            return [(2, 3, "spoken")]
        with tempfile.TemporaryDirectory() as folder:
            dest = Path(folder)
            with self.assertRaisesRegex(RuntimeError, "interruption"):
                transcribe.transcribe("vod", 36000, dest, read, recognize)
            self.assertEqual(json.loads((dest / "progress.json").read_text())["seconds"], 900)
            self.assertFalse(list(dest.rglob("*.wav")))
            reads.clear()
            transcribe.transcribe("vod", 36000, dest, read, lambda _: [(2, 3, "spoken")])
            self.assertEqual(len(reads), 117)
            self.assertEqual(reads[0], 898)
            cues = json.loads((dest / "transcript.json").read_text())
            self.assertEqual(len(cues), 120)
            self.assertEqual(cues[-1]["words"][0]["start"], 35700)
            self.assertEqual(json.loads((dest / "progress.json").read_text())["seconds"], 36000)
            transcribe.transcribe("vod", 36000, dest, lambda *_: self.fail("re-read a finished chunk"), lambda _: [])
            self.assertFalse(list(dest.rglob("*.wav")))

    def test_youtube_library_fallback_and_native_words(self):
        track = SimpleNamespace(is_generated=True, language_code="en", fetch=lambda: [
            SimpleNamespace(start=7210.25, duration=2.75, text="the late reveal")])
        with tempfile.TemporaryDirectory() as folder, patch.object(ingest, "metadata", return_value={"duration":36000}), \
                patch("youtube_transcript_api.YouTubeTranscriptApi.list", return_value=[track]) as library:
            data = ingest.analyze("https://www.youtube.com/live/LiteLong001", Path(folder))
            library.assert_called_once_with("LiteLong001")
            self.assertEqual(data["cues"], [{"start":7210.25, "end":7213, "text":"the late reveal"}])
        raw = {"events":[{"tStartMs":5000,"dDurationMs":2000,"segs":[{"utf8":"wait"},{"utf8":" now","tOffsetMs":1680}]}]}
        cue = ingest.parse_captions(json.dumps(raw), "json3", 20)[0]
        self.assertEqual(cue["words"][1]["start"], 6.68)
        vtt = "WEBVTT\n\n00:00:05.000 --> 00:00:07.000\nwait <00:00:06.680><c>now</c>"
        self.assertEqual(ingest.parse_captions(vtt, "vtt", 20)[0]["words"], cue["words"])
        span = render.Span(Path("unused"),0,2,5,7,0,60)
        subtitles = render.make_subtitles({"captions":[cue]}, {"hook":False}, [span])
        self.assertIn("0:00:01.68,0:00:02.00,Caption", subtitles)

    def test_face_is_followed_across_a_cut(self):
        import cv2
        import numpy as np
        fixture = Path(__file__).parent / "fixtures" / "hopper.jpg"
        photo = cv2.imread(str(fixture))
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "speaker.mp4"
            left = np.full((180,320,3), 50, np.uint8)
            right = left.copy()
            left[12:162,0:128] = photo
            right[12:162,192:320] = photo
            command = ["ffmpeg","-nostdin","-v","error","-f","rawvideo","-pix_fmt","bgr24","-s","320x180","-r","3",
                       "-i","pipe:0","-c:v","libx264","-pix_fmt","yuv420p","-threads","1",str(path)]
            subprocess.run(command, input=left.tobytes()*9 + right.tobytes()*9 + np.full_like(left, 50).tobytes()*6, check=True)
            centers = speaker.frame_centers(path, 0, 8, 320, 180)
            self.assertLess(centers[0][1], .35)
            self.assertGreater(centers[-2][1], .65)
            self.assertIsNone(centers[-1][1])
            self.assertIn("clip(", speaker.pan_expression(centers, 320, 180, .5))
            self.assertEqual(speaker.pan_expression([], 320, 180, .37), "0.370000")

    def test_nonseekable_progressive_is_excluded(self):
        from unittest.mock import MagicMock
        fmt = {"url":"https://cdn.example.invalid/unseekable.mp4","vcodec":"h264","acodec":"aac","protocol":"https","height":720}
        opener = MagicMock()
        opener.open.return_value.__enter__.return_value.status = 200
        with patch.object(ingest, "asset_opener", return_value=opener):
            self.assertEqual(ingest.seekable_formats([fmt], "YouTube", False), [])
        self.assertEqual(opener.open.call_args.args[0].get_header("Range"), "bytes=0-0")
