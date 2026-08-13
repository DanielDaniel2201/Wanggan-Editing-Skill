import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { writeJson } from "./lib/core.mjs";
import { loadProfile, writeProfileLock } from "./lib/profile-loader.mjs";
import { emptyComposition, saveComposition } from "./lib/composition.mjs";
import { loadProjectRecord } from "./lib/project.mjs";
import { renderProject } from "./lib/render.mjs";
import { parseSrt } from "./lib/srt.mjs";
import { alignCuesToWords } from "./lib/timeline.mjs";
import { loadTranscript } from "./lib/core.mjs";

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
    "-v", "error", "-ss", String(time), "-i", videoPath,
    "-frames:v", "1", "-vf", "format=gray", "-f", "rawvideo", "pipe:1",
  ], { encoding: null });
  let count = 0;
  for (const value of result.stdout) {
    if (value > 120) count += 1;
  }
  return count;
}

function subtitleColorPixels(videoPath, time) {
  const result = run("ffmpeg", [
    "-v", "error", "-ss", String(time), "-i", videoPath,
    "-frames:v", "1", "-vf", "format=rgb24", "-f", "rawvideo", "pipe:1",
  ], { encoding: null });
  let white = 0;
  let yellow = 0;
  for (let index = 0; index < result.stdout.length; index += 3) {
    const red = result.stdout[index];
    const green = result.stdout[index + 1];
    const blue = result.stdout[index + 2];
    if (red >= 245 && green >= 245 && blue >= 245) white += 1;
    if (red >= 245 && green >= 225 && blue >= 110 && blue <= 170) yellow += 1;
  }
  return { white, yellow };
}

