import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadEffects,
  loadProject,
  loadTranscript,
  readJson,
  saveEffects,
  validateEffects,
  writeJson,
} from "./lib/core.mjs";
import { startServer } from "./server.mjs";
import { defaultOverlays, saveOverlays } from "./lib/captions.mjs";

const sourceProject = loadProject(process.argv[2]);
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wanggan-integration-"));
const tempProject = {
  ...readJson(sourceProject.projectPath),
  outputPath: path.join(tempDir, "integration-output.mp4"),
  overlaysFile: "overlays.json",
};
writeJson(path.join(tempDir, "project.json"), tempProject);
const sourceWords = loadTranscript(sourceProject.transcriptPath);
const sourceEffects = loadEffects(sourceProject.effectsPath, sourceWords);
const sourceVideoEffects = sourceEffects.filter((effect) => effect.target === "video.main");
const integrationEffects = sourceVideoEffects.length
  ? sourceVideoEffects
  : validateEffects([{
      effect_type: "short_emphasis",
      start_word_index: 0,
      end_word_index: Math.min(1, sourceWords.length - 1),
    }], sourceWords);
saveEffects(path.join(tempDir, "effects.json"), integrationEffects);
saveOverlays(path.join(tempDir, "overlays.json"), defaultOverlays());
writeJson(path.join(tempDir, "render-status.json"), { state: "idle" });

