import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { WangganError, roundTime, writeJson } from "./core.mjs";
import { compileProject, writeOverlayAss } from "./compiler.mjs";

export function commandAvailable(command, args = ["-version"]) {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true });
  return { ok: result.status === 0, status: result.status, output: `${result.stdout || ""}${result.stderr || ""}`.trim() };
}

export function probeMedia(videoPath) {
  const result = spawnSync("ffprobe", [
    "-v", "error",
    "-show_streams",
    "-show_format",
    "-of", "json",
    videoPath,
  ], { encoding: "utf8", windowsHide: true, maxBuffer: 20 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new WangganError("ffprobe 无法读取视频", { videoPath, stderr: result.stderr });
  }
  const data = JSON.parse(result.stdout);
  const video = data.streams?.find((stream) => stream.codec_type === "video");
  if (!video) throw new WangganError("输入文件没有视频轨道", { videoPath });
  const audio = data.streams?.find((stream) => stream.codec_type === "audio") || null;
  const rotationValue = video.side_data_list?.find((item) => Number.isFinite(Number(item.rotation)))?.rotation
    ?? video.tags?.rotate
    ?? 0;
  const rotation = Number(rotationValue) || 0;
  const rotated = Math.abs(rotation) % 180 === 90;
  const width = Number(video.width);
  const height = Number(video.height);
  const duration = Number(video.duration || data.format?.duration);
  if (!Number.isFinite(width) || !Number.isFinite(height) || !Number.isFinite(duration)) {
    throw new WangganError("无法确定视频尺寸或时长", { video, format: data.format });
  }
  return {
    width,
    height,
    displayWidth: rotated ? height : width,
    displayHeight: rotated ? width : height,
    duration: roundTime(duration),
    rotation,
    videoCodec: video.codec_name,
    audioCodec: audio?.codec_name || null,
    hasAudio: Boolean(audio),
    formatName: data.format?.format_name || "",
  };
}

export function isBrowserPlayable(media) {
  return media.videoCodec === "h264" && /mp4|mov/.test(media.formatName);
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      options.onStdout?.(chunk.toString());
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      options.onStderr?.(chunk.toString());
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new WangganError(`${command} 执行失败`, { code, stderr: stderr.slice(-6000) }));
    });
  });
}

export async function ensurePreview(videoPath, media, previewPath) {
  if (isBrowserPlayable(media)) return videoPath;
  if (fs.existsSync(previewPath)) return previewPath;
  await runProcess("ffmpeg", [
    "-y", "-v", "warning", "-i", videoPath,
    "-map", "0:v:0", "-map", "0:a?",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart",
    previewPath,
  ]);
  return previewPath;
}

function even(value) {
  const rounded = Math.max(2, Math.round(value));
  return rounded % 2 === 0 ? rounded : rounded + 1;
}

export function scalePercentAtTime(effect, time) {
  if (!effect || time < effect.start || time >= effect.end) return 100;
  if (effect.motion !== "progressive") return effect.scale_percent;
  const duration = effect.end - effect.start;
  if (duration <= 0) return 100;
  const progress = Math.max(0, Math.min(1, (time - effect.start) / duration));
  return 100 + (effect.scale_percent - 100) * progress;
}

export function buildScaleExpression(playbackEffects) {
  let expression = "1";
  for (let index = playbackEffects.length - 1; index >= 0; index -= 1) {
    const effect = playbackEffects[index];
    const targetScale = roundTime((effect.to_scale ?? effect.scale_percent / 100));
    const fromScale = Number(effect.from_scale ?? 1);
    const activeScale = effect.interpolation === "linear" || effect.motion === "progressive"
      ? `${roundTime(fromScale)}+(${roundTime(targetScale - fromScale)})*((t-${effect.start})/${roundTime(effect.end - effect.start)})`
      : String(targetScale);
    expression = `if(gte(t,${effect.start})*lt(t,${effect.end}),${activeScale},${expression})`;
  }
  return expression;
}

