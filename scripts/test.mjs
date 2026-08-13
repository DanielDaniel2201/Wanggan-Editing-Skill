import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  WangganError,
  defaultEditorState,
  validateEditorState,
  validateTranscript,
} from "./lib/core.mjs";
import { parseSrt } from "./lib/srt.mjs";
import { alignCuesToWords, resolveWordRange } from "./lib/timeline.mjs";
import { layoutCaptionText, splitCaptionLines } from "./lib/text-layout.mjs";
import { loadProfile } from "./lib/profile-loader.mjs";
import {
  applyEffectRange,
  emptyComposition,
  nextAssetId,
  validateComposition,
} from "./lib/composition.mjs";
import { compileProject } from "./lib/compiler.mjs";
import { buildFilter, buildScaleExpression, scalePercentAtTime } from "./lib/render.mjs";

const words = validateTranscript([
  { text: "这", start: 0.1, end: 0.2 },
  { text: "是", start: 0.2, end: 0.3 },
  { text: "重", start: 0.4, end: 0.5 },
  { text: "点", start: 0.5, end: 0.6 },
  { text: "危", start: 0.8, end: 0.9 },
  { text: "险", start: 0.9, end: 1.0 },
]);

assert.equal(words.length, 6);
assert.equal(words[2].wordIndex, 2);
assert.deepEqual(defaultEditorState().selectedWordIndexes, []);
assert.deepEqual(
  validateEditorState({
    version: 1,
    savedAt: "2026-08-08T00:00:00.000Z",
    currentTime: 0.55,
    selectedWordIndexes: [1, 0, 1],
  }, { wordCount: words.length, duration: 1.2 }).selectedWordIndexes,
  [0, 1],
);
assert.throws(
  () => validateEditorState({ version: 1, currentTime: 0, selectedWordIndexes: [99] }, {
    wordCount: words.length,
    duration: 1.2,
  }),
  /选择范围无效/,
);

const profile = await loadProfile("base");
const project = {
  projectDir: process.cwd(),
  videoPath: "input.mp4",
  subtitlePath: "input.srt",
  displayWidth: 720,
  displayHeight: 1280,
  duration: 1.2,
  inputs: { captions: { path: "input.srt" } },
};
const captionCues = [
  { id: "caption-001", start: 0.1, end: 0.6, text: "这是重点", start_word_index: 0, end_word_index: 3, source: "srt" },
  { id: "caption-002", start: 0.8, end: 1.0, text: "危险", start_word_index: 4, end_word_index: 5, source: "srt" },
];
project.inputs.captions.cues = captionCues;

function compositionWith(assets = [], effects = []) {
  const base = emptyComposition(profile);
  return validateComposition({
    version: 1,
    assets: [
      ...base.assets.map((asset) => (
        asset.id === "captions.main"
          ? { ...asset, enabled: true, props: { ...asset.props, cue_overrides: { "caption-001": { font_family: "华文中宋", font_size_ratio: 0.075 } } } }
          : asset
      )),
      ...assets,
    ],
    effects,
  }, profile, words, project);
}

async function compileOf(composition) {
  return compileProject(project, {
    context: {
      project,
      profile,
      words,
      captionCues,
      lockStatus: { ok: true, changes: [] },
    },
    composition,
  });
}

const scaleEmphasis = {
  id: "effect.001",
  type: "base.scale",
  target: { asset_id: "video.main" },
  timing: { kind: "word_range", start_word_index: 2, end_word_index: 3 },
  config: { from_scale: 1, to_scale: 1.2, interpolation: "step", underflow_fill: "black" },
  origin: { created_by: "agent", human_modified: false },
};
const scaleNegative = {
  id: "effect.002",
  type: "base.scale",
  target: { asset_id: "video.main" },
  timing: { kind: "word_range", start_word_index: 4, end_word_index: 5 },
  config: { from_scale: 1, to_scale: 0.75, interpolation: "linear", underflow_fill: "black" },
  origin: { created_by: "agent", human_modified: false },
};
const textStyle = {
  id: "effect.003",
  type: "base.text-style",
  target: { asset_id: "captions.main" },
  timing: { kind: "word_range", start_word_index: 2, end_word_index: 3 },
  config: { font_scale: 1.25, color: "#FFF08A" },
  origin: { created_by: "agent", human_modified: false },
};

