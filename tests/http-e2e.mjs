// Run after npm run build. Platform and model responses are deterministic.
import assert from 'node:assert/strict';
import {LONG_URL, makeLongRecording} from "./long-recording.mjs";
import {recordingFixture} from './platform-fixture.mjs';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const primaryModel = 'nvidia/nemotron-3.5-super-vl:free';

function testTranscript() {
  const cues = [];
  const sentences = [
    'A great cut starts', 'before you open the timeline', 'Listen to that breath',
    'there is a hidden rhythm', 'Leave the little pause', 'and hold the reveal',
    'Watch what happens next', 'when the camera moves', 'The audience leans forward',
    'before the next line', 'That is the secret', 'to a satisfying edit',
    'Carry it into the cut',
  ];
  const stamp = s => new Date(s * 1000).toISOString().slice(11, 23).replace('.', ',');
  for (let group = 0; group < 3; group++) {
    sentences.forEach((sentence, i) => {
      const start = group * 34 + 2 * i + (i >= 6 ? 4 : 0);
      cues.push(`${cues.length + 1}\n${stamp(start)} --> ${stamp(start + 2)}\n${sentence}`);
    });
  }
  return cues.join('\n\n');
}

async function createVideo(dir) {
  const video = path.join(dir, 'fixture.mp4');
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=6',
    '-f', 'lavfi', '-i', 'sine=frequency=470:sample_rate=16000',
    '-t', '102', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '32',
    '-g','12','-sc_threshold','0','-pix_fmt', 'yuv420p', '-threads', '1', '-c:a', 'aac', '-b:a', '32k', video],
  { timeout: 40000 });
  return video;
}

// This function is serialized into a temporary Node preload. Nothing under app/ or server/
// reads a test flag or accepts a replacement OpenRouter endpoint.
function interceptOpenRouter(trace) {
  const { appendFileSync } = require('node:fs');
  const upstream = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url || input.href;
    if (url !== 'https://openrouter.ai/api/v1/chat/completions') return upstream(input, init);
    const request = new Request(input, init);
    const data = await request.json();
    appendFileSync(trace, JSON.stringify({
      model: data.model, authorized: request.headers.get('authorization')?.startsWith('Bearer sk-or-'),
    }) + '\n');
    if (data.model !== 'openrouter/free') {
      return Response.json({error:{message:'Fixture rate limit'}}, {status:429});
    }
    const window = JSON.parse(data.messages[1].content);
    if (window.cues.some(row => /castle|treasure|paintings/i.test(row[3]))) {
      const first = window.cues[0][0], last = window.cues.at(-1)[0];
      const clip = {title: "The castle door", hookTitle: "What was inside?", reason: "The key sets up the reveal.",
        viralityScore: 95, segments: [{firstCue: first, lastCue: last}], hypeCueIds: [last]};
      return Response.json({choices: [{message: {content: JSON.stringify([clip])}}]});
    }
    const groups = [0, 34, 68];
    const proposals = groups.flatMap((begin, group) => {
      const rows = window.cues.filter(row => row[1] >= begin && row[1] < begin + 30);
      const early = rows.filter(row => row[1] < begin + 12);
      const late = rows.filter(row => row[1] >= begin + 16);
      if (!early.length || !late.length) return [];
      return [{
        title:['Listen for the breath', 'Hold the reveal', 'Time the reaction'][group],
        hookTitle:['Listen to the cut', 'Wait for it', 'Watch the reaction'][group],
        reason:'The reveal follows a short setup and a clean change of pace.',
        viralityScore:95 - group,
        segments:[early, late].map(kept => ({firstCue:kept[0][0], lastCue:kept.at(-1)[0]})),
        hypeCueIds:[late[0][0]],
      }];
    });
    return Response.json({choices:[{message:{content:JSON.stringify(proposals)}}]});
  };
}

async function listenPort() {
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const {port} = listener.address();
  const closed = once(listener, 'close');
  listener.close();
  await closed;
  return port;
}

async function present(file) {
  return Boolean(await stat(file).catch(() => null));
}

