import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultEditorState, readJson, writeJson } from "./lib/core.mjs";
import { loadProjectContext } from "./lib/project.mjs";
import { emptyComposition, saveComposition } from "./lib/composition.mjs";
import { loadProfile, writeProfileLock } from "./lib/profile-loader.mjs";
import { startServer } from "./server.mjs";

const sourceDir = process.argv[2];
if (!sourceDir) throw new Error("usage: node scripts/integration-test.mjs <project>");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wanggan-integration-"));
const imagePath = path.join(tempDir, "overlay-test.png");
fs.writeFileSync(
  imagePath,
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z3W8AAAAASUVORK5CYII=", "base64"),
);

for (const name of fs.readdirSync(sourceDir)) {
  const from = path.join(sourceDir, name);
  if (fs.statSync(from).isFile()) fs.copyFileSync(from, path.join(tempDir, name));
}

const testProfile = await loadProfile(path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/profiles/test-ip",
));
const copiedProject = readJson(path.join(tempDir, "project.json"));
copiedProject.profile = {
  id: testProfile.id,
  path: testProfile.dir,
  lock_file: "profile-lock.json",
};
writeJson(path.join(tempDir, "project.json"), copiedProject);
writeProfileLock(path.join(tempDir, "profile-lock.json"), testProfile);