export function buildChannelExpression(states, options = {}) {
  const fromKey = options.fromKey;
  const toKey = options.toKey;
  const time = options.time || "t";
  let expression = String(options.fallback ?? 1);
  for (let index = states.length - 1; index >= 0; index -= 1) {
    const state = states[index];
    const from = Number(state[fromKey] ?? options.fallback ?? 1);
    const to = Number(state[toKey] ?? options.fallback ?? 1);
    const duration = Math.max(0.001, Number(state.end) - Number(state.start));
    const active = state.interpolation === "linear"
      ? `${roundTime(from)}+(${roundTime(to - from)})*((${time}-${state.start})/${roundTime(duration)})`
      : String(roundTime(to));
    expression = `if(gte(${time},${state.start})*lt(${time},${state.end}),${active},${expression})`;
  }
  return expression;
}

function visibilityExpression(overlay) {
  let expression = `gte(t,${overlay.start})*lt(t,${overlay.end})`;
  for (const range of overlay.suppression_ranges || []) {
    expression += `*not(gte(t,${range.start})*lt(t,${range.end}))`;
  }
  return expression;
}

export function buildFilter(project, playbackEffects, options = {}) {
  const width = even(project.displayWidth);
  const height = even(project.displayHeight);
  const maxScale = Math.max(1, ...playbackEffects.map((effect) => (effect.to_scale ?? effect.scale_percent / 100)));
  const padWidth = even(width * maxScale);
  const padHeight = even(height * maxScale);
  const expression = buildScaleExpression(playbackEffects);
  const videoFilter = `[0:v]scale=w='trunc(${width}*(${expression})/2)*2':h='trunc(${height}*(${expression})/2)*2':eval=frame:flags=lanczos,pad=${padWidth}:${padHeight}:(ow-iw)/2:(oh-ih)/2:black:eval=frame,crop=${width}:${height}:(iw-ow)/2:(ih-oh)/2,setsar=1,format=yuv420p`;
  const imageOverlays = Array.isArray(options.imageOverlays) ? options.imageOverlays : [];
  const overlayAssFile = options.overlayAssFile || options.captionAssFile;
  if (!imageOverlays.length && !overlayAssFile) return `${videoFilter}[v]`;
  if (!imageOverlays.length) {
    const safeAssFile = String(overlayAssFile).replace(/['\\]/g, "");
    return `${videoFilter}[base];[base]ass=filename='${safeAssFile}'[v]`;
  }
  const filters = [`${videoFilter}[base0]`];
  let currentBase = "base0";
  imageOverlays.forEach((overlay, index) => {
    const boxWidth = Math.max(2, Math.round(width * overlay.box.width));
    const boxHeight = Math.max(2, Math.round(height * overlay.box.height));
    const centerX = Math.round(width * (overlay.box.x + overlay.box.width / 2));
    const centerY = Math.round(height * (overlay.box.y + overlay.box.height / 2));
    const imageLabel = `image${index}`;
    const nextBase = `base${index + 1}`;
    const inputIndex = Number(overlay.input_index ?? index + 1);
    const scaleStates = [
      ...(overlay.effects?.scale || []),
      ...(overlay.effects?.entryScale || []),
    ];
    const opacityStates = [
      ...(overlay.effects?.opacity || []),
      ...(overlay.effects?.entryOpacity || []),
    ];
    const scaleExpression = buildChannelExpression(scaleStates, {
      fromKey: "from_scale",
      toKey: "to_scale",
      time: "t",
      fallback: 1,
    });
    const opacityExpression = buildChannelExpression(opacityStates, {
      fromKey: "from_opacity",
      toKey: "to_opacity",
      time: "N/30",
      fallback: 1,
    });
    filters.push(
      `[${inputIndex}:v]scale=w='max(2,trunc(${boxWidth}*(${scaleExpression})/2)*2)':h='max(2,trunc(${boxHeight}*(${scaleExpression})/2)*2)':force_original_aspect_ratio=decrease:eval=frame:flags=lanczos,format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*(${opacityExpression})',setpts=PTS-STARTPTS[${imageLabel}]`,
    );
    filters.push(
      `[${currentBase}][${imageLabel}]overlay=x='${centerX}-overlay_w/2':y='${centerY}-overlay_h/2':enable='${visibilityExpression(overlay)}':shortest=0:repeatlast=1[${nextBase}]`,
    );
    currentBase = nextBase;
  });
  if (!overlayAssFile) {
    filters.push(`[${currentBase}]format=yuv420p[v]`);
    return filters.join(";");
  }
  const safeAssFile = String(overlayAssFile).replace(/['\\]/g, "");
  filters.push(`[${currentBase}]ass=filename='${safeAssFile}'[v]`);
  return filters.join(";");
}

export async function renderProject(project, options = {}) {
  const ir = options.ir || await compileProject(project, options);
  if (ir.profileLock && ir.profileLock.ok === false) {
    throw new WangganError("Profile 与 lock 不一致，请先运行 profile sync", {
      changes: ir.profileLock.changes,
    });
  }
  const outputPath = path.resolve(options.outputPath || project.outputPath);
  if (fs.existsSync(outputPath) && !options.overwrite) {
    throw new WangganError("输出文件已经存在，不会覆盖", { outputPath }, 409);
  }
  const overlayAssFile = ir.hasAss
    ? path.basename(writeOverlayAss(project, ir))
    : null;
  const renderImages = ir.playbackImageOverlays.map((overlay, index) => ({
    ...overlay,
    input_index: index + 1,
  }));
  const filter = buildFilter(project, ir.playbackEffects, { overlayAssFile, imageOverlays: renderImages });
  const filterPath = path.join(project.projectDir, "render-filter.txt");
  fs.writeFileSync(filterPath, `${filter}\n`, "utf8");
  const statusBase = { outputPath, startedAt: new Date().toISOString(), progress: 0 };
  writeJson(project.renderStatusPath, { state: "running", ...statusBase });

  let progressBuffer = "";
  try {
    await runProcess("ffmpeg", [
      "-y", "-v", "error", "-i", project.videoPath,
      ...renderImages.flatMap((overlay) => ["-loop", "1", "-framerate", "30", "-i", overlay.resolved_image_path]),
      "-filter_complex_script", filterPath,
      "-map", "[v]", "-map", "0:a?",
      "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart",
      "-t", String(project.duration),
      "-progress", "pipe:1", "-nostats",
      outputPath,
    ], {
      cwd: project.projectDir,
      onStdout(chunk) {
        progressBuffer += chunk;
        const lines = progressBuffer.split(/\r?\n/);
        progressBuffer = lines.pop() || "";
        for (const line of lines) {
          const [key, value] = line.split("=");
          if (key === "out_time_us") {
            const seconds = Number(value) / 1_000_000;
            const progress = Math.max(0, Math.min(99, Math.round((seconds / project.duration) * 100)));
            writeJson(project.renderStatusPath, { state: "running", ...statusBase, progress });
            options.onProgress?.(progress);
          }
        }
      },
    });

    const nullDevice = os.platform() === "win32" ? "NUL" : "/dev/null";
    await runProcess("ffmpeg", ["-v", "error", "-i", outputPath, "-map", "0:v:0", "-map", "0:a?", "-f", "null", nullDevice]);
    const outputMedia = probeMedia(outputPath);
    if (Math.abs(outputMedia.duration - project.duration) > 0.2) {
      throw new WangganError("输出时长与原视频不一致", { expected: project.duration, actual: outputMedia.duration });
    }
    const complete = {
      state: "complete",
      ...statusBase,
      progress: 100,
      completedAt: new Date().toISOString(),
      media: outputMedia,
      captions: {
        enabled: ir.captionTrack.enabled,
        source: ir.captionTrack.source,
        cueCount: ir.captionTrack.cueCount,
      },
      structuredOverlays: {
        enabled: ir.structuredOverlayTrack.enabled,
        groupCount: ir.structuredOverlayTrack.groupCount,
        stateCount: ir.playbackOverlays.length,
      },
      imageOverlays: {
        enabled: ir.imageOverlayTrack.enabled,
        count: ir.playbackImageOverlays.length,
      },
    };
    writeJson(project.renderStatusPath, complete);
    return complete;
  } catch (error) {
    writeJson(project.renderStatusPath, {
      state: "failed",
      ...statusBase,
      failedAt: new Date().toISOString(),
      error: error.message,
      details: error.details || null,
    });
    throw error;
  }
}

export function compilePlaybackEffects(playbackEffects) {
  return playbackEffects;
}