async function startServer(temp, trace, fixtureEnv) {
  const standalone = path.join(root, '.next', 'standalone');
  const stage = path.join(temp, 'standalone');
  let cwd = root;
  let args;
  const port = await listenPort();
  if (process.argv.includes('--image')) {
    cwd = '/app';
    args = ['server.js'];
  } else if (await present(path.join(standalone, 'server.js'))) {
    // Assemble the same layout as the deployment image.
    await cp(standalone, stage, {recursive:true, verbatimSymlinks:true});
    for (const name of ['public', 'worker', '.next/static']) {
      await cp(path.join(root, name), path.join(stage, name), {recursive:true, force:true});
    }
    cwd = stage;
    args = ['server.js'];
  } else {
    assert.ok(await present(path.join(root, '.next', 'BUILD_ID')), 'Run npm run build before the HTTP tests.');
    args = [path.join(root, 'node_modules/next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'];
  }
  const preload = path.join(temp, 'openrouter-preload.cjs');
  await writeFile(preload, '(' + interceptOpenRouter.toString() + ')(' + JSON.stringify(trace) + ');\n');
  const server = spawn(process.execPath, args, {
    cwd, stdio:['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
    env:{...process.env,...fixtureEnv, HOSTNAME:'127.0.0.1', PORT:String(port),
      NODE_ENV:'production', NODE_OPTIONS:[process.env.NODE_OPTIONS, '--require=' + JSON.stringify(preload)].filter(Boolean).join(' '),
      SUPO_DATA_DIR:path.join(temp, 'work'), NEXT_TELEMETRY_DISABLED:'1'},
  });
  let logs = '';
  server.stdout.on('data', chunk => { logs = (logs + chunk).slice(-14000); });
  server.stderr.on('data', chunk => { logs = (logs + chunk).slice(-14000); });
  const base = 'http://127.0.0.1:' + port;
  async function stop() {
    if (server.exitCode !== null || server.signalCode !== null) return;
    const ended = once(server, 'exit').catch(() => {});
    const kill = signal => {
      try { if (process.platform === 'win32') server.kill(signal); else process.kill(-server.pid, signal); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    };
    kill('SIGTERM');
    const force = setTimeout(() => kill('SIGKILL'), 5000);
    try { await ended; } finally { clearTimeout(force); }
  }
  try {
    const deadline = Date.now() + 35000;
    while (Date.now() < deadline) {
      if (server.exitCode !== null || server.signalCode !== null) throw new Error('Server exited during startup.\n' + logs);
      const health = await fetch(base + '/api/health', {signal:AbortSignal.timeout(3000)}).catch(() => null);
      if (health?.ok) return {base, stop};
      await delay(200);
    }
    throw new Error('Production health check timed out.\n' + logs);
  } catch (error) { await stop(); throw error; }
}

function session(base) {
  let cookie = '';
  return {
    get cookie() { return cookie; },
    async request(endpoint, init = {}) {
      const url = new URL(endpoint, base);
      assert.equal(url.origin, base, 'Media and job URLs belong to this studio.');
      const headers = new Headers(init.headers);
      if (cookie) headers.set('Cookie', cookie);
      const response = await fetch(url, {...init, headers, signal:AbortSignal.timeout(35000)});
      const issued = response.headers.getSetCookie();
      if (issued.length) {
        assert.ok(issued.some(value => /;\s*httponly/i.test(value)), 'A session cookie is HttpOnly.');
        cookie = issued.map(value => value.split(';')[0]).join('; ');
      }
      return response;
    },
    post(endpoint, payload, headers = {}) {
      return this.request(endpoint, {method:'POST', headers:{'Content-Type':'application/json', ...headers}, body:JSON.stringify(payload)});
    },
  };
}

async function json(response) {
  const text = await response.text();
  assert.ok(response.ok, 'Expected success, received ' + response.status + ' ' + text.slice(0, 700));
  return JSON.parse(text);
}

async function generate(user, other, body, auth) {
  const response = await user.post('/api/generate-clips', body, {...auth, Prefer:'respond-async'});
  assert.equal(response.status, 202);
  const {jobId} = await json(response);
  const endpoint = '/api/analysis-jobs/' + jobId;
  assert.ok([401, 403, 404].includes((await other.request(endpoint)).status));
  for (let i = 0; i < 900; i++) {
    const state = await json(await user.request(endpoint));
    assert.notEqual(state.status, 'failed', state.error);
    if (state.status === 'done') return state;
    await delay(250);
  }
  throw new Error('Analysis did not finish');
}

async function checkRender({user, other, source, clip, settings, kind, temp}) {
  const start = await json(await user.post('/api/' + kind, {sourceId:source.id, clip, settings}));
  assert.ok(start.jobId);
  const statePath = '/api/jobs/' + start.jobId;
  const deniedJob = await other.request(statePath);
  assert.ok([401,403,404].includes(deniedJob.status), 'Other sessions cannot read the job.');
  const deadline = Date.now() + 240000;
  let state;
  do {
    state = await json(await user.request(statePath));
    assert.notEqual(state.status, 'failed', state.error || 'Rendering failed.');
    assert.ok(['queued','running','done'].includes(state.status), 'Unexpected job state ' + state.status);
    if (state.status === 'done') break;
    await delay(350);
  } while (Date.now() < deadline);
  assert.equal(state.status, 'done', 'Rendering took too long.');
  assert.ok(state.url);
  const deniedFile = await other.request(state.url);
  assert.ok([401,403,404].includes(deniedFile.status), 'Other sessions cannot read the rendered file.');
  const range = await user.request(state.url, {headers:{Range:'bytes=0-31'}});
  assert.equal(range.status, 206);
  assert.match(range.headers.get('Content-Range'), /^bytes 0-31\/\d+$/);
  assert.equal((await range.arrayBuffer()).byteLength, 32);
  const response = await user.request(state.url);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('Content-Type'), /video\/mp4/);
  const file = path.join(temp, kind + '.mp4');
  await writeFile(file, new Uint8Array(await response.arrayBuffer()));
  const {stdout} = await run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]);
  const media = JSON.parse(stdout);
  const video = media.streams.find(stream => stream.codec_type === 'video');
  const audio = media.streams.find(stream => stream.codec_type === 'audio');
  assert.equal(video.codec_name, 'h264');
  assert.equal(audio.codec_name, 'aac');
  assert.equal(video.width, kind === 'preview' ? 540 : 1080);
  assert.equal(video.height, kind === 'preview' ? 960 : 1920);
  const expected = clip.segments.reduce((seconds, {start, end}) => seconds + end - start, 0);
  const sourceSpan = clip.segments.at(-1).end - clip.segments[0].start;
  assert.ok(sourceSpan - expected > 1, 'The fixture includes a real internal jump cut.');
  assert.ok(Math.abs(Number(media.format.duration) - expected) < 0.25,
    'Output length ' + media.format.duration + ' should match ' + expected + ' seconds of kept speech.');
}

