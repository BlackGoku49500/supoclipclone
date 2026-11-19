"""Exercise the real FFmpeg/libass encoder and inspect its pixels, PCM and container."""

import array
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
RENDER = ROOT / "worker" / "render.py"
spec = importlib.util.spec_from_file_location("supoclip_render", RENDER)
renderer = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = renderer
spec.loader.exec_module(renderer)


def execute(*command):
    return subprocess.check_output(command, stderr=subprocess.PIPE, timeout=120)


def stream_info(path):
    return json.loads(execute("ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)))


def rgb(path, time, x, y):
    return tuple(execute("ffmpeg", "-v", "error", "-ss", str(time), "-i", str(path), "-vf",
                         f"format=rgb24,crop=1:1:{x}:{y}", "-frames:v", "1", "-threads", "1",
                         "-f", "rawvideo", "pipe:1"))


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "FFmpeg and ffprobe are required")
class RenderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.storage = tempfile.TemporaryDirectory()
        cls.root = Path(cls.storage.name)
        cls.source = cls.root / "facecam ' test.mp4"
        cls.silent = cls.root / "variable.webm"
        execute("ffmpeg", "-v", "error", "-f", "lavfi", "-i",
                "color=c=blue:s=320x180:r=25:d=2,drawbox=x=0:y=0:w=80:h=54:color=red:t=fill",
                "-f", "lavfi", "-i", "sine=f=630:r=44100:d=2", "-c:a", "aac", "-c:v", "libx264",
                "-threads", "1", "-pix_fmt", "yuv420p", str(cls.source))
        execute("ffmpeg", "-v", "error", "-f", "lavfi", "-i",
                "color=c=lime:s=240x180:r=30:d=2,select='if(lt(t,1),not(mod(n,3)),not(mod(n,2)))'",
                "-fps_mode", "vfr", "-an", "-c:v", "libvpx-vp9", "-threads", "1", str(cls.silent))

    @classmethod
    def tearDownClass(cls):
        cls.storage.cleanup()

    def request(self):
        return {
            "inputs": [
                {"path": str(self.source), "start": 0.28, "end": 0.98},
                {"path": str(self.silent), "start": 0.6, "end": 1.4},
            ],
            "clip": {"id": "one", "title": "Test clip", "hookTitle": "Watch this", "reason": "",
                     "viralityScore": 89, "segments": [{"start": 18.5, "end": 19.2}, {"start": 70, "end": 70.8}],
                     "captions": [{"start": 18.55, "end": 19.17, "text": "One great catch"},
                                  {"start": 30, "end": 31, "text": "Removed middle"},
                                  {"start": 70.1, "end": 70.7, "text": "Here we go"}],
                     "hypeMoments": [70.5]},
            "settings": {"mode": "split", "pan": 0.5, "facecam": {"x": 0, "y": 0, "w": 0.25, "h": 0.3},
                         "captionStyle": "neon", "hook": True},
            "preview": True,
        }

    def render(self, request, name):
        source = self.root / (name + ".json")
        output = self.root / (name + ".mp4")
        source.write_text(json.dumps(request), encoding="utf-8")
        result = subprocess.run([sys.executable, str(RENDER), "--request", str(source), "--output", str(output)],
                                capture_output=True, text=True, timeout=120)
        self.assertEqual(result.returncode, 0, result.stderr)
        return output

    def test_split_concat_pixels_audio_silent_vfr_and_faststart(self):
        output = self.render(self.request(), "split")
        data = stream_info(output)
        vid, aud = data["streams"]
        self.assertEqual((vid["codec_name"], vid["width"], vid["height"], vid["r_frame_rate"]),
                         ("h264", 540, 960, "30/1"))
        self.assertEqual(int(vid["nb_frames"]), 45)
        self.assertEqual((aud["codec_name"], aud["channels"], aud["sample_rate"]), ("aac", 2, "48000"))
        self.assertAlmostEqual(float(data["format"]["duration"]), 1.5, delta=0.04)
        mp4 = output.read_bytes()
        self.assertLess(mp4.index(b"moov"), mp4.index(b"mdat"))
        red = rgb(output, 0.3, 130, 180)
        blue = rgb(output, 0.3, 130, 510)
        green = rgb(output, 1.2, 130, 510)
        self.assertGreater(red[0], 220)
        self.assertGreater(blue[2], 220)
        self.assertGreater(green[1], 220)
        pcm = array.array("h", execute("ffmpeg", "-v", "error", "-i", str(output), "-vn", "-ac", "1", "-ar",
                                       "8000", "-f", "s16le", "pipe:1"))
        self.assertGreater(max(map(abs, pcm[1600:4000])), 1000)
        self.assertLess(max(map(abs, pcm[8000:11000])), 35)
        self.assertFalse(list(self.root.glob(".supoclip-*")))

    def test_smart_export_hype_and_hook_switch(self):
        params = self.request()
        params["inputs"] = [params["inputs"][0]]
        params["clip"]["segments"] = [params["clip"]["segments"][0]]
        params["clip"]["hypeMoments"] = [18.8]
        params["settings"].update(mode="smart", hook=False, captionStyle="yellow", pan=0)
        params["preview"] = False
        output = self.render(params, "smart")
        video = stream_info(output)["streams"][0]
        self.assertEqual((video["width"], video["height"], int(video["nb_frames"])), (1080, 1920, 21))
        # Edge of the top-left facecam moves as the crop punches in at 1.2x.
        before = rgb(output, 0.035, 880, 200)
        after = rgb(output, 0.33, 880, 200)
        self.assertGreater(before[2], 190)
        self.assertGreater(after[0], 190)

    def test_ass_remaps_words_and_escapes_override_blocks(self):
        params = self.request()
        params["clip"]["hookTitle"] = r"{\pos(0,0)}safe\N"
        params["clip"]["captions"][2]["text"] = "three fast words"
        spans = renderer.spans_from(params)
        script = renderer.make_subtitles(params["clip"], params["settings"], spans)
        self.assertNotIn("Removed middle", script)
        self.assertNotIn(r"{\pos", script)
        self.assertNotIn(r"safe\N", script)
        self.assertIn("Dialogue: 2,0:00:00.00,0:00:01.50,Hook", script)
        self.assertIn("Dialogue: 1,0:00:00.80,0:00:01.00,Caption", script)
        self.assertIn(r"\fscx113", script)
        self.assertIn(r"\1c", script)
        params["settings"]["hook"] = False
        self.assertNotIn("Dialogue: 2", renderer.make_subtitles(params["clip"], params["settings"], spans))

    def test_invalid_crop_keeps_previous_output_and_cleans_scratch(self):
        params = self.request()
        params["settings"]["facecam"]["x"] = 1
        out = self.root / "previous.mp4"
        out.write_bytes(b"prior")
        with self.assertRaises(ValueError):
            renderer.render(params, out)
        self.assertEqual(out.read_bytes(), b"prior")
        self.assertFalse(list(self.root.glob(".supoclip-*")))


if __name__ == "__main__":
    unittest.main()
