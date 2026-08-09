import assert from "node:assert/strict";
import {
  WangganError,
  defaultEditorState,
  effectsDocument,
  resolveEffect,
  validateEffects,
  validateEditorState,
  validateTranscript,
} from "./lib/core.mjs";
import {
  buildFilter,
  buildScaleExpression,
  compilePlaybackEffects,
  scalePercentAtTime,
} from "./lib/render.mjs";
import {
  buildAss,
  captionsFromWords,
  compileCaptionTrack,
  defaultOverlays,
  parseSrt,
  splitCaptionLines,
  validateOverlays,
} from "./lib/captions.mjs";

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

const shortEmphasis = resolveEffect({
  effect_type: "short_emphasis",
  start_word_index: 2,
  end_word_index: 3,
}, words, { id: "effect-001" });
assert.deepEqual(
  {
    target: shortEmphasis.target,
    effect_type: shortEmphasis.effect_type,
    start_word_index: shortEmphasis.start_word_index,
    end_word_index: shortEmphasis.end_word_index,
    text: shortEmphasis.text,
  },
  {
    target: "video.main",
    effect_type: "short_emphasis",
    start_word_index: 2,
    end_word_index: 3,
    text: "重点",
  },
);

const longNegative = resolveEffect({
  effect_type: "long_negative",
  start_word_index: 4,
  end_word_index: 5,
}, words, { id: "effect-002" });
const effects = validateEffects([shortEmphasis, longNegative], words);
assert.equal(effectsDocument(effects).version, 3);
assert.equal(effects[1].effect_type, "long_negative");

assert.throws(
  () => resolveEffect({ effect_type: "long_emphasis", start: 0.41, end: 0.6 }, words),
  (error) => error instanceof WangganError && error.details.nearestStart.length > 0,
);

assert.throws(
  () => resolveEffect({
    effect_type: "long_emphasis",
    start_word_index: 0,
    end_word_index: 1,
    params: { scale_percent: 130 },
  }, words),
  /不能提交 params/,
);

assert.throws(
  () => validateEffects([
    { effect_type: "short_emphasis", start_word_index: 0, end_word_index: 3 },
    { effect_type: "short_negative", start_word_index: 3, end_word_index: 5 },
  ], words),
  /重叠/,
);

const combinedTargetEffects = validateEffects([
  { effect_type: "short_emphasis", start_word_index: 2, end_word_index: 3 },
  { effect_type: "large_bright", start_word_index: 2, end_word_index: 3 },
], words);
assert.equal(combinedTargetEffects.length, 2);
assert.deepEqual(combinedTargetEffects.map((effect) => effect.target).sort(), [
  "overlay.captions",
  "video.main",
]);
assert.throws(
  () => resolveEffect({
    target: "video.main",
    effect_type: "large_bright",
    start_word_index: 2,
    end_word_index: 3,
  }, words),
  /不匹配/,
);

assert.throws(
  () => resolveEffect({ effect_type: "unknown", start_word_index: 0, end_word_index: 1 }, words),
  /不支持的 effect_type/,
);

const playbackEffects = compilePlaybackEffects(effects);
assert.equal(playbackEffects[0].scale_percent, 120);
assert.equal(playbackEffects[0].motion, "cut");
assert.equal(playbackEffects[1].scale_percent, 75);
assert.equal(playbackEffects[1].motion, "progressive");
assert.equal(scalePercentAtTime(playbackEffects[0], 0.5), 120);
assert.equal(scalePercentAtTime(playbackEffects[1], 0.9), 87.5);
assert.equal(scalePercentAtTime(playbackEffects[1], 1.0), 100);

const expression = buildScaleExpression(effects);
assert.match(expression, /gte\(t,0\.4\)\*lt\(t,0\.6\),1\.2/);
assert.match(expression, /gte\(t,0\.8\)\*lt\(t,1\),1\+\(-0\.25\)\*\(\(t-0\.8\)\/0\.2\)/);