const combined = compositionWith([], [scaleEmphasis, textStyle]);
assert.equal(combined.effects.length, 2);
assert.deepEqual(combined.effects.map((effect) => effect.target.asset_id).sort(), [
  "captions.main",
  "video.main",
]);

assert.throws(
  () => compositionWith([], [{ ...scaleEmphasis, timing: {} }]),
  /timing\.kind/,
);

const cueStyleComposition = compositionWith([], [{
  ...textStyle,
  id: "effect.cue",
  timing: { kind: "cue", cue_id: "caption-001" },
}]);
const cueStyleCompiled = await compileOf(cueStyleComposition);
assert.ok(cueStyleCompiled.playbackCaptions[0].styledLines.flat().some((segment) => (
  Number(segment.style?.font_scale) === 1.25
)));

assert.throws(
  () => compositionWith([], [
    { ...scaleEmphasis, id: "effect.010" },
    { ...scaleNegative, id: "effect.011", timing: { kind: "word_range", start_word_index: 3, end_word_index: 5 } },
  ]),
  /重叠/,
);

assert.throws(
  () => compositionWith([], [{
    ...textStyle,
    id: "effect.bad",
    target: { asset_id: "video.main" },
  }]),
  /不匹配/,
);

assert.throws(
  () => compositionWith([], [{
    ...scaleEmphasis,
    type: "missing.effect",
  }]),
  /未注册/,
);

const compiled = await compileOf(compositionWith([], [scaleEmphasis, scaleNegative]));
assert.equal(compiled.playbackEffects[0].scale_percent, 120);
assert.equal(compiled.playbackEffects[0].motion, "cut");
assert.equal(compiled.playbackEffects[1].scale_percent, 75);
assert.equal(compiled.playbackEffects[1].motion, "progressive");
assert.equal(scalePercentAtTime(compiled.playbackEffects[0], 0.5), 120);
assert.equal(scalePercentAtTime(compiled.playbackEffects[1], 0.9), 87.5);
assert.equal(scalePercentAtTime(compiled.playbackEffects[1], 1.0), 100);

const expression = buildScaleExpression(compiled.playbackEffects);
assert.match(expression, /gte\(t,0\.4\)\*lt\(t,0\.6\),1\.2/);
assert.match(expression, /gte\(t,0\.8\)\*lt\(t,1\),1\+\(-0\.25\)\*\(\(t-0\.8\)\/0\.2\)/);

const joined = compositionWith([], [
  scaleEmphasis,
  {
    ...scaleEmphasis,
    id: "effect.004",
    timing: { kind: "word_range", start_word_index: 4, end_word_index: 5 },
  },
]);
const joinedCompiled = await compileOf(joined);
assert.equal(joinedCompiled.playbackEffects.length, 1);
assert.equal(joinedCompiled.playbackEffects[0].start, 0.4);
assert.equal(joinedCompiled.playbackEffects[0].end, 1);
assert.match(buildScaleExpression(joinedCompiled.playbackEffects), /gte\(t,0\.4\)\*lt\(t,1\),1\.2/);
assert.doesNotMatch(buildScaleExpression(joinedCompiled.playbackEffects), /lt\(t,0\.6\)/);

const filter = buildFilter({ displayWidth: 720, displayHeight: 1280 }, compiled.playbackEffects);
assert.match(filter, /pad=864:1536/);
assert.match(filter, /crop=720:1280/);
assert.match(filter, /black/);

