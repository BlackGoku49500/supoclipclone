import type {Cue} from "./types";

function transcriptSeconds(stamp: string): number {
  return stamp.replace(",", ".").split(":").reduce((total, field) => total * 60 + Number(field), 0);
}

const cueEntities: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };

function cleanCueText(value: string): string {
  return value.replace(/<\/?(?:i|b|u|font|c|v|ruby|rt)(?:\s[^>]*)?>/gi, "")
    .replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (entity) => cueEntities[entity] || entity)
    .replace(/\s+/g, " ").trim();
}

/** Accepts SRT, timestamped YouTube transcripts, or untimed text. All times are absolute seconds. */
export function parseTranscript(raw: string, duration: number): Cue[] {
  const text = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim();
  if (!text || !Number.isFinite(duration) || duration <= 0) return [];
  const stamp = "(?:\\d+:)?\\d{1,3}:[0-5]\\d(?:[.,]\\d{1,3})?";
  const timeline = new RegExp("^\\s*(" + stamp + ")\\s*-->\\s*(" + stamp + ")[^\\n]*$", "gm");
  const ranges = Array.from(text.matchAll(timeline));
  if (ranges.length) {
    return ranges.map((match, index) => ({
      start: Math.min(duration, transcriptSeconds(match[1])),
      end: Math.min(duration, transcriptSeconds(match[2])),
      text: cleanCueText(text.slice(match.index! + match[0].length, ranges[index + 1]?.index ?? text.length)
        .replace(/\n\s*\d+\s*$/, "")),
    })).filter(cue => cue.text && cue.end > cue.start).sort((a, b) => a.start - b.start);
  }

  const markers = Array.from(text.matchAll(new RegExp(
    "(?:^|[\\s(\\[])(" + stamp + ")(?:[)\\]])?(?=\\s|$|[-–—])", "g"
  )));
  if (markers.length) {
    const stamped = markers.map((match, index) => ({
      start: transcriptSeconds(match[1]),
      text: cleanCueText(text.slice(match.index! + match[0].length, markers[index + 1]?.index ?? text.length)
        .replace(/^\s*[-–—]\s*/, "")),
    })).filter(cue => cue.text && cue.start < duration).sort((a, b) => a.start - b.start);
    const merged: { start: number; text: string }[] = [];
    for (const cue of stamped) {
      const last = merged[merged.length - 1];
      if (last && last.start === cue.start) last.text += " " + cue.text;
      else merged.push(cue);
    }
    return merged.map((cue, index) => ({ ...cue, end: merged[index + 1]?.start ?? duration }));
  }

  const words = cleanCueText(text).split(/\s+/).filter(Boolean);
  const cues: Cue[] = [];
  for (let i = 0; i < words.length; i += 8) {
    const next = Math.min(i + 8, words.length);
    cues.push({ start: duration * i / words.length, end: duration * next / words.length, text: words.slice(i, next).join(" ") });
  }
  return cues;
}