const joinedEffects = validateEffects([
  { effect_type: "short_emphasis", start_word_index: 2, end_word_index: 3 },
  { effect_type: "short_emphasis", start_word_index: 4, end_word_index: 5 },
], words);
const joinedPlaybackEffects = compilePlaybackEffects(joinedEffects);
assert.equal(joinedPlaybackEffects.length, 1);
assert.equal(joinedPlaybackEffects[0].start, 0.4);
assert.equal(joinedPlaybackEffects[0].end, 1);
assert.match(buildScaleExpression(joinedEffects), /gte\(t,0\.4\)\*lt\(t,1\),1\.2/);
assert.doesNotMatch(buildScaleExpression(joinedEffects), /lt\(t,0\.6\)/);

const filter = buildFilter({ displayWidth: 720, displayHeight: 1280 }, effects);
assert.match(filter, /pad=864:1536/);
assert.match(filter, /crop=720:1280/);
assert.match(filter, /black/);

const srtCues = parseSrt(`1\n00:00:00,100 --> 00:00:00,600\n这是重点\n\n2\n00:00:00,800 --> 00:00:01,000\n危险\n`, { duration: 1.2 });
assert.equal(srtCues.length, 2);
assert.equal(srtCues[0].text, "这是重点");
assert.equal(srtCues[1].end, 1);
assert.throws(
  () => parseSrt(`1\n00:00:00,100 --> 00:00:00,900\n一\n\n2\n00:00:00,800 --> 00:00:01,000\n二\n`),
  /重叠/,
);

const generatedCues = captionsFromWords(words, { maxChars: 2, minChars: 2, pauseSeconds: 0.15 });
assert.deepEqual(generatedCues.map((cue) => cue.text), ["这是", "重点", "危险"]);
assert.deepEqual(splitCaptionLines("安全安全还是安全", 4), ["安全安全", "还是安全"]);

const overlays = defaultOverlays();
overlays.captions.enabled = true;
overlays.captions.box = { x: 0.18, y: 0.24, width: 0.58, height: 0.32, unit: "ratio" };
const normalizedOverlays = validateOverlays(overlays);
assert.deepEqual(normalizedOverlays.captions.box, overlays.captions.box);
assert.throws(
  () => validateOverlays({
    ...overlays,
    captions: {
      ...overlays.captions,
      box: { x: 0.8, y: 0.8, width: 0.3, height: 0.3, unit: "ratio" },
    },
  }),
  /不能超出视频画面/,
);
const captionProject = {
  displayWidth: 720,
  displayHeight: 1280,
  duration: 1.2,
  transcriptPath: "transcript.json",
  subtitlePath: null,
};
const captionEffects = validateEffects([
  { effect_type: "large_bright", start_word_index: 2, end_word_index: 3 },
], words);
const captionTrack = compileCaptionTrack(captionProject, words, normalizedOverlays, captionEffects);
assert.equal(captionTrack.enabled, true);
assert.equal(captionTrack.source, "transcript");
assert.equal(captionTrack.effectCount, 1);
assert.ok(captionTrack.cues.length > 0);
const emphasizedSegment = captionTrack.cues
  .flatMap((cue) => cue.styledLines.flat())
  .find((segment) => segment.style?.effect_type === "large_bright");
assert.equal(emphasizedSegment.text, "重点");
assert.equal(emphasizedSegment.style.font_scale, 1.25);
assert.equal(emphasizedSegment.style.color, "#FFF08A");
const ass = buildAss(captionProject, captionTrack);
assert.match(ass, /PlayResX: 720/);
assert.match(ass, /Dialogue: 0/);
assert.match(ass, /Noto Sans SC/);
assert.match(ass, /\\fs\d+\\c&H008AF0FF/);
assert.equal((ass.match(/\\pos\(338,717\)/g) || []).length, captionTrack.cues.length);
const captionFilter = buildFilter({ displayWidth: 720, displayHeight: 1280 }, effects, {
  captionAssFile: "render-captions.ass",
});
assert.match(captionFilter, /\[base\];\[base\]ass=filename='render-captions\.ass'\[v\]/);

assert.throws(() => validateTranscript([{ text: "错", start: 1, end: 0.5 }]), /start < end/);

process.stdout.write("wanggan-editing tests passed\n");