const imageEffectFilter = buildFilter(
  { displayWidth: 720, displayHeight: 1280 },
  [],
  {
    imageOverlays: [{
      input_index: 1,
      start: 0.1,
      end: 1,
      box: { x: 0.5, y: 0.1, width: 0.4, height: 0.3 },
      effects: {
        scale: [{
          start: 0.2,
          end: 0.6,
          from_scale: 1,
          to_scale: 1.2,
          interpolation: "linear",
        }],
        opacity: [{
          start: 0.2,
          end: 0.6,
          from_opacity: 1,
          to_opacity: 0.35,
          interpolation: "linear",
        }],
      },
      suppression_ranges: [{ start: 0.4, end: 0.5 }],
    }],
  },
);
assert.match(imageEffectFilter, /eval=frame/);
assert.match(imageEffectFilter, /alpha\(X,Y\)/);
assert.match(imageEffectFilter, /not\(gte\(t,0\.4\)\*lt\(t,0\.5\)\)/);

const srtCues = parseSrt(`1\n00:00:00,100 --> 00:00:00,600\n这是重点\n\n2\n00:00:00,800 --> 00:00:01,000\n危险\n`, { duration: 1.2 });
assert.equal(srtCues.length, 2);
assert.equal(srtCues[0].text, "这是重点");
assert.equal(srtCues[1].end, 1);
assert.throws(
  () => parseSrt(`1\n00:00:00,100 --> 00:00:00,900\n一\n\n2\n00:00:00,800 --> 00:00:01,000\n二\n`),
  /重叠/,
);
const aligned = alignCuesToWords(srtCues, words);
assert.equal(aligned[0].start_word_index, 0);
assert.equal(aligned[0].end_word_index, 3);
assert.throws(
  () => alignCuesToWords(parseSrt(`1\n00:00:00,100 --> 00:00:01,000\n完全对不上\n`, { duration: 1.2 }), words),
  /无法顺序对齐/,
);

assert.deepEqual(splitCaptionLines("安全安全还是安全", 4), ["安全安全", "还是安全"]);
assert.deepEqual(layoutCaptionText("Codex Claude Code", 12), {
  lines: ["Codex Claude Code"],
  fontScale: 1,
});
const balancedEnglish = layoutCaptionText("OpenAI Codex Claude Code", 6);
assert.deepEqual(balancedEnglish.lines, ["OpenAI Codex", "Claude Code"]);
assert.ok(balancedEnglish.fontScale >= 0.85 && balancedEnglish.fontScale < 1);

const captionCompiled = await compileOf(compositionWith([], [textStyle]));
assert.equal(captionCompiled.captionTrack.enabled, true);
assert.equal(captionCompiled.captionTrack.effectCount, 1);
assert.equal(captionCompiled.playbackCaptions[0].font_family, "华文中宋");
assert.equal(captionCompiled.playbackCaptions[0].font_size_ratio, 0.075);
assert.equal(captionCompiled.playbackCaptions[0].font_size, 54);
const emphasizedSegment = captionCompiled.playbackCaptions
  .flatMap((cue) => cue.styledLines.flat())
  .find((segment) => Number(segment.style?.font_scale) === 1.25);
assert.equal(emphasizedSegment.text, "重点");
assert.equal(emphasizedSegment.style.color, "#FFF08A");
assert.match(captionCompiled.assText, /PlayResX: 720/);
assert.match(captionCompiled.assText, /YCbCr Matrix: None/);
assert.match(captionCompiled.assText, /\\fn华文中宋/);
assert.match(captionCompiled.assText, /\\fs\d+\\c&H008AF0FF/);

