import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CLIP_MODEL, generateClips } from "../server/brain";

interface Prompt {
  model: string;
  messages: { content: string }[];
}
type Row = [number, number, number, string];
function answer(req: Prompt) {
  const { cues } = JSON.parse(req.messages[1].content) as { cues: Row[] };
  const proposals = [];
  for (let i = 0; i + 11 < cues.length && proposals.length < 6; i += 13) {
    const part = cues.slice(i, i + 12);
    if (part[11][0] - part[0][0] !== 11) continue;
    proposals.push({
      title: "Hook " + part[0][0],
      hookTitle: "Watch the reveal",
      reason: "A setup followed by a timed reaction.",
      viralityScore: 90,
      segments: [{ firstCue: part[0][0], lastCue: part[11][0] }],
      hypeCueIds: [part[10][0]],
    });
  }
  return Response.json({
    choices: [
      {
        message: { content: "```json\n" + JSON.stringify(proposals) + "\n```" },
      },
    ],
  });
}
const source = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    start: i * 2 + Math.floor(i / 6) * 1.2,
    end: i * 2 + Math.floor(i / 6) * 1.2 + 2,
    text: "The moment we found it",
  }));
test("primary failure retries once, preserves timestamps and closes internal pauses", async (t) => {
  const cues = source(52);
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(new Headers(init.headers).get("Authorization"), "Bearer test");
    const req = JSON.parse(String(init.body)) as Prompt;
    calls.push(req.model);
    return calls.length === 1
      ? Response.json({ error: "rate limited" }, { status: 429 })
      : answer(req);
  });
  const clips = await generateClips({ cues, duration: 120, key: "test" });
  assert.deepEqual(calls, [DEFAULT_CLIP_MODEL, "openrouter/free"]);
  assert.equal(clips.length, 4);
  assert.ok(
    clips.every(
      (c) =>
        c.segments.length >= 2 &&
        c.captions.every((cap) => cap.text === "The moment we found it"),
    ),
  );
});
test("ten hours of cues are all covered by bounded model requests", async (t) => {
  const cues = source(17000).filter((c) => c.end <= 36000);
  const covered = new Set<number>();
  const starts: number[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: string, init: RequestInit) => {
      const req = JSON.parse(String(init.body)) as Prompt;
      const chunk = JSON.parse(req.messages[1].content);
      starts.push(chunk.window.start);
      chunk.cues.forEach((row: Row) => covered.add(row[0]));
      assert.ok(req.messages[1].content.length < 25100);
      return answer(req);
    },
  );
  const clips = await generateClips({ cues, duration: 36000, key: "test" });
  assert.ok(starts.length > 12 && Math.max(...starts) > 34000);
  assert.equal(covered.size, cues.length);
  assert.equal(clips.length, 6);
});
test("unusable model JSON fails cleanly after the single fallback", async (t) => {
  let attempts = 0;
  t.mock.method(globalThis, "fetch", async () => {
    attempts++;
    return Response.json({ choices: [{ message: { content: "invalid" } }] });
  });
  await assert.rejects(
    generateClips({ cues: source(48), duration: 120, key: "test" }),
    /malformed JSON/,
  );
  assert.equal(attempts, 2);
});