const { server, url, project } = await startServer(tempDir, 0);
try {
  const reviewHtmlResponse = await fetch(url);
  assert.equal(reviewHtmlResponse.status, 200);
  const reviewHtml = await reviewHtmlResponse.text();
  assert.match(reviewHtml, /id="subtitleToggleButton"[^>]*>启用<\/button>/);
  assert.match(reviewHtml, /id="subtitleResizeHandle"/);
  assert.match(reviewHtml, /id="structuredOverlay"/);
  assert.match(reviewHtml, /id="structuredResizeHandle"/);
  assert.match(reviewHtml, /id="structuredEditor"/);
  assert.match(reviewHtml, /id="newListButton"/);
  assert.equal((reviewHtml.match(/data-selection-effect/g) || []).length, 5);
  assert.match(reviewHtml, /data-effect-type="short_emphasis"[^>]*>短促重点<\/button>/);
  assert.match(reviewHtml, /data-effect-type="large_bright"[^>]*>大字号、亮颜色<\/button>/);
  assert.match(reviewHtml, /data-target="video\.main"/);
  assert.match(reviewHtml, /data-target="overlay\.captions"/);
  assert.doesNotMatch(reviewHtml, /shortEmphasisMenuButton|effect-group__options/);
  assert.doesNotMatch(reviewHtml, /subtitleEnableButton|subtitleRemoveButton|启用字幕|撤下字幕/);

  const reviewAppResponse = await fetch(`${url}app-v2.js`);
  assert.equal(reviewAppResponse.status, 200);
  const reviewApp = await reviewAppResponse.text();
  assert.match(reviewApp, /segment\.style\?\.font_scale/);
  assert.match(reviewApp, /caption\.layout_font_scale/);
  assert.match(reviewApp, /overlay\.style\.bottom/);
  const captionInteractionSource = reviewApp.match(
    /function updateCaptionInteraction[\s\S]*?function resumeCaptionPlayback/,
  )?.[0] || "";
  assert.match(captionInteractionSource, /width: clamp\(start\.width \+ deltaX, 0\.65/);
  assert.doesNotMatch(captionInteractionSource, /height: clamp\(start\.height/);
  assert.match(reviewApp, /segment\.style\?\.color/);
  assert.match(reviewApp, /previewSelectionRange\(range\)/);
  assert.match(reviewApp, /renderStructuredOverlay\(currentStructuredOverlayAt\(time\)\)/);
  assert.match(reviewApp, /saveOverlayGroups/);
  assert.match(reviewApp, /selectedWords\.clear\(\);\s*await loadState\(\);\s*previewSelectionRange\(range\)/);
  assert.match(reviewApp, /clickedEffectAction = event\.target\.closest\?\.\([\s\S]*data-structured-action/);
  assert.match(reviewApp, /!clickedWord && !clickedEffectAction && selectedWords\.size > 0/);
  assert.doesNotMatch(reviewApp, /Number\(segment\.font_scale\)/);
  assert.doesNotMatch(reviewApp, /setShortEmphasisMenu|shortEmphasisOptions/);

  const stateResponse = await fetch(`${url}api/state`);
  assert.equal(stateResponse.status, 200);
  const state = await stateResponse.json();
  assert.ok(state.words.length > 0);
  assert.ok(state.effects.length > 0);
  assert.equal(state.renderEngineVersion, 9);
  assert.ok(Array.isArray(state.playbackEffects));
  assert.ok(state.playbackEffects.length <= state.effects.length);
  assert.ok(Array.isArray(state.playbackCaptions));
  assert.ok(state.playbackCaptions.length > 0);
  assert.ok(Array.isArray(state.playbackOverlays));
  assert.equal(state.playbackOverlays.length, 0);
  assert.equal(state.structuredOverlayTrack.groupCount, 0);
  assert.equal(state.captionTrack.enabled, false);
  assert.equal(state.captionTrack.source, sourceProject.subtitlePath ? "srt" : "transcript");
  assert.equal(state.editorState.currentTime, 0);
  assert.deepEqual(state.editorState.selectedWordIndexes, []);

  const captionToggleResponse = await fetch(`${url}api/overlays/captions`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: true }),
  });
  assert.equal(captionToggleResponse.status, 200);
  const toggledState = await (await fetch(`${url}api/state`)).json();
  assert.equal(toggledState.captionTrack.enabled, true);
  assert.equal(toggledState.overlays.captions.enabled, true);

  const movedBox = { x: 0.18, y: 0.24, width: 0.58, height: 0.32, unit: "ratio" };
  const captionBoxResponse = await fetch(`${url}api/overlays/captions`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ box: movedBox }),
  });
  assert.equal(captionBoxResponse.status, 200);
  const movedState = await (await fetch(`${url}api/state`)).json();
  assert.deepEqual(movedState.captionTrack.box, movedBox);
  assert.deepEqual(movedState.overlays.captions.box, movedBox);
  assert.equal(movedState.playbackCaptions.length, toggledState.playbackCaptions.length);
  assert.ok(movedState.playbackCaptions.every((caption) => Array.isArray(caption.lines)));
  assert.deepEqual(readJson(project.overlaysPath).captions.box, movedBox);

  const listStartWordIndex = Math.max(0, sourceWords.length - 2);
  const listEndWordIndex = sourceWords.length - 1;
  const progressiveListResponse = await fetch(`${url}api/overlays`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...movedState.overlays,
      timed_overlays: [{
        id: "overlay-list-integration",
        type: "progressive_list",
        items: [{
          start_word_index: listStartWordIndex,
          end_word_index: listEndWordIndex,
          display_text: "一、集成验证",
        }],
        source: "ai",
      }],
    }),
  });
  assert.equal(progressiveListResponse.status, 200);
  const progressiveState = await (await fetch(`${url}api/state`)).json();
  assert.equal(progressiveState.overlays.version, 2);
  assert.equal(progressiveState.structuredOverlayTrack.groupCount, 1);
  assert.equal(progressiveState.playbackOverlays.length, 1);
  assert.equal(progressiveState.playbackOverlays[0].items.length, 1);
  assert.equal(
    progressiveState.structuredOverlayTrack.groups[0].items[0].source_text,
    sourceWords.slice(listStartWordIndex, listEndWordIndex + 1).map((word) => word.text).join(""),
  );
  assert.equal(readJson(project.overlaysPath).timed_overlays.length, 1);

  const selectionEnd = Math.min(1, sourceWords.length - 1);
  const selectionEffectsResponse = await fetch(`${url}api/selection-effects`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      start_word_index: 0,
      end_word_index: selectionEnd,
      changes: [
        { target: "video.main", effect_type: "short_emphasis", enabled: true },
        { target: "overlay.captions", effect_type: "large_bright", enabled: true },
      ],
    }),
  });
  assert.equal(selectionEffectsResponse.status, 200);
  const combinedState = await (await fetch(`${url}api/state`)).json();
  assert.ok(combinedState.effects.some((effect) => (
    effect.target === "video.main"
    && effect.effect_type === "short_emphasis"
    && effect.start_word_index === 0
    && effect.end_word_index === selectionEnd
  )));
  assert.ok(combinedState.effects.some((effect) => (
    effect.target === "overlay.captions"
    && effect.effect_type === "large_bright"
    && effect.start_word_index === 0
    && effect.end_word_index === selectionEnd
  )));
  assert.ok(combinedState.playbackEffects.every((effect) => effect.target === "video.main"));
  assert.equal(combinedState.captionTrack.effectCount, 1);
  assert.ok(combinedState.playbackCaptions.some((caption) => (
    caption.styledLines.flat().some((segment) => segment.style?.effect_type === "large_bright")
  )));
  assert.equal(readJson(project.effectsPath).version, 3);

  const removeCaptionEffectResponse = await fetch(`${url}api/selection-effects`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      start_word_index: 0,
      end_word_index: selectionEnd,
      changes: [{
        target: "overlay.captions",
        effect_type: "large_bright",
        enabled: false,
      }],
    }),
  });
  assert.equal(removeCaptionEffectResponse.status, 200);
  const captionRemovedState = await (await fetch(`${url}api/state`)).json();
  assert.equal(captionRemovedState.captionTrack.effectCount, 0);
  assert.ok(captionRemovedState.effects.some((effect) => (
    effect.target === "video.main" && effect.effect_type === "short_emphasis"
  )));

  const outsideBoxResponse = await fetch(`${url}api/overlays/captions`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ box: { x: 0.8, y: 0.8, width: 0.3, height: 0.3 } }),
  });
  assert.equal(outsideBoxResponse.status, 400);
  assert.deepEqual(readJson(project.overlaysPath).captions.box, movedBox);

  const saveProjectResponse = await fetch(`${url}api/save-project`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ currentTime: 0.55, selectedWordIndexes: [0, 1] }),
  });
  assert.equal(saveProjectResponse.status, 200);
  const saveProjectResult = await saveProjectResponse.json();
  assert.equal(saveProjectResult.editorState.currentTime, 0.55);
  assert.deepEqual(saveProjectResult.editorState.selectedWordIndexes, [0, 1]);
  assert.ok(saveProjectResult.editorState.savedAt);
  const savedEditorState = readJson(project.editorStatePath);
  assert.equal(savedEditorState.currentTime, 0.55);
  assert.deepEqual(savedEditorState.selectedWordIndexes, [0, 1]);
  const restoredState = await (await fetch(`${url}api/state`)).json();
  assert.equal(restoredState.editorState.currentTime, 0.55);
  assert.deepEqual(restoredState.editorState.selectedWordIndexes, [0, 1]);

  const mediaResponse = await fetch(`${url}media`, { headers: { Range: "bytes=0-99" } });
  assert.equal(mediaResponse.status, 206);
  assert.equal((await mediaResponse.arrayBuffer()).byteLength, 100);

  const eventResponse = await fetch(`${url}api/events`);
  assert.equal(eventResponse.status, 200);
  const reader = eventResponse.body.getReader();
  const decoder = new TextDecoder();
  await reader.read();

  const words = loadTranscript(project.transcriptPath);
  const effects = loadEffects(project.effectsPath, words);
  const firstVideoEffect = effects.find((effect) => effect.target === "video.main");
  saveEffects(project.effectsPath, effects.map((effect) => effect.id === firstVideoEffect.id
    ? { ...effect, effect_type: effect.effect_type.startsWith("short_") ? "long_emphasis" : "short_emphasis" }
    : effect));

  const eventText = await Promise.race([
    (async () => {
      let text = "";
      while (!text.includes("event: state")) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      return text;
    })(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("SSE 热重载超时")), 1500)),
  ]);
  assert.match(eventText, /event: state/);

  const first = firstVideoEffect;
  const patchResponse = await fetch(`${url}api/effects/${encodeURIComponent(first.id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      effect_type: first.effect_type === "short_negative" ? "long_negative" : "short_negative",
      start_word_index: first.start_word_index,
      end_word_index: first.end_word_index,
    }),
  });
  assert.equal(patchResponse.status, 200);
  const patched = await patchResponse.json();
  const patchedFirst = patched.effects.find((effect) => effect.id === first.id);
  assert.equal(patchedFirst.effect_type, first.effect_type === "short_negative" ? "long_negative" : "short_negative");
  assert.equal(patchedFirst.source, first.source);
  assert.equal(patchedFirst.human_modified, true);

  await reader.cancel();
  process.stdout.write(`wanggan-editing integration passed at ${url}\n`);
} finally {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tempDir, { recursive: true, force: true });
}
