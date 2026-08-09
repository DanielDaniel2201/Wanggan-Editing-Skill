import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  WangganError,
  effectDefinition,
  loadEffects,
  loadProject,
  loadTranscript,
  projectState,
  saveEditorState,
  saveEffects,
  validateEffects,
} from "./lib/core.mjs";
import { compilePlaybackEffects, renderProject } from "./lib/render.mjs";
import {
  compileScreenOverlays,
  loadOverlays,
  saveOverlays,
} from "./lib/captions.mjs";

export const RENDER_ENGINE_VERSION = 8;

const uiRoot = fileURLToPath(new URL("../assets/review-ui/", import.meta.url));
const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function sendJson(response, statusCode, value) {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  response.end(body);
}

function sendError(response, error) {
  const statusCode = error instanceof WangganError ? error.statusCode : 500;
  sendJson(response, statusCode, {
    error: error.message || "服务器错误",
    details: error.details || null,
  });
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 2 * 1024 * 1024) {
        reject(new WangganError("请求内容超过 2 MB"));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(new WangganError("请求不是有效 JSON", { cause: error.message }));
      }
    });
    request.on("error", reject);
  });
}

function serveStatic(response, fileName) {
  const safeName = fileName === "/" ? "index.html" : fileName.replace(/^\//, "");
  if (!new Set(["index.html", "app-v2.js", "styles.css"]).has(safeName)) return false;
  const filePath = path.join(uiRoot, safeName);
  const body = fs.readFileSync(filePath);
  response.writeHead(200, {
    "Content-Type": contentTypes[path.extname(filePath)] || "application/octet-stream",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
  });
  response.end(body);
  return true;
}

function serveMedia(request, response, mediaPath) {
  const stat = fs.statSync(mediaPath);
  const range = request.headers.range;
  const headers = {
    "Content-Type": "video/mp4",
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
  };
  if (!range) {
    response.writeHead(200, { ...headers, "Content-Length": stat.size });
    fs.createReadStream(mediaPath).pipe(response);
    return;
  }
  const match = /bytes=(\d*)-(\d*)/.exec(range);
  if (!match) throw new WangganError("无效的视频 Range 请求", null, 416);
  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Number(match[2]) : stat.size - 1;
  if (start > end || end >= stat.size) throw new WangganError("视频 Range 超出范围", null, 416);
  response.writeHead(206, {
    ...headers,
    "Content-Range": `bytes ${start}-${end}/${stat.size}`,
    "Content-Length": end - start + 1,
  });
  fs.createReadStream(mediaPath, { start, end }).pipe(response);
}

function replaceEffects(project, inputs, defaultSource = "ai") {
  const words = loadTranscript(project.transcriptPath);
  const effects = validateEffects(inputs, words, { defaultSource });
  saveEffects(project.effectsPath, effects);
  return effects;
}

function mutateEffects(project, mutation) {
  const words = loadTranscript(project.transcriptPath);
  const current = loadEffects(project.effectsPath, words);
  const nextInputs = mutation(current, words);
  const effects = validateEffects(nextInputs, words);
  saveEffects(project.effectsPath, effects);
  return effects;
}

function effectInput(effect, overrides = {}) {
  return {
    target: effect.target,
    effect_type: effect.effect_type,
    start_word_index: effect.start_word_index,
    end_word_index: effect.end_word_index,
    source: effect.source,
    human_modified: effect.human_modified,
    ...overrides,
  };
}

function applySelectionChange(effects, range, change) {
  const definition = effectDefinition(change?.effect_type);
  if (!definition) {
    throw new WangganError("不支持的 effect_type", { effect_type: change?.effect_type ?? null });
  }
  const target = String(change?.target || definition.target);
  if (target !== definition.target) {
    throw new WangganError("effect_type 与 target 不匹配", {
      effect_type: change.effect_type,
      target,
      expectedTarget: definition.target,
    });
  }
  if (typeof change.enabled !== "boolean") {
    throw new WangganError("选择效果必须提交 enabled: true 或 false");
  }

  const next = [];
  let modifiesAiEffect = false;
  for (const effect of effects) {
    const overlaps = effect.target === target
      && effect.start_word_index <= range.end
      && effect.end_word_index >= range.start;
    const shouldCut = overlaps && (change.enabled || effect.effect_type === change.effect_type);
    if (!shouldCut) {
      next.push(effectInput(effect));
      continue;
    }
    if (effect.source === "ai") modifiesAiEffect = true;
    if (effect.start_word_index < range.start) {
      next.push(effectInput(effect, {
        end_word_index: range.start - 1,
        human_modified: true,
      }));
    }
    if (effect.end_word_index > range.end) {
      next.push(effectInput(effect, {
        start_word_index: range.end + 1,
        human_modified: true,
      }));
    }
  }
  if (change.enabled) {
    next.push({
      target,
      effect_type: change.effect_type,
      start_word_index: range.start,
      end_word_index: range.end,
      source: modifiesAiEffect ? "ai" : "human",
      human_modified: modifiesAiEffect,
    });
  }
  return next;
}

function mutateSelectionEffects(project, body) {
  const words = loadTranscript(project.transcriptPath);
  const start = Number(body?.start_word_index);
  const end = Number(body?.end_word_index);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end >= words.length) {
    throw new WangganError("选择的逐字稿范围无效", {
      start_word_index: body?.start_word_index ?? null,
      end_word_index: body?.end_word_index ?? null,
      wordCount: words.length,
    });
  }
  if (!Array.isArray(body?.changes) || body.changes.length === 0) {
    throw new WangganError("至少需要提交一个选择效果变化");
  }
  let inputs = loadEffects(project.effectsPath, words).map((effect) => effectInput(effect));
  for (const change of body.changes) {
    inputs = applySelectionChange(inputs, { start, end }, change);
  }
  const effects = validateEffects(inputs.map(({ id: _id, ...effect }) => effect), words, {
    defaultSource: "human",
  });
  saveEffects(project.effectsPath, effects);
  return effects;
}