function redPixels(videoPath, time) {
  const result = run("ffmpeg", [
    "-v", "error", "-ss", String(time), "-i", videoPath,
    "-frames:v", "1", "-vf", "format=rgb24", "-f", "rawvideo", "pipe:1",
  ], { encoding: null });
  let count = 0;
  for (let index = 0; index < result.stdout.length; index += 3) {
    if (result.stdout[index] >= 180 && result.stdout[index + 1] <= 90 && result.stdout[index + 2] <= 90) count += 1;
  }
  return count;
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wanggan-caption-render-"));
let passed = false;
try {
  const videoPath = path.join(tempDir, "input.mp4");
  const transcriptPath = path.join(tempDir, "words.json");
  const subtitlePath = path.join(tempDir, "input.srt");
  const imagePath = path.join(tempDir, "wide-overlay.png");
  run("ffmpeg", [
    "-y", "-v", "error",
    "-f", "lavfi", "-i", "color=c=black:s=360x640:r=25:d=3",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
    videoPath,
  ]);
  run("ffmpeg", [
    "-y", "-v", "error",
    "-f", "lavfi", "-i", "color=c=red:s=1000x100:d=0.04",
    "-frames:v", "1",
    imagePath,
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
  fs.writeFileSync(subtitlePath, "1\n00:00:00,500 --> 00:00:02,100\n普通字幕继续\n", "utf8");
  const words = loadTranscript(transcriptPath);
  const cues = alignCuesToWords(parseSrt(fs.readFileSync(subtitlePath, "utf8"), { duration: 3 }), words);
  const profile = await loadProfile(path.join(
    fileURLToPath(new URL(".", import.meta.url)),
    "fixtures/profiles/test-ip",
  ));
  writeJson(path.join(tempDir, "project.json"), {
    version: 3,
    created_at: new Date().toISOString(),
    inputs: {
      video: { path: videoPath },
      words: { path: transcriptPath },
      captions: { path: subtitlePath, cues },
    },
    profile: { id: profile.id, path: profile.dir, lock_file: "profile-lock.json" },
    composition_file: "composition.json",
    editor_state_file: "editor-state.json",
    render_status_file: "render-status.json",
    output_path: path.join(tempDir, "output.mp4"),
    previewVideoPath: videoPath,
    duration: 3,
    displayWidth: 360,
    displayHeight: 640,
  });
  writeJson(path.join(tempDir, "editor-state.json"), { version: 1, savedAt: null, currentTime: 0, selectedWordIndexes: [] });
  writeJson(path.join(tempDir, "render-status.json"), { state: "idle" });
  const record = loadProjectRecord(tempDir);
  const composition = emptyComposition(profile);
  const captions = composition.assets.find((asset) => asset.id === "captions.main");
  captions.enabled = true;
  captions.props.cue_overrides = { "caption-001": { font_family: "华文中宋" } };
  composition.assets.push({
    id: "keywords.001",
    type: "base.keywords",
    enabled: true,
    source: { kind: "agent-generated" },
    lifecycle: { kind: "word_range", start_word_index: 0, end_word_index: 3 },
    props: {
      layout: "auto",
      items: [
        { start_word_index: 0, end_word_index: 1, display_text: "普通人" },
        { start_word_index: 2, end_word_index: 3, display_text: "做字幕" },
      ],
    },
    origin: { created_by: "agent", human_modified: false },
  });
  composition.assets.push({
    id: "image.001",
    type: "base.image",
    enabled: true,
    source: { kind: "agent-generated" },
    lifecycle: { kind: "word_range", start_word_index: 4, end_word_index: 5 },
    props: {
      image_path: imagePath,
      fit: "contain",
      box: { x: 0.58, y: 0.08, width: 0.34, height: 0.28, unit: "ratio" },
    },
    origin: { created_by: "agent", human_modified: false },
  });
  composition.effects.push(
    {
      id: "effect.001",
      type: "base.text-style",
      target: { asset_id: "captions.main" },
      timing: { kind: "word_range", start_word_index: 5, end_word_index: 5 },
      config: { font_scale: 1.25, color: "#FFF08A" },
      origin: { created_by: "human", human_modified: false },
    },
    {
      id: "effect.002",
      type: "base.progressive-reveal",
      target: { asset_id: "keywords.001" },
      timing: { kind: "asset_items" },
      config: { retain_until: "asset_end" },
      origin: { created_by: "agent", human_modified: false },
    },
    {
      id: "effect.003",
      type: "base.pop",
      target: { asset_id: "keywords.001" },
      timing: { kind: "item_enter" },
      config: {},
      origin: { created_by: "agent", human_modified: false },
    },
    {
      id: "effect.004",
      type: "base.scale",
      target: { asset_id: "image.001" },
      timing: { kind: "word_range", start_word_index: 4, end_word_index: 5 },
      config: { from_scale: 1, to_scale: 1.2, interpolation: "step", underflow_fill: "black" },
      origin: { created_by: "agent", human_modified: false },
    },
    {
      id: "effect.005",
      type: "test-ip.fade",
      target: { asset_id: "image.001" },
      timing: { kind: "word_range", start_word_index: 4, end_word_index: 5 },
      config: { from_opacity: 1, to_opacity: 0.35, interpolation: "linear" },
      origin: { created_by: "agent", human_modified: false },
    },
  );
  saveComposition(record.compositionPath, composition, profile, words, record);
  writeProfileLock(record.profileLockPath, profile);
  const result = await renderProject(record);
  assert.equal(result.state, "complete");
  assert.equal(result.captions.enabled, true);
  assert.equal(result.captions.source, "srt");
  assert.equal(result.captions.cueCount, 1);
  assert.equal(result.structuredOverlays.enabled, true);
  assert.equal(result.structuredOverlays.groupCount, 1);
  assert.equal(result.imageOverlays.enabled, true);
  assert.equal(result.imageOverlays.count, 1);
  const ass = fs.readFileSync(path.join(tempDir, "render-overlays.ass"), "utf8");
  assert.match(ass, /YCbCr Matrix: None/);
  assert.match(ass, /Style: Default,[^\n]*,1,0,2,0,0,0,1/);
  assert.match(ass, /\\bord1/);
  assert.match(ass, /\\fs\d+\\c&H008AF0FF/);
  assert.match(ass, /Style: Default,Microsoft YaHei/);
  assert.match(ass, /Dialogue: 0[^\n]*\\fn华文中宋/);
  assert.match(ass, /Dialogue: 10[^\n]*\\fnMicrosoft YaHei/);
  assert.doesNotMatch(ass, /Noto Sans SC/);
  assert.match(ass, /字幕/);
  assert.match(ass, /普通人/);
  assert.match(ass, /做字幕/);
  assert.match(ass, /\\fscx85\\fscy85/);
  assert.match(ass, /\\alpha&HFF&\\t\(0,180,\\fscx100\\fscy100\\alpha&H00&\)/);
  assert.doesNotMatch(ass, /Dialogue: 0[^\n]*普通/);
  const renderFilter = fs.readFileSync(path.join(tempDir, "render-filter.txt"), "utf8");
  assert.match(renderFilter, /force_original_aspect_ratio=decrease/);
  assert.match(renderFilter, /eval=frame/);
  assert.match(renderFilter, /geq=.*alpha\(X,Y\)/);
  assert.match(renderFilter, /enable='gte\(t,1\.5\)\*lt\(t,1\.9\)'/);
  assert.match(renderFilter, /ass=filename='render-overlays\.ass'/);

  const before = brightPixels(path.join(tempDir, "output.mp4"), 0.2);
  const duringKeywords = brightPixels(path.join(tempDir, "output.mp4"), 0.7);
  const during = brightPixels(path.join(tempDir, "output.mp4"), 1.7);
  assert.ok(duringKeywords > before + 20, `关键词期间亮像素没有显著增加 before=${before} duringKeywords=${duringKeywords}`);
  assert.ok(during > before + 20, `字幕期间亮像素没有显著增加 before=${before} during=${during}`);
  const keywordColors = subtitleColorPixels(path.join(tempDir, "output.mp4"), 0.7);
  const captionColors = subtitleColorPixels(path.join(tempDir, "output.mp4"), 1.7);
  const beforeImageRed = redPixels(path.join(tempDir, "output.mp4"), 1.3);
  const earlyImageRed = redPixels(path.join(tempDir, "output.mp4"), 1.52);
  const duringImageRed = redPixels(path.join(tempDir, "output.mp4"), 1.7);
  const lateImageRed = redPixels(path.join(tempDir, "output.mp4"), 1.86);
  assert.ok(keywordColors.yellow > 20, `关键词没有保留接近 #FFF08A 的亮黄色像素 yellow=${keywordColors.yellow}`);
  assert.ok(captionColors.white > 20, `字幕没有保留接近 #FFFFFF 的白色像素 white=${captionColors.white}`);
  assert.ok(
    earlyImageRed > beforeImageRed + 500,
    `缩放贴图出现期间红色像素没有显著增加 before=${beforeImageRed} early=${earlyImageRed}`,
  );
  assert.ok(lateImageRed < earlyImageRed / 2, `自定义淡出没有降低贴图像素 early=${earlyImageRed} late=${lateImageRed}`);
  passed = true;
  process.stdout.write(`wanggan subtitle render passed before=${before} during=${during}\n`);
} finally {
  if (passed) fs.rmSync(tempDir, { recursive: true, force: true });
  else process.stderr.write(`failed subtitle render kept at ${tempDir}\n`);
}