const listComposition = compositionWith([{
  id: "list.001",
  type: "base.list",
  enabled: true,
  source: { kind: "agent-generated" },
  lifecycle: { kind: "word_range", start_word_index: 0, end_word_index: 5 },
  props: {
    items: [
      { start_word_index: 0, end_word_index: 1, display_text: "一、这是" },
      { start_word_index: 4, end_word_index: 5, display_text: "二、危险" },
    ],
  },
  origin: { created_by: "agent", human_modified: false },
}], [{
  id: "effect.020",
  type: "base.progressive-reveal",
  target: { asset_id: "list.001" },
  timing: { kind: "asset_items" },
  config: { retain_until: "asset_end" },
  origin: { created_by: "agent", human_modified: false },
}]);
const listCompiled = await compileOf(listComposition);
assert.equal(listCompiled.structuredOverlayTrack.groupCount, 1);
assert.equal(listCompiled.playbackOverlays.length, 2);
assert.equal(listCompiled.playbackOverlays[0].start, 0.1);
assert.equal(listCompiled.playbackOverlays[0].end, 0.8);
assert.equal(listCompiled.playbackOverlays[0].items.length, 1);
assert.equal(listCompiled.playbackOverlays[1].items.length, 2);
assert.equal(listCompiled.structuredOverlayTrack.groups[0].fontSize, 32);
assert.equal(listCompiled.structuredOverlayTrack.groups[0].requiredHeight, 98);
assert.deepEqual(
  listCompiled.suppressionRanges.map((range) => [range.start, range.end]),
  [[0.1, 0.3], [0.8, 1]],
);
assert.deepEqual(listCompiled.playbackCaptions.map((cue) => cue.text), ["重点"]);
assert.doesNotMatch(listCompiled.assText, /\\fad\(/);

const imageOnlySuppressionProfile = {
  ...profile,
  constraints: profile.constraints.map((constraint) => (
    constraint.kind === "suppress"
      ? { ...constraint, targets: ["base.image"] }
      : constraint
  )),
};
const imageOnlySuppressionComposition = validateComposition(
  listComposition,
  imageOnlySuppressionProfile,
  words,
  project,
);
const imageOnlySuppressionCompiled = await compileProject(project, {
  context: {
    project,
    profile: imageOnlySuppressionProfile,
    words,
    captionCues,
    lockStatus: { ok: true, changes: [] },
  },
  composition: imageOnlySuppressionComposition,
});
assert.deepEqual(
  imageOnlySuppressionCompiled.playbackCaptions.map((cue) => cue.text),
  captionCues.map((cue) => cue.text),
);

const keywordComposition = compositionWith([{
  id: "keywords.001",
  type: "base.keywords",
  enabled: true,
  source: { kind: "agent-generated" },
  lifecycle: { kind: "word_range", start_word_index: 0, end_word_index: 5 },
  props: {
    layout: "auto",
    style: { font_family: "华文中宋", font_size_ratio: 0.08 },
    items: [
      { start_word_index: 0, end_word_index: 1, display_text: "普通人" },
      { start_word_index: 2, end_word_index: 3, display_text: "也能" },
      { start_word_index: 4, end_word_index: 5, display_text: "做网站" },
    ],
  },
  origin: { created_by: "agent", human_modified: false },
}], [
  {
    id: "effect.030",
    type: "base.progressive-reveal",
    target: { asset_id: "keywords.001" },
    timing: { kind: "asset_items" },
    config: { retain_until: "asset_end" },
    origin: { created_by: "agent", human_modified: false },
  },
  {
    id: "effect.031",
    type: "base.pop",
    target: { asset_id: "keywords.001" },
    timing: { kind: "item_enter" },
    config: {},
    origin: { created_by: "agent", human_modified: false },
  },
]);
const keywordCompiled = await compileOf(keywordComposition);
assert.equal(keywordCompiled.structuredOverlayTrack.groups[0].style.color, "#FFF08A");
assert.deepEqual(keywordCompiled.composition.assets.find((asset) => asset.id === "keywords.001").props.items.map((item) => item.box), [
  { x: 0.13, y: 0.139167, width: 0.24, height: 0.055, unit: "ratio" },
  { x: 0.38, y: 0.139167, width: 0.24, height: 0.055, unit: "ratio" },
  { x: 0.63, y: 0.139167, width: 0.24, height: 0.055, unit: "ratio" },
]);
assert.equal(keywordCompiled.playbackOverlays.length, 3);
assert.equal(new Set(keywordCompiled.playbackOverlays.map((overlay) => overlay.fontSize)).size, 1);
assert.equal(keywordCompiled.playbackOverlays[0].fontSize, 58);
assert.match(keywordCompiled.assText, /\\an5\\pos\(180,213\)/);
assert.match(keywordCompiled.assText, /\\fscx85\\fscy85\\alpha&HFF&\\t\(0,180,\\fscx100\\fscy100\\alpha&H00&\)/);
assert.equal((keywordCompiled.assText.match(/\\t\(0,180,/g) || []).length, 3);

assert.throws(
  () => compositionWith([{
    id: "keywords.bad",
    type: "base.keywords",
    enabled: true,
    source: { kind: "agent-generated" },
    lifecycle: { kind: "word_range", start_word_index: 0, end_word_index: 0 },
    props: { items: [{ start_word_index: 0, end_word_index: 0, display_text: "词" }] },
    origin: { created_by: "agent", human_modified: false },
  }]),
  /不符合 Schema/,
);

const testIp = await loadProfile(path.join(fileURLToPath(new URL(".", import.meta.url)), "fixtures/profiles/test-ip"));
const fadeComposition = validateComposition({
  version: 1,
  assets: [
    ...emptyComposition(testIp).assets,
    {
      id: "keywords.001",
      type: "base.keywords",
      enabled: true,
      source: { kind: "agent-generated" },
      lifecycle: { kind: "word_range", start_word_index: 0, end_word_index: 1 },
      props: { items: [{ start_word_index: 0, end_word_index: 1, display_text: "这是" }] },
      origin: { created_by: "agent", human_modified: false },
    },
  ],
  effects: [{
    id: "effect.040",
    type: "test-ip.fade",
    target: { asset_id: "keywords.001" },
    timing: { kind: "word_range", start_word_index: 0, end_word_index: 1 },
    config: { from_opacity: 1, to_opacity: 0.35, interpolation: "linear" },
    origin: { created_by: "agent", human_modified: false },
  }],
}, testIp, words, project);
assert.ok(fadeComposition.effects.some((effect) => effect.type === "test-ip.fade"));
const fadeCompiled = await compileProject(project, {
  context: {
    project,
    profile: testIp,
    words,
    captionCues,
    lockStatus: { ok: true, changes: [] },
  },
  composition: fadeComposition,
});
assert.ok(fadeCompiled.catalog.effectTypes.some((item) => item.id === "test-ip.fade"));
assert.ok(fadeCompiled.playbackScene.assets.some((asset) => asset.id === "keywords.001"));
assert.match(fadeCompiled.assText, /\\alpha&H00&\\t\(0,200,.*\\alpha&HA6&/);

const styledKeywordComposition = validateComposition({
  ...fadeComposition,
  effects: [{
    id: "effect.041",
    type: "base.text-style",
    target: { asset_id: "keywords.001" },
    timing: { kind: "word_range", start_word_index: 0, end_word_index: 1 },
    config: { font_scale: 1.25, color: "#FFF08A" },
    origin: { created_by: "agent", human_modified: false },
  }],
}, testIp, words, project);
const styledKeywordCompiled = await compileProject(project, {
  context: {
    project,
    profile: testIp,
    words,
    captionCues,
    lockStatus: { ok: true, changes: [] },
  },
  composition: styledKeywordComposition,
});
assert.match(styledKeywordCompiled.assText, /\\fs68\\c&H008AF0FF/);

const rangeApplied = applyEffectRange(emptyComposition(profile), {
  enabled: true,
  type: "base.scale",
  target: { asset_id: "video.main" },
  start_word_index: 2,
  end_word_index: 3,
  config: scaleEmphasis.config,
}, words);
assert.equal(rangeApplied.effects[0].type, "base.scale");
assert.equal(resolveWordRange(words, 2, 3).source_text, "重点");
assert.equal(nextAssetId("base.keywords", rangeApplied.assets), "keywords.001");

assert.throws(() => validateTranscript([{ text: "错", start: 1, end: 0.5 }]), /start < end/);

process.stdout.write("wanggan-editing tests passed\n");