export function nextAvailableOutputPath(defaultOutputPath) {
  if (!fs.existsSync(defaultOutputPath)) return defaultOutputPath;
  const parsed = path.parse(defaultOutputPath);
  for (let version = 2; ; version += 1) {
    const candidate = path.join(parsed.dir, `${parsed.name}-v${version}${parsed.ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
}

export function startServer(projectInput, port = 8911) {
  const project = typeof projectInput === "string" ? loadProject(projectInput) : projectInput;
  const clients = new Set();
  let renderRunning = false;

  const broadcast = (reason) => {
    const data = JSON.stringify({ reason, at: new Date().toISOString() });
    for (const client of clients) client.write(`event: state\ndata: ${data}\n\n`);
  };

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`);
      const pathname = decodeURIComponent(url.pathname);

      if (request.method === "GET" && serveStatic(response, pathname)) return;
      if (request.method === "GET" && pathname === "/media") {
        serveMedia(request, response, project.previewVideoPath);
        return;
      }
      if (request.method === "GET" && pathname === "/api/state") {
        const state = projectState(project);
        const overlays = loadOverlays(project.overlaysPath, state.words);
        const compiledOverlays = compileScreenOverlays(project, state.words, overlays, state.effects);
        const { captionTrack, structuredTrack } = compiledOverlays;
        sendJson(response, 200, {
          ...state,
          overlays,
          captionTrack: {
            enabled: captionTrack.enabled,
            source: captionTrack.source,
            sourcePath: captionTrack.sourcePath,
            cueCount: captionTrack.cueCount,
            effectCount: captionTrack.effectCount,
            playbackCueCount: captionTrack.playbackCueCount,
            box: captionTrack.box,
            style: captionTrack.style,
            fontSize: captionTrack.fontSize,
          },
          structuredOverlayTrack: {
            enabled: structuredTrack.enabled,
            groupCount: structuredTrack.groupCount,
            groups: structuredTrack.groups,
            suppressionRanges: structuredTrack.suppressionRanges,
          },
          playbackCaptions: compiledOverlays.playbackCaptions,
          playbackOverlays: compiledOverlays.playbackOverlays,
          playbackEffects: compilePlaybackEffects(state.effects),
          renderEngineVersion: RENDER_ENGINE_VERSION,
        });
        return;
      }
      if (request.method === "GET" && pathname === "/api/render-status") {
        sendJson(response, 200, projectState(project).renderStatus);
        return;
      }
      if (request.method === "GET" && pathname === "/api/events") {
        response.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        response.write("event: ready\ndata: {}\n\n");
        clients.add(response);
        request.on("close", () => clients.delete(response));
        return;
      }
      if (request.method === "POST" && pathname === "/api/effects") {
        const body = await readBody(request);
        const effects = mutateEffects(project, (current) => [
          ...current,
          { ...body, source: "human", human_modified: false },
        ]);
        sendJson(response, 201, { effects });
        broadcast("effects-created");
        return;
      }
      if (request.method === "PUT" && pathname === "/api/effects") {
        const body = await readBody(request);
        const effects = replaceEffects(
          project,
          Array.isArray(body) ? body : body.effects,
          body.default_source || "ai",
        );
        sendJson(response, 200, { effects });
        broadcast("effects-replaced");
        return;
      }
      if (request.method === "PATCH" && pathname === "/api/selection-effects") {
        const body = await readBody(request);
        const effects = mutateSelectionEffects(project, body);
        sendJson(response, 200, { effects });
        broadcast("selection-effects-updated");
        return;
      }
      const effectMatch = /^\/api\/effects\/([^/]+)$/.exec(pathname);
      if (effectMatch && request.method === "PATCH") {
        const id = decodeURIComponent(effectMatch[1]);
        const body = await readBody(request);
        const effects = mutateEffects(project, (current) => {
          const existing = current.find((effect) => effect.id === id);
          if (!existing) throw new WangganError("找不到要修改的效果", { id }, 404);
          return current.map((effect) => effect.id === id
            ? { ...effect, ...body, id, source: effect.source, human_modified: true }
            : effect);
        });
        sendJson(response, 200, { effects });
        broadcast("effects-updated");
        return;
      }
      if (effectMatch && request.method === "DELETE") {
        const id = decodeURIComponent(effectMatch[1]);
        const effects = mutateEffects(project, (current) => {
          if (!current.some((effect) => effect.id === id)) {
            throw new WangganError("找不到要删除的效果", { id }, 404);
          }
          return current.filter((effect) => effect.id !== id);
        });
        sendJson(response, 200, { effects });
        broadcast("effects-deleted");
        return;
      }
      if (request.method === "PATCH" && pathname === "/api/overlays/captions") {
        const body = await readBody(request);
        const hasEnabled = Object.hasOwn(body, "enabled");
        const hasBox = Object.hasOwn(body, "box");
        if (!hasEnabled && !hasBox) {
          throw new WangganError("字幕修改必须提交 enabled 或 box");
        }
        if (hasEnabled && typeof body.enabled !== "boolean") {
          throw new WangganError("字幕开关必须是 enabled: true 或 false");
        }
        if (hasBox && (!body.box || typeof body.box !== "object" || Array.isArray(body.box))) {
          throw new WangganError("字幕区块必须是 box 对象");
        }
        const words = loadTranscript(project.transcriptPath);
        const overlays = loadOverlays(project.overlaysPath, words);
        if (hasEnabled) overlays.captions.enabled = body.enabled;
        if (hasBox) overlays.captions.box = { ...overlays.captions.box, ...body.box };
        const saved = saveOverlays(project.overlaysPath, overlays, words);
        sendJson(response, 200, { overlays: saved });
        broadcast("captions-updated");
        return;
      }
      if (request.method === "PUT" && pathname === "/api/overlays") {
        const body = await readBody(request);
        const words = loadTranscript(project.transcriptPath);
        const saved = saveOverlays(project.overlaysPath, body, words);
        sendJson(response, 200, { overlays: saved });
        broadcast("overlays-updated");
        return;
      }
      if (request.method === "POST" && pathname === "/api/save-project") {
        const body = await readBody(request);
        const state = projectState(project);
        const editorState = saveEditorState(project.editorStatePath, {
          version: 1,
          savedAt: new Date().toISOString(),
          currentTime: body.currentTime,
          selectedWordIndexes: body.selectedWordIndexes,
        }, {
          wordCount: state.words.length,
          duration: project.duration,
        });
        sendJson(response, 200, { ok: true, editorState });
        broadcast("project-saved");
        return;
      }
      if (request.method === "POST" && pathname === "/api/render") {
        if (renderRunning) throw new WangganError("当前已有出片任务正在运行", null, 409);
        const body = await readBody(request);
        const outputPath = body.outputPath || nextAvailableOutputPath(project.outputPath);
        renderRunning = true;
        renderProject(project, { outputPath })
          .then(() => broadcast("render-complete"))
          .catch(() => broadcast("render-failed"))
          .finally(() => { renderRunning = false; });
        sendJson(response, 202, { state: "running", outputPath });
        broadcast("render-started");
        return;
      }
      sendJson(response, 404, { error: "找不到接口" });
    } catch (error) {
      sendError(response, error);
    }
  });

  const watcher = fs.watch(project.projectDir, { persistent: false }, (_eventType, fileName) => {
    const name = fileName?.toString() || "";
    if (
      name === path.basename(project.effectsPath)
      || name === path.basename(project.overlaysPath)
      || name === path.basename(project.editorStatePath)
      || name === path.basename(project.renderStatusPath)
    ) {
      broadcast(name);
    }
  });

  server.on("close", () => {
    watcher.close();
    for (const client of clients) client.end();
    clients.clear();
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(port), "127.0.0.1", () => {
      const address = server.address();
      resolve({
        server,
        project,
        url: `http://127.0.0.1:${address.port}/`,
      });
    });
  });
}
