"""Exercise the worker against deterministic subtitles and a real HTTPS HLS recording."""
import functools
import http.server
import json
import os
from pathlib import Path
import shutil
import ssl
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import patch
from worker import ingest


class Captions(unittest.TestCase):
    def test_url_and_rolling_captions(self):
        self.assertEqual(ingest.canonical_source('https://youtu.be/aqz-KE-bpKQ?t=23'),
                         ('YouTube','https://www.youtube.com/watch?v=aqz-KE-bpKQ'))
        self.assertEqual(ingest.canonical_source('https://www.twitch.tv/videos/12345')[0], 'Twitch')
        self.assertEqual(ingest.canonical_source('https://kick.com/test/videos/ef000000-0000-0000-0000-000000000000')[0], 'Kick')
        with self.assertRaises(ingest.IngestError):
            ingest.canonical_source('https://example.com/watch?v=aqz-KE-bpKQ')
        cues=ingest.parse_captions('WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHello there\n\n00:00:02.000 --> 00:00:04.000\nHello there again', 'vtt',10)
        self.assertEqual([c['text'] for c in cues],['Hello there','again'])
        self.assertEqual(cues[0]['end'],2)
        self.assertFalse(ingest.allowed_asset(None,'YouTube'))

    def test_metadata_and_caption_body_only(self):
        track='https://www.youtube.com/api/timedtext'
        info={'title':'Fixture', 'duration':10800, 'formats':[], 'subtitles':{'hi':[{'url':track,'ext':'vtt'}]}}
        with tempfile.TemporaryDirectory() as folder, patch.object(ingest,'run',return_value=json.dumps(info)) as process, patch.object(ingest,'fetch_caption',return_value='WEBVTT\n\n00:01:20.000 --> 00:01:22.000\nनमस्ते') as read:
            result=ingest.analyze('https://youtu.be/aqz-KE-bpKQ',Path(folder))
            self.assertEqual(result['cues'],[{'start':80,'end':82,'text':'नमस्ते'}])
            self.assertEqual(process.call_count,1)
            command=process.call_args.args[0]
            self.assertTrue(all(flag in command for flag in ['--skip-download','--write-subs','--write-auto-subs','-J']))
            read.assert_called_once_with(track,'YouTube')


class PartialDownload(unittest.TestCase):
    def test_ytdlp_bounded_video_and_audio(self):
        # Only the external platform's metadata is a fixture. yt-dlp, FFmpeg,
        # byte requests, HLS seeking, WAV conversion and ffprobe are real.
        self.assertTrue(shutil.which(os.getenv('YT_DLP_BIN','yt-dlp')),'Install yt-dlp[default] to run media tests.')
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            def run(*args):
                subprocess.run(args,cwd=root,check=True,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,timeout=90)
            run('openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout','key','-out','cert','-subj','/CN=localhost','-days','1')
            run('ffmpeg','-nostdin','-loglevel','error','-f','lavfi','-i','testsrc2=size=320x180:rate=10',
                '-f','lavfi','-i','sine=frequency=600:sample_rate=16000','-t','90','-c:v','libx264','-threads','1',
                '-preset','ultrafast','-g','20','-sc_threshold','0','-c:a','aac','-f','hls','-hls_time','2',
                '-hls_list_size','0','-hls_segment_filename','segment%03d.ts','stream.m3u8')
            reads=[]
            class Handler(http.server.SimpleHTTPRequestHandler):
                def log_message(self,*args): pass
                def do_GET(self):
                    reads.append(self.path)
                    super().do_GET()
            server=http.server.ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=tmp))
            ctx=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            ctx.load_cert_chain(root/'cert',root/'key')
            server.socket=ctx.wrap_socket(server.socket,server_side=True)
            threading.Thread(target=server.serve_forever,daemon=True).start()
            url=f'https://127.0.0.1:{server.server_port}/stream.m3u8'
            fmt={'format_id':'fixture','ext':'mp4','protocol':'m3u8_native','url':url,'width':320,'height':180,'vcodec':'h264','acodec':'aac'}
            meta={'id':'fixture','title':'Fixture stream','duration':90,'extractor':'generic','extractor_key':'Generic','formats':[fmt]}
            try:
                with patch.object(ingest,'metadata',return_value=meta), patch.object(ingest,'allowed_asset',side_effect=lambda value,provider:value==url):
                    for audio in (False,True):
                        reads.clear()
                        output=root/('out.wav' if audio else 'out.mp4')
                        result=ingest.section('https://youtu.be/aqz-KE-bpKQ',60,66,output,audio)
                        self.assertAlmostEqual(result['duration'],6,delta=.32)
                        fragments={p for p in reads if p.endswith('.ts')}
                        self.assertGreater(len(fragments),0)
                        self.assertLess(len(fragments),18, 'Downloader consumed too much of a 45-fragment stream')
                        self.assertTrue(any('segment030' in p for p in fragments))
                        self.assertFalse(any('segment015' in p for p in fragments))
            finally:
                server.shutdown()
                server.server_close()


if __name__=='__main__':
    unittest.main()
