import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  COMPILER_VERSION,
  WangganError,
  loadEditorState,
  readJson,
  saveEditorState,
} from "./lib/core.mjs";
import { compileProject } from "./lib/compiler.mjs";
import {
  applyAssetPatch,
  applyEffectRange,
  loadComposition,
  nextAssetId,
  nextEffectId,
  removeAsset,
  saveComposition,
} from "./lib/composition.mjs";
import { resolveWordRange } from "./lib/timeline.mjs";
import { renderProject } from "./lib/render.mjs";

export const RENDER_ENGINE_VERSION = COMPILER_VERSION;

const uiRoot = fileURLToPath(new URL("../assets/review-ui/", import.meta.url));
const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
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

function serveOverlayImage(response, imagePath) {
  const body = fs.readFileSync(imagePath);
  response.writeHead(200, {
    "Content-Type": contentTypes[path.extname(imagePath).toLowerCase()] || "application/octet-stream",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
  });
  response.end(body);
}

export function nextAvailableOutputPath(defaultOutputPath) {
  if (!fs.existsSync(defaultOutputPath)) return defaultOutputPath;
  const parsed = path.parse(defaultOutputPath);
  for (let version = 2; ; version += 1) {
    const candidate = path.join(parsed.dir, `${parsed.name}-v${version}${parsed.ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
}

function publicState(ir) {
  const editorState = loadEditorState(ir.project.editorStatePath, {
    wordCount: ir.words.length,
    duration: ir.project.duration,
  });
  const renderStatus = fs.existsSync(ir.project.renderStatusPath)
    ? readJson(ir.project.renderStatusPath)
    : { state: "idle" };
  return {
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
    words: ir.words,
    composition: ir.composition,
    catalog: ir.catalog,
    profile: ir.profile,
    profileLock: ir.profileLock,
    editorState,
    renderStatus,
    playbackScene: ir.playbackScene,
    playbackEffects: ir.playbackEffects,
    playbackCaptions: ir.playbackCaptions,
    playbackOverlays: ir.playbackOverlays,
    playbackImageOverlays: ir.playbackImageOverlays,
    captionTrack: ir.captionTrack,
    structuredOverlayTrack: ir.structuredOverlayTrack,
    imageOverlayTrack: ir.imageOverlayTrack,
    renderEngineVersion: RENDER_ENGINE_VERSION,
  };
}

export async function startServer(contextInput, port = 8911) {
  const context = contextInput.project ? contextInput : null;
  if (!context) throw new WangganError("审查服务需要已加载的工程上下文");
  const clients = new Set();
  let renderRunning = false;

  const broadcast = (reason) => {
    const data = JSON.stringify({ reason, at: new Date().toISOString() });
    for (const client of clients) {
      client.write(`event: state\ndata: ${data}\n\n`);
      client.write(`event: ${reason}\ndata: ${data}\n\n`);
    }
  };

  const compile = async () => compileProject(context.project, { context });

  const persist = (composition) => saveComposition(
    context.project.compositionPath,
    composition,
    context.profile,
    context.words,
    context.project,
  );

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`);
      const pathname = decodeURIComponent(url.pathname);

      if (request.method === "GET" && serveStatic(response, pathname)) return;
      if (request.method === "GET" && pathname === "/media") {
        serveMedia(request, response, context.project.previewVideoPath);
        return;
      }
      const overlayImageMatch = /^\/overlay-images\/([^/]+)$/.exec(pathname);
      if (request.method === "GET" && overlayImageMatch) {
        const ir = await compile();
        const image = ir.imageOverlayTrack.groups.find((candidate) => candidate.id === overlayImageMatch[1]);
        if (!image) throw new WangganError("找不到贴图素材", { id: overlayImageMatch[1] }, 404);
        serveOverlayImage(response, image.resolved_image_path);
        return;
      }
      if (request.method === "GET" && pathname === "/api/state") {
        sendJson(response, 200, publicState(await compile()));
        return;
      }
      if (request.method === "GET" && pathname === "/api/profile") {
        sendJson(response, 200, context.profile.catalog());
        return;
      }
      if (request.method === "GET" && pathname === "/api/render-status") {
        sendJson(response, 200, fs.existsSync(context.project.renderStatusPath)
          ? readJson(context.project.renderStatusPath)
          : { state: "idle" });
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
      if (request.method === "PUT" && pathname === "/api/composition") {
        const body = await readBody(request);
        const saved = persist(body);
        sendJson(response, 200, { composition: saved });
        broadcast("composition-updated");
        return;
      }
      if (request.method === "POST" && pathname === "/api/assets") {
        const body = await readBody(request);
        const current = loadComposition(context.project.compositionPath, context.profile, context.words, context.project);
        const typeDef = context.profile.assetTypes.get(body.type);
        if (!typeDef) throw new WangganError("未注册的 AssetType", { type: body.type });
        const asset = {
          id: body.id || nextAssetId(body.type, current.assets),
          type: body.type,
          enabled: body.enabled !== false,
          source: body.source || { kind: "agent-generated" },
          lifecycle: body.lifecycle,
          props: body.props || {},
          origin: { created_by: "human", human_modified: false },
        };
        if (!asset.lifecycle && body.props?.items?.length) {
          asset.lifecycle = {
            kind: "word_range",
            start_word_index: body.props.items[0].start_word_index,
            end_word_index: body.props.items.at(-1).end_word_index,
          };
        }
        const extraEffects = [];
        const sourceEffects = body.effects || typeDef.ui?.default_effects || [];
        for (const effect of sourceEffects) {
          extraEffects.push({
            id: effect.id || nextEffectId([...current.effects, ...extraEffects]),
            type: effect.type,
            target: { asset_id: asset.id },
            timing: effect.timing,
            config: effect.config || {},
            origin: { created_by: "human", human_modified: false },
          });
        }
        const next = {
          ...current,
          assets: [...current.assets, asset],
          effects: [...current.effects, ...extraEffects],
        };
        const saved = persist(next);
        sendJson(response, 201, { composition: saved, asset });
        broadcast("composition-updated");
        return;
      }
      const assetMatch = /^\/api\/assets\/([^/]+)$/.exec(pathname);
      if (assetMatch && request.method === "PATCH") {
        const body = await readBody(request);
        const current = loadComposition(context.project.compositionPath, context.profile, context.words, context.project);
        const saved = persist(applyAssetPatch(current, decodeURIComponent(assetMatch[1]), body));
        sendJson(response, 200, { composition: saved });
        broadcast("composition-updated");
        return;
      }
      if (assetMatch && request.method === "DELETE") {
        const current = loadComposition(context.project.compositionPath, context.profile, context.words, context.project);
        const saved = persist(removeAsset(current, decodeURIComponent(assetMatch[1])));
        sendJson(response, 200, { composition: saved });
        broadcast("composition-updated");
        return;
      }
      if (request.method === "POST" && pathname === "/api/effects") {
        const body = await readBody(request);
        const current = loadComposition(context.project.compositionPath, context.profile, context.words, context.project);
        if (body.replace_range) {
          const saved = persist(applyEffectRange(current, body, context.words));
          sendJson(response, 201, { composition: saved, effects: saved.effects });
          broadcast("composition-updated");
          return;
        }
        const effect = {
          id: body.id || nextEffectId(current.effects),
          type: body.type,
          target: body.target,
          timing: body.timing,
          config: body.config || {},
          origin: { created_by: "human", human_modified: false },
        };
        const saved = persist({ ...current, effects: [...current.effects, effect] });
        sendJson(response, 201, { composition: saved, effect, effects: saved.effects });
        broadcast("composition-updated");
        return;
      }
      const effectMatch = /^\/api\/effects\/([^/]+)$/.exec(pathname);
      if (effectMatch && request.method === "PATCH") {
        const id = decodeURIComponent(effectMatch[1]);
        const body = await readBody(request);
        const current = loadComposition(context.project.compositionPath, context.profile, context.words, context.project);
        const existing = current.effects.find((effect) => effect.id === id);
        if (!existing) throw new WangganError("找不到要修改的效果", { id }, 404);
        const next = {
          ...current,
          effects: current.effects.map((effect) => effect.id === id
            ? {
              ...effect,
              ...body,
              id,
              origin: { created_by: effect.origin.created_by, human_modified: true },
            }
            : effect),
        };
        const saved = persist(next);
        sendJson(response, 200, { composition: saved, effects: saved.effects });
        broadcast("composition-updated");
        return;
      }
      if (effectMatch && request.method === "DELETE") {
        const id = decodeURIComponent(effectMatch[1]);
        const current = loadComposition(context.project.compositionPath, context.profile, context.words, context.project);
        if (!current.effects.some((effect) => effect.id === id)) {
          throw new WangganError("找不到要删除的效果", { id }, 404);
        }
        const saved = persist({
          ...current,
          effects: current.effects.filter((effect) => effect.id !== id),
        });
        sendJson(response, 200, { composition: saved, effects: saved.effects });
        broadcast("composition-updated");
        return;
      }
      if (request.method === "POST" && pathname === "/api/save-project") {
        const body = await readBody(request);
        const editorState = saveEditorState(context.project.editorStatePath, {
          version: 1,
          savedAt: new Date().toISOString(),
          currentTime: body.currentTime,
          selectedWordIndexes: body.selectedWordIndexes,
        }, {
          wordCount: context.words.length,
          duration: context.project.duration,
        });
        sendJson(response, 200, { ok: true, editorState });
        broadcast("project-saved");
        return;
      }
      if (request.method === "POST" && pathname === "/api/render") {
        if (renderRunning) throw new WangganError("当前已有出片任务正在运行", null, 409);
        const ir = await compile();
        if (!ir.profileLock.ok) {
          throw new WangganError("Profile 与 lock 不一致，请先运行 profile sync", ir.profileLock);
        }
        const body = await readBody(request);
        const outputPath = body.outputPath || nextAvailableOutputPath(context.project.outputPath);
        renderRunning = true;
        renderProject(context.project, { outputPath, context, ir })
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

  const watcher = fs.watch(context.project.projectDir, { persistent: false }, (_eventType, fileName) => {
    const name = fileName?.toString() || "";
    if (
      name === path.basename(context.project.compositionPath)
      || name === path.basename(context.project.editorStatePath)
      || name === path.basename(context.project.renderStatusPath)
      || name === path.basename(context.project.profileLockPath)
    ) {
      broadcast(name === path.basename(context.project.profileLockPath) ? "profile-mismatch" : "composition-updated");
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
        project: context.project,
        url: `http://127.0.0.1:${address.port}/`,
      });
    });
  });
}

export { resolveWordRange };