test('production HTTP ingestion, OpenRouter fallback, private previews and final MP4', {timeout:600000}, async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'supoclip-http-'));
  const trace = path.join(temp, 'model-calls.jsonl');
  let server, fixture;
  try {
    await mkdir(path.join(temp, 'work'));
    const video = await createVideo(temp);
    fixture = await recordingFixture(temp,video,testTranscript());
    const running = server = await startServer(temp,trace,fixture.env);
    const user = session(running.base);
    const other = session(running.base);
    const invalid = await user.post('/api/analyze-url', {url:'https://example.com/not-a-platform'});
    assert.ok(invalid.status >= 400 && invalid.status < 500, 'An unsupported platform is rejected.');

    const demo = await json(await other.post('/api/demo', {}));
    assert.ok(demo.source.id && demo.clips.length >= 3);
    assert.ok(other.cookie);
    const form = new FormData();
    form.set('video', new Blob([await readFile(video)], {type:'video/mp4'}), 'rhythm.mp4');
    form.set('transcript', testTranscript());
    const {source} = await json(await user.request('/api/upload', {method:'POST', body:form}));
    assert.ok(user.cookie && user.cookie !== other.cookie);
    assert.equal(source.provider, 'Local');
    assert.ok(Math.abs(source.duration - 102) < 0.5);
    assert.equal(source.cueCount, 39);
    const auth = {Authorization:'Bearer sk-or-v1-' + 'f'.repeat(64)};
    const request = {sourceId:source.id, model:primaryModel};
    const denied = await other.post('/api/generate-clips', request, auth);
    assert.ok([401,403,404].includes(denied.status));
    const uploaded = await generate(user, other, request, auth);
    assert.equal(uploaded.clips.length, 3);
    const callsBefore = await readFile(trace, "utf8");
    assert.equal((await json(await user.post('/api/generate-clips', request, auth))).clips.length, 3);
    assert.equal(await readFile(trace, "utf8"), callsBefore, "Finished analysis reuses validated hook windows");
    const analyzed = await json(await user.post('/api/analyze-url', {url:fixture.input}));
    assert.equal(analyzed.source.provider,'YouTube');
    assert.equal(analyzed.source.cueCount,39);
    assert.equal(analyzed.transcript.length,39);
    assert.ok(fixture.requests.includes('captions.srt'));
    assert.ok(!fixture.requests.some(f => f.endsWith('.ts')), 'Analyze did not download media');
    const {clips} = await generate(user, other, {sourceId:analyzed.source.id}, auth);
    assert.equal(clips.length, 3);
    const calls = (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.ok(calls[0].model === primaryModel && calls.some(call => call.model === 'openrouter/free'));
    assert.ok(calls.every(call => call.authorized));
    const clip = clips[0];
    assert.ok(clip.captions.length > 0 && clip.segments.length >= 2 && clip.hookTitle);
    t.diagnostic('Two isolated sessions, local metadata/subtitles, demo, and OpenRouter fallback verified.');
    for (const [kind, mode] of [['preview', 'split'], ['render-clip', 'smart']]) {
      const settings = {mode, facecam:{x:0.02,y:0.03,w:0.34,h:0.34}, pan:0.65, captionStyle:'neon', hook:true};
      const before=fixture.requests.filter(f=>f.endsWith('.ts')).length;
      await checkRender({user, other, source:analyzed.source, clip, kind, settings, temp});
      const after=fixture.requests.filter(f=>f.endsWith('.ts')).length;
      if(kind==='preview')assert.ok(after>before,'Preview fetched selected remote sections');
      else assert.equal(after,before,'Full export reused preview source slices');
      t.diagnostic(kind + ' verified for ' + mode + ' framing, H.264/AAC, jump-cut duration and private range downloads.');
    }
    const fragments=new Set(fixture.requests.filter(f=>f.endsWith('.ts')));
    assert.ok(fragments.size>0 && fragments.size<30, 'Fetched only the selected part of a 51-fragment VOD.');
    t.diagnostic('URL metadata, 39 subtitle cues, bounded HLS section transfer, and cached sections verified.');
    await makeLongRecording(temp);
    const archive = await json(await user.post('/api/analyze-url', {url:LONG_URL}));
    assert.equal(archive.source.duration, 7200);
    assert.equal(archive.source.cueCount, 0);
    assert.equal(fixture.ranges.length, 0, 'Metadata discovery transferred zero audio or video bytes.');
    const result = await generate(user, other, {sourceId: archive.source.id}, auth);
    assert.equal(result.clips.length, 3);
    const last = result.clips.find(c => c.segments[0].start >= 7100);
    assert.ok(last, 'Recognized the final spoken passage after 119 minutes');
    assert.ok(result.clips.some(c => c.segments[0].start >= 3590 && c.segments[0].start < 3650));
    assert.ok(result.clips.every(c => c.captions.some(cap => cap.words?.length)));
    assert.ok(fixture.ranges.some(r => r.file === 'long-audio.m4a' && r.first > 100000));
    assert.ok(!fixture.ranges.some(r => r.file === 'long-video.mp4'), 'Transcription fetched audio renditions only.');
    const start = last.segments[0].start;
    const trimmed = {...last, segments: [{start, end:start+1.5}, {start:start+4, end:start+5.5}]};
    await checkRender({user, other, source: archive.source, clip: trimmed, kind:'render-clip', temp,
      settings:{mode:'speaker', facecam:{x:0,y:0,w:.3,h:.4}, pan:.5, captionStyle:'yellow', hook:true}});
    assert.ok(fixture.ranges.some(r => r.file === 'long-video.mp4' && r.first > 100000));
    t.diagnostic('Two-hour /live/ VOD: all audio chunks, real INT8 speech and word timings across both hours, late-range MP4 export.');

  } finally {
    if(fixture) await fixture.stop();
    try { if (server) await server.stop(); }
    finally { await rm(temp, {recursive:true,force:true}); }
  }
});
