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
  writeJson(transcriptPath, [
    { text: "普", start: 0.5, end: 0.7 },
    { text: "通", start: 0.7, end: 0.9 },
    { text: "字", start: 0.9, end: 1.1 },
    { text: "幕", start: 1.1, end: 1.3 },
  ]);
  fs.writeFileSync(subtitlePath, "1\n00:00:00,500 --> 00:00:01,500\n普通字幕验证\n", "utf8");
  saveEffects(effectsPath, [{
    effect_type: "large_bright",
    start_word_index: 2,
    end_word_index: 3,
    source: "human",
  }]);
  const overlays = defaultOverlays();
  overlays.captions.enabled = true;
  saveOverlays(overlaysPath, overlays);
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
  const assPath = path.join(tempDir, "render-captions.ass");
  assert.ok(fs.existsSync(assPath));
  const ass = fs.readFileSync(assPath, "utf8");
  assert.match(ass, /\\fs\d+\\c&H008AF0FF/);
  assert.match(ass, /字幕/);
  assert.match(fs.readFileSync(path.join(tempDir, "render-filter.txt"), "utf8"), /ass=filename='render-captions\.ass'/);

  const before = brightPixels(outputPath, 0.2);
  const during = brightPixels(outputPath, 1.0);
  assert.ok(during > before + 20, `字幕期间亮像素没有显著增加 before=${before} during=${during}`);
  passed = true;
  process.stdout.write(`wanggan subtitle render passed before=${before} during=${during}\n`);
} finally {
  if (passed) fs.rmSync(tempDir, { recursive: true, force: true });
  else process.stderr.write(`failed subtitle render kept at ${tempDir}\n`);
}
