import { WangganError, roundTime } from "./core.mjs";

function parseSrtTime(value) {
  const match = /^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{3})$/.exec(value.trim());
  if (!match) return NaN;
  return roundTime(
    Number(match[1]) * 3600
    + Number(match[2]) * 60
    + Number(match[3])
    + Number(match[4]) / 1000,
  );
}

export function cleanCaptionText(text) {
  return String(text || "")
    .replace(/<[^>]*>/g, "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

export function parseSrt(text, options = {}) {
  const duration = Number(options.duration);
  const blocks = String(text || "").replace(/^\uFEFF/, "").trim().split(/\r?\n\s*\r?\n/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split(/\r?\n/).map((line) => line.trimEnd());
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) continue;
    const match = /^(\S+)\s+-->\s+(\S+)/.exec(lines[timingIndex].trim());
    if (!match) throw new WangganError("SRT 时间行无效", { line: lines[timingIndex] });
    const start = parseSrtTime(match[1]);
    const end = parseSrtTime(match[2]);
    const captionText = cleanCaptionText(lines.slice(timingIndex + 1).join("\n"));
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || !captionText) {
      throw new WangganError("SRT 字幕条目无效", { block });
    }
    cues.push({
      id: `caption-${String(cues.length + 1).padStart(3, "0")}`,
      start,
      end,
      text: captionText,
      source: "srt",
    });
  }
  if (!cues.length) throw new WangganError("SRT 没有可用字幕");
  for (let index = 0; index < cues.length; index += 1) {
    const cue = cues[index];
    if (index > 0 && cue.start < cues[index - 1].end) {
      throw new WangganError("SRT 字幕时间发生重叠", { previous: cues[index - 1], current: cue });
    }
    if (Number.isFinite(duration) && cue.end > duration + 0.2) {
      throw new WangganError("SRT 字幕结束时间超过视频时长", { cue, duration });
    }
  }
  return cues;
}