const context = await loadProjectContext(tempDir);
saveComposition(
  context.project.compositionPath,
  emptyComposition(context.profile),
  context.profile,
  context.words,
  context.project,
);
writeJson(context.project.editorStatePath, defaultEditorState());
const { server, url, project } = await startServer(context, 0);
try {
  const reviewHtmlResponse = await fetch(url);
  assert.equal(reviewHtmlResponse.status, 200);
  const reviewHtml = await reviewHtmlResponse.text();
  assert.match(reviewHtml, /id="subtitleToggleButton"[^>]*>启用<\/button>/);
  assert.match(reviewHtml, /id="subtitleResizeHandle"/);
  assert.match(reviewHtml, /id="structuredOverlay"/);
  assert.match(reviewHtml, /id="structuredEditor"/);
  assert.match(reviewHtml, /id="effectButtons"/);
  assert.match(reviewHtml, /id="effectTargetBadge"/);
  assert.match(reviewHtml, /id="assetCreateButtons"/);
  assert.match(reviewHtml, /id="imageOverlay"/);
  assert.match(reviewHtml, /id="imageResizeHandle"/);
  assert.match(reviewHtml, /id="fontFamilySelect"/);
  assert.match(reviewHtml, /<option value="Microsoft YaHei">默认粗黑体<\/option>/);
  assert.match(reviewHtml, /<option value="华文中宋">华文中宋<\/option>/);

  const reviewAppResponse = await fetch(`${url}app-v2.js`);
  assert.equal(reviewAppResponse.status, 200);
  const reviewApp = await reviewAppResponse.text();
  assert.match(reviewApp, /renderEffectCatalog/);
  assert.match(reviewApp, /requires_capabilities/);
  assert.match(reviewApp, /ui\?\.presets/);
  assert.match(reviewApp, /segment\.style\?\.font_scale/);
  assert.match(reviewApp, /caption\.layout_font_scale/);
  assert.match(reviewApp, /selectedEffectTargetId/);
  assert.match(reviewApp, /effectTypeSupportsTarget/);
  assert.match(reviewApp, /function selectTranscriptWordRange/);
  assert.match(reviewApp, /selectEffectTarget\(videoTargetId\)/);
  assert.match(reviewApp, /selectTranscriptWordRange\(caption\)/);
  assert.match(reviewApp, /selectStructuredText\(group\.id, item \|\| group\)/);
  assert.match(reviewApp, /selectTranscriptWordRange\(overlay\)/);
  assert.match(reviewApp, /overlay\.style\.bottom/);
  assert.match(reviewApp, /mode === "font-resize"/);
  assert.match(reviewApp, /setCaptionFontSizeInState/);
  assert.match(reviewApp, /createAssetFromSelection/);
  assert.match(reviewApp, /function updateImageInteraction/);
  assert.match(reviewApp, /mode: event\.target\.closest\("\.image-resize-handle"\) \? "resize" : "move"/);
  assert.match(reviewApp, /renderImageOverlay\(currentImageOverlayAt\(time\), time\)/);
  assert.match(reviewApp, /structured-keyword/);
  assert.match(reviewApp, /structured-item-resize-handle/);
  assert.match(reviewApp, /setStructuredFontSizeInState/);
  assert.match(reviewApp, /resizeKeywordBoxesInState/);
  assert.match(reviewApp, /AbortSignal\.timeout\(8000\)/);
  assert.match(reviewApp, /function markServiceDisconnected/);
  assert.match(reviewApp, /elements\.renderButton\.textContent = "正在提交"/);
  assert.match(reviewApp, /function saveSelectedFont/);
  assert.match(reviewApp, /entryTranslateY/);
  assert.match(reviewApp, /colorWithOpacity/);

  const profileResponse = await fetch(`${url}api/profile`);
  assert.equal(profileResponse.status, 200);
  const catalog = await profileResponse.json();
  assert.ok(catalog.primitiveTypes.some((item) => item.id === "base.transform.translate-y"));
  assert.ok(catalog.primitiveTypes.some((item) => item.id === "base.container.background-color"));
  assert.ok(catalog.effectTypes.some((item) => item.id === "base.scale"));
  assert.ok(catalog.effectTypes.some((item) => item.id === "test-ip.fade"));
  assert.deepEqual(
    catalog.effectTypes.find((item) => item.id === "base.item-enter").composes.map((item) => item.effect_type),
    ["base.translate-y-entry", "base.opacity-entry"],
  );
  assert.ok(catalog.effectTypes.some((item) => item.ui?.presets?.some((preset) => preset.label === "瞬间放大")));
  assert.ok(catalog.effectTypes.some((item) => item.ui?.presets?.some((preset) => preset.label === "大字号、亮黄色")));
  assert.ok(catalog.assetTypes.some((item) => item.ui?.create_from_selection && item.capabilities.includes("ordered-items")));
  assert.ok(catalog.assetTypes.some((item) => item.id === "test-ip.card"));

  const stateResponse = await fetch(`${url}api/state`);
  assert.equal(stateResponse.status, 200);
  const state = await stateResponse.json();
  assert.ok(state.words.length > 0);
  assert.equal(state.renderEngineVersion, 21);
  assert.ok(state.playbackScene);
  assert.ok(Array.isArray(state.playbackEffects));
  assert.ok(Array.isArray(state.playbackCaptions));
  assert.ok(Array.isArray(state.playbackOverlays));
  assert.ok(Array.isArray(state.playbackImageOverlays));
  assert.equal(typeof state.captionTrack.enabled, "boolean");
  assert.equal(state.captionTrack.source, "srt");
  assert.equal(state.editorState.currentTime, 0);

  const captionsId = state.catalog.systemAssets.find((item) => item.id === "captions.main").id;
  const captionToggleResponse = await fetch(`${url}api/assets/${encodeURIComponent(captionsId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: true }),
  });
  assert.equal(captionToggleResponse.status, 200);
  const toggledState = await (await fetch(`${url}api/state`)).json();
  assert.equal(toggledState.captionTrack.enabled, true);
  assert.ok(Number.isInteger(toggledState.playbackCaptions[0].start_word_index));
  assert.ok(Number.isInteger(toggledState.playbackCaptions[0].end_word_index));

  const firstCueId = toggledState.playbackCaptions[0].source_cue_id;
  const captionFontResponse = await fetch(`${url}api/assets/${encodeURIComponent(captionsId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      props: {
        cue_overrides: {
          [firstCueId]: { font_family: "华文中宋" },
        },
      },
    }),
  });
  assert.equal(captionFontResponse.status, 200);
  const captionFontState = await (await fetch(`${url}api/state`)).json();
  assert.equal(
    captionFontState.composition.assets.find((asset) => asset.id === captionsId).props.cue_overrides[firstCueId].font_family,
    "华文中宋",
  );

  const captionFontSizeResponse = await fetch(`${url}api/assets/${encodeURIComponent(captionsId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      props: {
        cue_overrides: {
          ...captionFontState.composition.assets.find((asset) => asset.id === captionsId).props.cue_overrides,
          [firstCueId]: {
            ...captionFontState.composition.assets.find((asset) => asset.id === captionsId).props.cue_overrides[firstCueId],
            font_size_ratio: 0.085,
          },
        },
      },
    }),
  });
  assert.equal(captionFontSizeResponse.status, 200);

  const movedBox = { x: 0.18, y: 0.24, width: 0.58, height: 0.32, unit: "ratio" };
  const captionBoxResponse = await fetch(`${url}api/assets/${encodeURIComponent(captionsId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ props: { box: movedBox } }),
  });
  assert.equal(captionBoxResponse.status, 200);
  const movedState = await (await fetch(`${url}api/state`)).json();
  assert.deepEqual(movedState.captionTrack.box, movedBox);

  const listStartWordIndex = Math.max(0, context.words.length - 2);
  const listEndWordIndex = context.words.length - 1;
  const listResponse = await fetch(`${url}api/assets`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "base.list",
      enabled: true,
      lifecycle: { kind: "word_range", start_word_index: listStartWordIndex, end_word_index: listEndWordIndex },
      props: {
        style: { font_family: "华文中宋", font_size_ratio: 0.06 },
        items: [{
          start_word_index: listStartWordIndex,
          end_word_index: listEndWordIndex,
          display_text: "一、集成验证",
        }],
      },
    }),
  });
  assert.equal(listResponse.status, 201);
  const progressiveState = await (await fetch(`${url}api/state`)).json();
  assert.equal(progressiveState.structuredOverlayTrack.groupCount, 1);
  assert.equal(progressiveState.playbackOverlays.length, 1);
  assert.ok(Number.isInteger(progressiveState.structuredOverlayTrack.groups[0].items[0].start_word_index));
  assert.ok(Number.isInteger(progressiveState.structuredOverlayTrack.groups[0].items[0].end_word_index));
  assert.equal(progressiveState.structuredOverlayTrack.groups[0].style.font_family, "华文中宋");
  assert.equal(progressiveState.structuredOverlayTrack.groups[0].style.font_size_ratio, 0.06);
  assert.equal(progressiveState.structuredOverlayTrack.groups[0].container.background_color, "#111827");
  assert.equal(progressiveState.playbackOverlays[0].enter_animation, "translate-opacity");
  assert.equal(progressiveState.playbackOverlays[0].effects.entryTranslateY.length, 1);

  const listId = progressiveState.structuredOverlayTrack.groups[0].id;
  await fetch(`${url}api/assets/${encodeURIComponent(listId)}`, { method: "DELETE" });

  const keywordStartWordIndex = Math.max(0, context.words.length - 2);
  const keywordResponse = await fetch(`${url}api/assets`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "base.keywords",
      enabled: true,
      lifecycle: { kind: "word_range", start_word_index: keywordStartWordIndex, end_word_index: keywordStartWordIndex + 1 },
      props: {
        layout: "auto",
        style: { font_family: "Microsoft YaHei", font_size_ratio: 0.09 },
        items: [
          { start_word_index: keywordStartWordIndex, end_word_index: keywordStartWordIndex, display_text: "普通人" },
          { start_word_index: keywordStartWordIndex + 1, end_word_index: keywordStartWordIndex + 1, display_text: "也能" },
        ],
      },
    }),
  });
  assert.equal(keywordResponse.status, 201);
  const keywordState = await (await fetch(`${url}api/state`)).json();
  assert.equal(keywordState.structuredOverlayTrack.groups[0].layout_mode, "items");
  assert.equal(keywordState.playbackOverlays.length, 2);
  assert.equal(keywordState.playbackOverlays[1].enter_animation, "pop");

  const keywordId = keywordState.structuredOverlayTrack.groups[0].id;
  const fadeResponse = await fetch(`${url}api/effects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "test-ip.fade",
      target: { asset_id: keywordId },
      timing: { kind: "word_range", start_word_index: keywordStartWordIndex, end_word_index: keywordStartWordIndex + 1 },
      config: { from_opacity: 1, to_opacity: 0.35, interpolation: "linear" },
    }),
  });
  assert.equal(fadeResponse.status, 201);
  const fadedKeywordState = await (await fetch(`${url}api/state`)).json();
  assert.ok(fadedKeywordState.playbackOverlays.some((overlay) => (
    (overlay.effects?.opacity || []).some((effect) => effect.effect_id)
  )));
  await fetch(`${url}api/assets/${encodeURIComponent(keywordId)}`, { method: "DELETE" });

  const imageResponse = await fetch(`${url}api/assets`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "base.image",
      enabled: true,
      lifecycle: { kind: "word_range", start_word_index: keywordStartWordIndex, end_word_index: keywordStartWordIndex + 1 },
      props: {
        image_path: imagePath,
        fit: "contain",
        box: { x: 0.6, y: 0.1, width: 0.3, height: 0.25, unit: "ratio" },
      },
    }),
  });
  assert.equal(imageResponse.status, 201);
  const imageState = await (await fetch(`${url}api/state`)).json();
  assert.equal(imageState.imageOverlayTrack.groupCount, 1);
  assert.equal(imageState.playbackImageOverlays[0].fit, "contain");
  assert.ok(Number.isInteger(imageState.imageOverlayTrack.groups[0].start_word_index));
  assert.ok(Number.isInteger(imageState.imageOverlayTrack.groups[0].end_word_index));
  const servedImageResponse = await fetch(`${url}${imageState.playbackImageOverlays[0].asset_url.slice(1)}`);
  assert.equal(servedImageResponse.status, 200);

  const selectionEnd = Math.min(1, context.words.length - 1);
  const scaleType = imageState.catalog.effectTypes.find((item) => item.id === "base.scale");
  const textType = imageState.catalog.effectTypes.find((item) => item.id === "base.text-style");
  const scalePreset = scaleType.ui.presets.find((item) => item.label === "瞬间放大");
  const textPreset = textType.ui.presets.find((item) => item.label === "大字号、亮黄色");
  const selectionEffectsResponse = await fetch(`${url}api/effects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      replace_range: true,
      enabled: true,
      type: "base.scale",
      target: { asset_id: "video.main" },
      start_word_index: 0,
      end_word_index: selectionEnd,
      config: scalePreset.config,
    }),
  });
  assert.equal(selectionEffectsResponse.status, 201);
  await fetch(`${url}api/effects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      replace_range: true,
      enabled: true,
      type: "base.text-style",
      target: { asset_id: "captions.main" },
      start_word_index: 0,
      end_word_index: selectionEnd,
      config: textPreset.config,
    }),
  });
  const combinedState = await (await fetch(`${url}api/state`)).json();
  assert.ok(combinedState.composition.effects.some((effect) => (
    effect.type === "base.scale" && effect.target.asset_id === "video.main"
  )));
  assert.ok(combinedState.composition.effects.some((effect) => (
    effect.type === "base.text-style" && effect.target.asset_id === "captions.main"
  )));
  assert.ok(combinedState.playbackCaptions.some((caption) => (
    caption.styledLines.flat().some((segment) => Number(segment.style?.font_scale) === 1.25)
  )));

  const outsideBoxResponse = await fetch(`${url}api/assets/${encodeURIComponent(captionsId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ props: { box: { x: 0.8, y: 0.8, width: 0.3, height: 0.3, unit: "ratio" } } }),
  });
  assert.equal(outsideBoxResponse.status, 400);

  const saveProjectResponse = await fetch(`${url}api/save-project`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ currentTime: 0.55, selectedWordIndexes: [0, 1] }),
  });
  assert.equal(saveProjectResponse.status, 200);
  const restoredState = await (await fetch(`${url}api/state`)).json();
  assert.equal(restoredState.editorState.currentTime, 0.55);

  const mediaResponse = await fetch(`${url}media`, { headers: { Range: "bytes=0-99" } });
  assert.equal(mediaResponse.status, 206);

  const eventResponse = await fetch(`${url}api/events`);
  assert.equal(eventResponse.status, 200);
  await eventResponse.body.getReader().read();

  assert.ok(fs.existsSync(path.join(tempDir, "composition.json")));

  process.stdout.write(`wanggan-editing integration passed at ${url}\n`);
} finally {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tempDir, { recursive: true, force: true });
}
