import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { saveEffects, writeJson } from "./lib/core.mjs";
import { defaultOverlays, saveOverlays } from "./lib/captions.mjs";
import { renderProject } from "./lib/render.mjs";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: Object.hasOwn(options, "encoding") ? options.encoding : "utf8",
    windowsHide: true,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`${command} failed\n${result.stderr || result.stdout}`);
  }
  return result;
}

function brightPixels(videoPath, time) {
  const result = run("ffmpeg", [
    "-v", "error",
    "-ss", String(time),
    "-i", videoPath,
    "-frames:v", "1",
    "-vf", "format=gray",
    "-f", "rawvideo",
    "pipe:1",
  ], { encoding: null });
  let count = 0;
  for (const value of result.stdout) {
    if (value > 120) count += 1;
  }
  return count;
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wanggan-caption-render-"));
let passed = false;
try {
  const videoPath = path.join(tempDir, "input.mp4");
  const transcriptPath = path.join(tempDir, "words.json");
  const subtitlePath = path.join(tempDir, "input.srt");
  const effectsPath = path.join(tempDir, "effects.json");
  const overlaysPath = path.join(tempDir, "overlays.json");
  const renderStatusPath = path.join(tempDir, "render-status.json");
  const outputPath = path.join(tempDir, "output.mp4");

  run("ffmpeg", [
    "-y", "-v", "error",
    "-f", "lavfi",
    "-i", "color=c=black:s=360x640:r=25:d=3",
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    videoPath,
  ]);
  const transcriptWords = [
    { text: "普", start: 0.5, end: 0.7 },
    { text: "通", start: 0.7, end: 0.9 },
    { text: "字", start: 0.9, end: 1.1 },
    { text: "幕", start: 1.1, end: 1.3 },
    { text: "继", start: 1.5, end: 1.7 },
    { text: "续", start: 1.7, end: 1.9 },
  ];
  writeJson(transcriptPath, transcriptWords);
  fs.writeFileSync(subtitlePath, "1\n00:00:00,500 --> 00:00:02,100\n普通字幕验证继续\n", "utf8");
  saveEffects(effectsPath, [{
    effect_type: "large_bright",
    start_word_index: 4,
    end_word_index: 5,
    source: "human",
  }]);
  const overlays = defaultOverlays();
  overlays.captions.enabled = true;
  overlays.captions.cue_fonts = { "caption-001": "华文中宋" };
  overlays.timed_overlays = [{
    id: "overlay-keywords-render",
    type: "progressive_keywords",
    layout: "auto",
    enter_animation: "pop",
    items: [
      {
        start_word_index: 0,
        end_word_index: 1,
        display_text: "普通人",
      },
      {
        start_word_index: 2,
        end_word_index: 3,
        display_text: "做字幕",
      },
    ],
    source: "ai",
  }];
  saveOverlays(overlaysPath, overlays, transcriptWords);
  writeJson(renderStatusPath, { state: "idle" });

  const project = {
    projectDir: tempDir,
    videoPath,
    transcriptPath,
    subtitlePath,
    effectsPath,
    overlaysPath,
    renderStatusPath,
    outputPath,
    duration: 3,
    displayWidth: 360,
    displayHeight: 640,
  };
  const result = await renderProject(project);
  assert.equal(result.state, "complete");
  assert.equal(result.captions.enabled, true);
  assert.equal(result.captions.source, "srt");
  assert.equal(result.captions.cueCount, 1);
  assert.equal(result.structuredOverlays.enabled, true);
  assert.equal(result.structuredOverlays.groupCount, 1);
  const assPath = path.join(tempDir, "render-overlays.ass");
  assert.ok(fs.existsSync(assPath));
  const ass = fs.readFileSync(assPath, "utf8");
  assert.match(ass, /\\fs\d+\\c&H008AF0FF/);
  assert.match(ass, /Style: Default,Microsoft YaHei/);
  assert.match(ass, /Dialogue: 0[^\n]*\\fn华文中宋/);
  assert.match(ass, /Dialogue: 10[^\n]*\\fnMicrosoft YaHei/);
  assert.doesNotMatch(ass, /Noto Sans SC/);
  assert.match(ass, /字幕/);
  assert.match(ass, /Dialogue: 10/);
  assert.match(ass, /普通人/);
  assert.match(ass, /做字幕/);
  assert.match(ass, /\\fad\(/);
  assert.match(ass, /\\fscx85\\fscy85/);
  assert.doesNotMatch(ass, /Dialogue: 0[^\n]*普通/);
  assert.match(fs.readFileSync(path.join(tempDir, "render-filter.txt"), "utf8"), /ass=filename='render-overlays\.ass'/);

  const before = brightPixels(outputPath, 0.2);
  const duringKeywords = brightPixels(outputPath, 0.7);
  const during = brightPixels(outputPath, 1.7);
  assert.ok(duringKeywords > before + 20, `关键词期间亮像素没有显著增加 before=${before} duringKeywords=${duringKeywords}`);
  assert.ok(during > before + 20, `字幕期间亮像素没有显著增加 before=${before} during=${during}`);
  passed = true;
  process.stdout.write(`wanggan subtitle render passed before=${before} during=${during}\n`);
} finally {
  if (passed) fs.rmSync(tempDir, { recursive: true, force: true });
  else process.stderr.write(`failed subtitle render kept at ${tempDir}\n`);
}
