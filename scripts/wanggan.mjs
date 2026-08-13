#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  WangganError,
  defaultEditorState,
  loadTranscript,
  readJson,
  writeJson,
} from "./lib/core.mjs";
import { loadAjvModules } from "./lib/schema.mjs";
import { parseSrt } from "./lib/srt.mjs";
import { alignCuesToWords } from "./lib/timeline.mjs";
import { loadProfile, writeProfileLock } from "./lib/profile-loader.mjs";
import {
  emptyComposition,
  importCompositionFragment,
  loadComposition,
  saveComposition,
} from "./lib/composition.mjs";
import { loadProjectContext, loadProjectRecord } from "./lib/project.mjs";
import { commandAvailable, ensurePreview, probeMedia, renderProject } from "./lib/render.mjs";
import { compileProject } from "./lib/compiler.mjs";
import { startServer } from "./server.mjs";

function parseFlags(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new WangganError(`无法识别参数：${token}`);
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) flags[key] = true;
    else {
      flags[key] = next;
      index += 1;
    }
  }
  return flags;
}

function parseArgs(argv) {
  const command = argv[0] || "help";
  if (command === "profile" && argv[1] && !argv[1].startsWith("--")) {
    return { command: `profile ${argv[1]}`, flags: parseFlags(argv.slice(2)) };
  }
  return { command, flags: parseFlags(argv.slice(1)) };
}

function required(flags, key) {
  if (!flags[key] || flags[key] === true) throw new WangganError(`缺少 --${key} 参数`);
  return flags[key];
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function ensureFile(filePath, label) {
  const absolute = path.resolve(filePath);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    throw new WangganError(`找不到${label}：${absolute}`);
  }
  return absolute;
}

function help() {
  process.stdout.write(`网感剪辑\n\n`);
  process.stdout.write(`命令\n`);
  process.stdout.write(`  doctor\n`);
  process.stdout.write(`  init --video <path> --words <path> --srt <path> --profile base --project <dir>\n`);
  process.stdout.write(`  import --project <dir> --input <composition.json>\n`);
  process.stdout.write(`  validate --project <dir>\n`);
  process.stdout.write(`  status --project <dir>\n`);
  process.stdout.write(`  serve --project <dir> [--port 8911]\n`);
  process.stdout.write(`  render --project <dir> [--output <path>]\n`);
  process.stdout.write(`  profile sync --project <dir>\n`);
}

async function doctor() {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const ffmpeg = commandAvailable("ffmpeg");
  const ffprobe = commandAvailable("ffprobe");
  const ajv = await loadAjvModules();
  const result = {
    ok: nodeMajor >= 18 && ffmpeg.ok && ffprobe.ok && ajv.ok,
    node: process.version,
    nodeSupported: nodeMajor >= 18,
    ffmpeg: ffmpeg.ok ? ffmpeg.output.split(/\r?\n/)[0] : "missing",
    ffprobe: ffprobe.ok ? ffprobe.output.split(/\r?\n/)[0] : "missing",
    ajv: ajv.ok ? "ok" : ajv.error,
    ajvHint: ajv.ok ? null : ajv.hint,
  };
  print(result);
  if (!result.ok) process.exitCode = 1;
}

async function initProject(flags) {
  const videoPath = ensureFile(required(flags, "video"), "视频");
  const wordsPath = ensureFile(required(flags, "words"), "逐字稿");
  const srtPath = ensureFile(required(flags, "srt"), "SRT");
  const profileInput = required(flags, "profile");
  const projectDir = path.resolve(required(flags, "project"));
  const projectPath = path.join(projectDir, "project.json");
  if (fs.existsSync(projectPath)) {
    throw new WangganError("任务目录已经包含 project.json，不会覆盖", { projectPath }, 409);
  }
  const profile = await loadProfile(profileInput, { allowProfileCode: Boolean(flags["allow-profile-code"]) });
  const words = loadTranscript(wordsPath);
  const media = probeMedia(videoPath);
  if (words.at(-1).end > media.duration + 0.2) {
    throw new WangganError("逐字稿结束时间超过视频时长", {
      transcriptEnd: words.at(-1).end,
      videoDuration: media.duration,
    });
  }
  const srtText = fs.readFileSync(srtPath);
  if (srtText.includes(0)) {
    // keep binary check light; UTF-8 decode below
  }
  const cues = alignCuesToWords(parseSrt(srtText.toString("utf8"), { duration: media.duration }), words);
  fs.mkdirSync(projectDir, { recursive: true });
  const previewCandidate = path.join(projectDir, "preview.mp4");
  const previewVideoPath = await ensurePreview(videoPath, media, previewCandidate);
  const baseName = path.basename(videoPath, path.extname(videoPath));
  const project = {
    version: 3,
    created_at: new Date().toISOString(),
    inputs: {
      video: { path: videoPath },
      words: { path: wordsPath },
      captions: {
        path: srtPath,
        cues: cues.map((cue) => ({
          id: cue.id,
          start: cue.start,
          end: cue.end,
          text: cue.text,
          start_word_index: cue.start_word_index,
          end_word_index: cue.end_word_index,
        })),
      },
    },
    profile: {
      id: profile.id,
      path: profile.dir,
      lock_file: "profile-lock.json",
    },
    composition_file: "composition.json",
    editor_state_file: "editor-state.json",
    render_status_file: "render-status.json",
    output_path: path.join(projectDir, `${baseName}-wanggan.mp4`),
    previewVideoPath,
    duration: media.duration,
    displayWidth: media.displayWidth,
    displayHeight: media.displayHeight,
    sourceMedia: media,
  };
  writeJson(projectPath, project);
  const record = loadProjectRecord(projectDir);
  const composition = emptyComposition(profile);
  saveComposition(record.compositionPath, composition, profile, words, record);
  writeProfileLock(record.profileLockPath, profile);
  writeJson(record.editorStatePath, defaultEditorState());
  writeJson(record.renderStatusPath, { state: "idle" });
  print({
    ok: true,
    projectPath,
    wordCount: words.length,
    cueCount: cues.length,
    profile: { id: profile.id, version: profile.version, digest: profile.digest },
    media,
    previewVideoPath,
    outputPath: project.output_path,
  });
}

