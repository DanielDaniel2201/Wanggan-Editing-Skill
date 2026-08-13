#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  WangganError,
  defaultEditorState,
  loadEffects,
  loadProject,
  loadTranscript,
  projectState,
  readJson,
  resolveEffect,
  saveEffects,
  unwrapEffectsInput,
  validateEffects,
  writeJson,
} from "./lib/core.mjs";
import {
  commandAvailable,
  ensurePreview,
  probeMedia,
  renderProject,
} from "./lib/render.mjs";
import {
  compileCaptionTrack,
  compileScreenOverlays,
  defaultOverlays,
  loadOverlays,
  saveOverlays,
} from "./lib/captions.mjs";
import { startServer } from "./server.mjs";

function parseArgs(argv) {
  const command = argv[0] || "help";
  const flags = {};
  for (let index = 1; index < argv.length; index += 1) {
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
  return { command, flags };
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
  process.stdout.write(`网感剪辑 V2\n\n`);
  process.stdout.write(`命令\n`);
  process.stdout.write(`  doctor\n`);
  process.stdout.write(`  init --video <path> --transcript <path> [--subtitle <srt>] --project <dir>\n`);
  process.stdout.write(`  import --project <dir> --input <effects.json>\n`);
  process.stdout.write(`  import-overlays --project <dir> --input <overlays.json>\n`);
  process.stdout.write(`  add --project <dir> --start <seconds> --end <seconds> --effect-type <type>\n`);
  process.stdout.write(`  validate --project <dir>\n`);
  process.stdout.write(`  status --project <dir>\n`);
  process.stdout.write(`  serve --project <dir> [--port 8911]\n`);
  process.stdout.write(`  render --project <dir> [--output <path>]\n`);
}

function doctor() {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const ffmpeg = commandAvailable("ffmpeg");
  const ffprobe = commandAvailable("ffprobe");
  const result = {
    ok: nodeMajor >= 18 && ffmpeg.ok && ffprobe.ok,
    node: process.version,
    nodeSupported: nodeMajor >= 18,
    ffmpeg: ffmpeg.ok ? ffmpeg.output.split(/\r?\n/)[0] : "missing",
    ffprobe: ffprobe.ok ? ffprobe.output.split(/\r?\n/)[0] : "missing",
  };
  print(result);
  if (!result.ok) process.exitCode = 1;
}

async function initProject(flags) {
  const videoPath = ensureFile(required(flags, "video"), "视频");
  const transcriptPath = ensureFile(required(flags, "transcript"), "逐字稿");
  const subtitlePath = flags.subtitle ? ensureFile(flags.subtitle, "SRT 字幕") : null;
  const projectDir = path.resolve(required(flags, "project"));
  const projectPath = path.join(projectDir, "project.json");
  if (fs.existsSync(projectPath)) {
    throw new WangganError("任务目录已经包含 project.json，不会覆盖", { projectPath }, 409);
  }
  const words = loadTranscript(transcriptPath);
  const media = probeMedia(videoPath);
  if (words.at(-1).end > media.duration + 0.2) {
    throw new WangganError("逐字稿结束时间超过视频时长", {
      transcriptEnd: words.at(-1).end,
      videoDuration: media.duration,
    });
  }
  fs.mkdirSync(projectDir, { recursive: true });
  const previewCandidate = path.join(projectDir, "preview.mp4");
  const previewVideoPath = await ensurePreview(videoPath, media, previewCandidate);
  const baseName = path.basename(videoPath, path.extname(videoPath));
  const project = {
    version: 2,
    createdAt: new Date().toISOString(),
    videoPath,
    transcriptPath,
    subtitlePath,
    previewVideoPath,
    outputPath: path.join(projectDir, `${baseName}-wanggan.mp4`),
    effectsFile: "effects.json",
    overlaysFile: "overlays.json",
    editorStateFile: "editor-state.json",
    renderStatusFile: "render-status.json",
    duration: media.duration,
    displayWidth: media.displayWidth,
    displayHeight: media.displayHeight,
    sourceMedia: media,
  };
  writeJson(projectPath, project);
  saveEffects(path.join(projectDir, "effects.json"), []);
  saveOverlays(path.join(projectDir, "overlays.json"), defaultOverlays());
  writeJson(path.join(projectDir, "editor-state.json"), defaultEditorState());
  writeJson(path.join(projectDir, "render-status.json"), { state: "idle" });
  const captionTrack = compileCaptionTrack(
    { ...project, projectDir, overlaysPath: path.join(projectDir, "overlays.json") },
    words,
    defaultOverlays(),
  );
  print({
    ok: true,
    projectPath,
    wordCount: words.length,
    media,
    previewVideoPath,
    outputPath: project.outputPath,
    captions: {
      enabled: false,
      source: captionTrack.source,
      sourcePath: captionTrack.sourcePath,
      cueCount: captionTrack.cueCount,
    },
  });
}

function importEffects(flags) {
  const project = loadProject(required(flags, "project"));
  const inputPath = ensureFile(required(flags, "input"), "效果文件");
  const words = loadTranscript(project.transcriptPath);
  const inputs = unwrapEffectsInput(readJson(inputPath));
  const effects = validateEffects(inputs, words, { defaultSource: "ai" });
  saveEffects(project.effectsPath, effects);
  print({ ok: true, effectCount: effects.length, effects });
}

function importOverlays(flags) {
  const project = loadProject(required(flags, "project"));
  const inputPath = ensureFile(required(flags, "input"), "覆盖层文件");
  const words = loadTranscript(project.transcriptPath);
  const overlays = saveOverlays(project.overlaysPath, readJson(inputPath), words);
  print({
    ok: true,
    overlaysVersion: overlays.version,
    timedOverlayCount: overlays.timed_overlays.length,
    overlays,
  });
}

function addEffect(flags) {
  const project = loadProject(required(flags, "project"));
  const words = loadTranscript(project.transcriptPath);
  const current = loadEffects(project.effectsPath, words);
  const candidate = resolveEffect({
    start: required(flags, "start"),
    end: required(flags, "end"),
    effect_type: required(flags, "effect-type"),
    source: flags.source || "ai",
  }, words, { id: `effect-${String(current.length + 1).padStart(3, "0")}` });
  const effects = validateEffects(candidate ? [...current, candidate] : current, words);
  saveEffects(project.effectsPath, effects);
  print({ ok: true, effectCount: effects.length, added: candidate });
}

function validateProject(flags) {
  const project = loadProject(required(flags, "project"));
  const state = projectState(project);
  const overlays = loadOverlays(project.overlaysPath, state.words);
  const compiledOverlays = compileScreenOverlays(project, state.words, overlays, state.effects);
  const { captionTrack, structuredTrack, imageTrack } = compiledOverlays;
  print({
    ok: true,
    wordCount: state.words.length,
    effectCount: state.effects.length,
    duration: state.project.duration,
    outputPath: state.project.outputPath,
    captions: {
      enabled: captionTrack.enabled,
      source: captionTrack.source,
      sourcePath: captionTrack.sourcePath,
      cueCount: captionTrack.cueCount,
    },
    structuredOverlays: {
      enabled: structuredTrack.enabled,
      groupCount: structuredTrack.groupCount,
      stateCount: structuredTrack.states.length,
    },
    imageOverlays: {
      enabled: imageTrack.enabled,
      count: imageTrack.states.length,
    },
  });
}

function fullProjectState(projectInput) {
  const project = typeof projectInput === "string" ? loadProject(projectInput) : projectInput;
  const state = projectState(project);
  const overlays = loadOverlays(project.overlaysPath, state.words);
  const compiledOverlays = compileScreenOverlays(project, state.words, overlays, state.effects);
  const { captionTrack, structuredTrack, imageTrack } = compiledOverlays;
  return {
    ...state,
    overlays,
    captionTrack: {
      enabled: captionTrack.enabled,
      source: captionTrack.source,
      sourcePath: captionTrack.sourcePath,
      cueCount: captionTrack.cueCount,
    },
    structuredOverlayTrack: {
      enabled: structuredTrack.enabled,
      groupCount: structuredTrack.groupCount,
      groups: structuredTrack.groups,
      suppressionRanges: structuredTrack.suppressionRanges,
    },
    imageOverlayTrack: {
      enabled: imageTrack.enabled,
      groupCount: imageTrack.groupCount,
      groups: imageTrack.groups,
    },
    playbackOverlays: compiledOverlays.playbackOverlays,
    playbackImageOverlays: compiledOverlays.playbackImageOverlays,
  };
}

async function serve(flags) {
  const project = loadProject(required(flags, "project"));
  const result = await startServer(project, Number(flags.port || 8911));
  print({ ok: true, url: result.url, projectPath: project.projectPath });
  const close = () => result.server.close(() => process.exit(0));
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
}

async function render(flags) {
  const project = loadProject(required(flags, "project"));
  const result = await renderProject(project, { outputPath: flags.output });
  print(result);
}

export async function main(argv = process.argv.slice(2)) {
  const { command, flags } = parseArgs(argv);
  switch (command) {
    case "help": help(); break;
    case "doctor": doctor(); break;
    case "init": await initProject(flags); break;
    case "import": importEffects(flags); break;
    case "import-overlays": importOverlays(flags); break;
    case "add": addEffect(flags); break;
    case "validate": validateProject(flags); break;
    case "status": print(fullProjectState(required(flags, "project"))); break;
    case "serve": await serve(flags); break;
    case "render": await render(flags); break;
    default: throw new WangganError(`未知命令：${command}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ error: error.message, details: error.details || null }, null, 2)}\n`);
    process.exitCode = 1;
  });
}