async function importComposition(flags) {
  const context = await loadProjectContext(required(flags, "project"), {
    allowProfileCode: Boolean(flags["allow-profile-code"]),
  });
  const inputPath = ensureFile(required(flags, "input"), "Composition 文件");
  const current = loadComposition(context.project.compositionPath, context.profile, context.words, context.project);
  const next = importCompositionFragment(current, readJson(inputPath), context.profile, context.words, context.project);
  saveComposition(context.project.compositionPath, next, context.profile, context.words, context.project);
  print({
    ok: true,
    assetCount: next.assets.length,
    effectCount: next.effects.length,
  });
}

async function validateProject(flags) {
  const ir = await compileProject(required(flags, "project"), {
    allowProfileCode: Boolean(flags["allow-profile-code"]),
  });
  print({
    ok: ir.profileLock.ok,
    profileLock: ir.profileLock,
    wordCount: ir.words.length,
    assetCount: ir.composition.assets.length,
    effectCount: ir.composition.effects.length,
    duration: ir.project.duration,
    outputPath: ir.project.outputPath,
    captions: ir.captionTrack,
    structuredOverlays: {
      enabled: ir.structuredOverlayTrack.enabled,
      groupCount: ir.structuredOverlayTrack.groupCount,
      stateCount: ir.playbackOverlays.length,
    },
    imageOverlays: {
      enabled: ir.imageOverlayTrack.enabled,
      count: ir.playbackImageOverlays.length,
    },
  });
  if (!ir.profileLock.ok) process.exitCode = 1;
}

async function statusProject(flags) {
  const ir = await compileProject(required(flags, "project"), {
    allowProfileCode: Boolean(flags["allow-profile-code"]),
  });
  print({
    project: {
      version: ir.project.version,
      videoPath: ir.project.videoPath,
      transcriptPath: ir.project.transcriptPath,
      subtitlePath: ir.project.subtitlePath,
      outputPath: ir.project.outputPath,
      duration: ir.project.duration,
      displayWidth: ir.project.displayWidth,
      displayHeight: ir.project.displayHeight,
    },
    profile: ir.profile,
    profileLock: ir.profileLock,
    words: ir.words,
    composition: ir.composition,
    captionTrack: ir.captionTrack,
    structuredOverlayTrack: ir.structuredOverlayTrack,
    imageOverlayTrack: ir.imageOverlayTrack,
    playbackOverlays: ir.playbackOverlays,
    playbackImageOverlays: ir.playbackImageOverlays,
  });
}

async function serve(flags) {
  const context = await loadProjectContext(required(flags, "project"), {
    allowProfileCode: Boolean(flags["allow-profile-code"]),
  });
  const result = await startServer(context, Number(flags.port || 8911));
  print({ ok: true, url: result.url, projectPath: context.project.projectPath });
  const close = () => result.server.close(() => process.exit(0));
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
}

async function render(flags) {
  const context = await loadProjectContext(required(flags, "project"), {
    allowProfileCode: Boolean(flags["allow-profile-code"]),
  });
  const result = await renderProject(context.project, {
    outputPath: flags.output,
    context,
  });
  print(result);
}

async function syncProfile(flags) {
  const context = await loadProjectContext(required(flags, "project"), {
    allowProfileCode: Boolean(flags["allow-profile-code"]),
    allowProfileMismatch: true,
  });
  loadComposition(context.project.compositionPath, context.profile, context.words, context.project);
  const lock = writeProfileLock(context.project.profileLockPath, context.profile);
  print({ ok: true, lock });
}

export async function main(argv = process.argv.slice(2)) {
  const { command, flags } = parseArgs(argv);
  switch (command) {
    case "help": help(); break;
    case "doctor": await doctor(); break;
    case "init": await initProject(flags); break;
    case "import": await importComposition(flags); break;
    case "validate": await validateProject(flags); break;
    case "status": await statusProject(flags); break;
    case "serve": await serve(flags); break;
    case "render": await render(flags); break;
    case "profile sync": await syncProfile(flags); break;
    default: throw new WangganError(`未知命令：${command}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ error: error.message, details: error.details || null }, null, 2)}\n`);
    process.exitCode = 1;
  });
}
