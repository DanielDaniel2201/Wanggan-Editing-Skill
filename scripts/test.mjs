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
  compileScreenOverlays,
  compileStructuredOverlayTrack,
  defaultOverlays,
  layoutCaptionText,
  normalizedFontFamily,
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
assert.deepEqual(layoutCaptionText("Codex Claude Code", 12), {
  lines: ["Codex Claude Code"],
  fontScale: 1,
});
const balancedEnglish = layoutCaptionText("OpenAI Codex Claude Code", 6);
assert.deepEqual(balancedEnglish.lines, ["OpenAI Codex", "Claude Code"]);
assert.ok(balancedEnglish.fontScale >= 0.85 && balancedEnglish.fontScale < 1);
const balancedChinese = layoutCaptionText("安全安全还是安全", 4);
assert.deepEqual(balancedChinese.lines, ["安全安全", "还是安全"]);
assert.equal(balancedChinese.fontScale, 1);

const overlays = defaultOverlays();
overlays.captions.enabled = true;
overlays.captions.box = { x: 0.18, y: 0.24, width: 0.58, height: 0.32, unit: "ratio" };
overlays.captions.cue_fonts = { "caption-001": "华文中宋" };
overlays.captions.cue_font_size_ratios = { "caption-001": 0.075 };
const normalizedOverlays = validateOverlays(overlays);
assert.equal(normalizedOverlays.version, 2);
assert.deepEqual(normalizedOverlays.timed_overlays, []);
assert.deepEqual(normalizedOverlays.captions.box, overlays.captions.box);
assert.equal(normalizedOverlays.captions.style.font_family, "Microsoft YaHei");
assert.equal(normalizedOverlays.captions.cue_fonts["caption-001"], "华文中宋");
assert.equal(normalizedOverlays.captions.cue_font_size_ratios["caption-001"], 0.075);
assert.equal(normalizedFontFamily("Noto Sans SC"), "Microsoft YaHei");
assert.throws(() => normalizedFontFamily("SimSun"), /只支持默认粗黑体或华文中宋/);
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
assert.equal(captionTrack.cues[0].font_family, "华文中宋");
assert.equal(captionTrack.cues[0].font_size_ratio, 0.075);
assert.equal(captionTrack.cues[0].font_size, 54);
const emphasizedSegment = captionTrack.cues
  .flatMap((cue) => cue.styledLines.flat())
  .find((segment) => segment.style?.effect_type === "large_bright");
assert.equal(emphasizedSegment.text, "重点");
assert.equal(emphasizedSegment.style.font_scale, 1.25);
assert.equal(emphasizedSegment.style.color, "#FFF08A");
assert.ok(captionTrack.cues.every((cue) => cue.lines.length <= 2));
assert.ok(captionTrack.cues.every((cue) => cue.layout_font_scale > 0 && cue.layout_font_scale <= 1));
const ass = buildAss(captionProject, captionTrack);
assert.match(ass, /PlayResX: 720/);
assert.match(ass, /YCbCr Matrix: None/);
assert.match(ass, /Style: Default,[^\n]*,2,0,2,0,0,0,1/);
assert.match(ass, /Dialogue: 0/);
assert.match(ass, /Microsoft YaHei/);
assert.match(ass, /\\fn华文中宋/);
assert.match(ass, /\\fn华文中宋\\fs54/);
assert.match(ass, /\\fs\d+\\c&H008AF0FF/);
assert.match(ass, /\\pos\(338,717\)\\fn华文中宋\\fs\d+/);
assert.equal((ass.match(/\\pos\(338,717\)/g) || []).length, captionTrack.cues.length);
const captionFilter = buildFilter({ displayWidth: 720, displayHeight: 1280 }, effects, {
  overlayAssFile: "render-overlays.ass",
});
assert.match(captionFilter, /\[base\];\[base\]ass=filename='render-overlays\.ass'\[v\]/);

const imageOverlays = validateOverlays({
  ...normalizedOverlays,
  timed_overlays: [{
    id: "overlay-image-test",
    type: "image",
    image_path: "poster-wide.png",
    box: { x: 0.55, y: 0.08, width: 0.38, height: 0.22 },
    start_word_index: 0,
    end_word_index: 1,
    source: "ai",
  }],
}, { words });
const imageOverlay = imageOverlays.timed_overlays[0];
assert.equal(imageOverlay.type, "image");
assert.equal(imageOverlay.fit, "contain");
assert.equal(imageOverlay.start, 0.1);
assert.equal(imageOverlay.end, 0.3);
assert.equal(imageOverlay.source_text, "这是");
assert.deepEqual(imageOverlay.box, {
  x: 0.55,
  y: 0.08,
  width: 0.38,
  height: 0.22,
  unit: "ratio",
});
const compiledImageScreen = compileScreenOverlays(captionProject, words, imageOverlays, captionEffects);
assert.equal(compiledImageScreen.structuredTrack.groupCount, 0);
assert.equal(compiledImageScreen.imageTrack.groupCount, 1);
assert.equal(compiledImageScreen.playbackImageOverlays.length, 1);
assert.equal(compiledImageScreen.playbackCaptions.length, captionTrack.cues.length);
assert.match(compiledImageScreen.playbackImageOverlays[0].asset_url, /overlay-images\/overlay-image-test/);
const imageFilter = buildFilter({ displayWidth: 720, displayHeight: 1280 }, effects, {
  imageOverlays: [{ ...imageOverlay, input_index: 1 }],
  overlayAssFile: "render-overlays.ass",
});
assert.match(imageFilter, /\[1:v\]scale=w=274:h=282:force_original_aspect_ratio=decrease/);
assert.match(imageFilter, /enable='gte\(t,0\.1\)\*lt\(t,0\.3\)'/);
assert.match(imageFilter, /\(274-overlay_w\)\/2/);
assert.match(imageFilter, /\[base1\]ass=filename='render-overlays\.ass'\[v\]/);
assert.throws(
  () => validateOverlays({
    ...normalizedOverlays,
    timed_overlays: [{
      type: "image",
      image_path: "unsupported.svg",
      start_word_index: 0,
      end_word_index: 1,
    }],
  }, { words }),
  /只支持 PNG、JPG、JPEG、WebP 或 BMP/,
);

const progressiveOverlays = validateOverlays({
  ...normalizedOverlays,
  timed_overlays: [{
    id: "overlay-list-test",
    type: "progressive_list",
    items: [
      { start_word_index: 0, end_word_index: 1, display_text: "一、这是" },
      { start_word_index: 4, end_word_index: 5, display_text: "二、危险" },
    ],
    source: "ai",
  }],
}, { words });
const structuredTrack = compileStructuredOverlayTrack(captionProject, words, progressiveOverlays);
assert.equal(structuredTrack.groupCount, 1);
assert.equal(structuredTrack.states.length, 2);
assert.equal(structuredTrack.states[0].start, 0.1);
assert.equal(structuredTrack.states[0].end, 0.8);
assert.equal(structuredTrack.states[0].items.length, 1);
assert.equal(structuredTrack.states[1].items.length, 2);
assert.equal(structuredTrack.groups[0].fontSize, 32);
assert.equal(structuredTrack.groups[0].requiredHeight, 98);
assert.equal(structuredTrack.groups[0].box.height, Number((98 / 1280).toFixed(6)));
assert.deepEqual(
  structuredTrack.suppressionRanges.map((range) => [range.start, range.end]),
  [[0.1, 0.3], [0.8, 1]],
);
assert.equal(progressiveOverlays.timed_overlays[0].items[0].source_text, "这是");
assert.equal(progressiveOverlays.timed_overlays[0].enter_animation, "none");
const compiledScreen = compileScreenOverlays(
  captionProject,
  words,
  progressiveOverlays,
  captionEffects,
);
assert.deepEqual(compiledScreen.playbackCaptions.map((cue) => cue.text), ["重点"]);
assert.equal(compiledScreen.playbackOverlays.length, 2);
const overlayAss = buildAss(captionProject, compiledScreen.captionTrack, compiledScreen.structuredTrack);
assert.match(overlayAss, /Dialogue: 10/);
assert.match(overlayAss, /\\bord1/);
assert.match(overlayAss, /一、这是/);
assert.match(overlayAss, /二、危险/);
assert.doesNotMatch(overlayAss, /Dialogue: 0[^\n]*这是/);
assert.doesNotMatch(overlayAss, /\\fad\(/);

const keywordOverlays = validateOverlays({
  ...normalizedOverlays,
  timed_overlays: [{
    id: "overlay-keywords-test",
    type: "progressive_keywords",
    layout: "auto",
    enter_animation: "pop",
    style: { font_family: "华文中宋", font_size_ratio: 0.08, color: "#FFFFFF" },
    items: [
      { start_word_index: 0, end_word_index: 1, display_text: "普通人" },
      { start_word_index: 2, end_word_index: 3, display_text: "也能" },
      { start_word_index: 4, end_word_index: 5, display_text: "做网站" },
    ],
    source: "ai",
  }],
}, { words });
const keywordGroup = keywordOverlays.timed_overlays[0];
assert.equal(keywordGroup.type, "progressive_keywords");
assert.equal(keywordGroup.layout, "auto");
assert.equal(keywordGroup.enter_animation, "pop");
assert.equal(keywordGroup.style.font_size_ratio, 0.08);
assert.equal(keywordGroup.style.color, "#FFF08A");
assert.equal(keywordGroup.style.font_family, "华文中宋");
assert.deepEqual(keywordGroup.items.map((item) => item.box), [
  { x: 0.13, y: 0.139167, width: 0.24, height: 0.055, unit: "ratio" },
  { x: 0.38, y: 0.139167, width: 0.24, height: 0.055, unit: "ratio" },
  { x: 0.63, y: 0.139167, width: 0.24, height: 0.055, unit: "ratio" },
]);
const keywordTrack = compileStructuredOverlayTrack(captionProject, words, keywordOverlays);
assert.equal(keywordTrack.states.length, 3);
assert.equal(keywordTrack.groups[0].fontSize, 58);
assert.equal(new Set(keywordTrack.states.map((state) => state.fontSize)).size, 1);
assert.ok(keywordTrack.groups[0].items.every((item) => item.lines.length === 1));
assert.ok(keywordTrack.groups[0].items.every((item) => (
  item.box.height === Number((item.lines.length * keywordTrack.groups[0].lineHeight / 1280).toFixed(6))
)));
assert.ok(keywordTrack.groups[0].items[0].box.height > keywordGroup.items[0].box.height);
assert.equal(keywordTrack.states[1].entering_item_id, keywordGroup.items[1].id);
assert.equal(keywordTrack.states[2].items.length, 3);
const keywordAss = buildAss(captionProject, captionTrack, keywordTrack);
assert.match(keywordAss, /\\an5\\pos\(180,213\)/);
assert.match(keywordAss, /\\fs58\\c&H008AF0FF/);
assert.match(keywordAss, /\\bord2/);
assert.match(keywordAss, /\\fad\(180,0\)\\fscx85\\fscy85\\t\(0,180,\\fscx100\\fscy100\)/);
assert.equal((keywordAss.match(/\\fad\(/g) || []).length, 3);

const autoKeywordLayouts = new Map();
const expectedKeywordCenters = new Map([
  [1, [[1 / 2, 1 / 6]]],
  [2, [[1 / 3, 1 / 6], [2 / 3, 1 / 6]]],
  [3, [[1 / 4, 1 / 6], [2 / 4, 1 / 6], [3 / 4, 1 / 6]]],
  [4, [[1 / 3, 1 / 6], [2 / 3, 1 / 6], [1 / 3, 1 / 6 + 0.055 * 2], [2 / 3, 1 / 6 + 0.055 * 2]]],
]);
for (const itemCount of [1, 2, 3, 4]) {
  const autoLayout = validateOverlays({
    ...normalizedOverlays,
    timed_overlays: [{
      type: "progressive_keywords",
      items: Array.from({ length: itemCount }, (_, wordIndex) => ({
        start_word_index: wordIndex,
        end_word_index: wordIndex,
        display_text: `词${wordIndex + 1}`,
      })),
    }],
  }, { words }).timed_overlays[0];
  assert.equal(autoLayout.items.length, itemCount);
  assert.equal(autoLayout.items.every((item) => item.box?.unit === "ratio"), true);
  assert.equal(new Set(autoLayout.items.map((item) => `${item.box.x}:${item.box.y}`)).size, itemCount);
  autoKeywordLayouts.set(itemCount, autoLayout.items.map((item) => item.box));
  const centers = autoLayout.items.map((item) => [
    item.box.x + item.box.width / 2,
    item.box.y + item.box.height / 2,
  ]);
  for (let itemIndex = 0; itemIndex < centers.length; itemIndex += 1) {
    const [actualX, actualY] = centers[itemIndex];
    const [expectedX, expectedY] = expectedKeywordCenters.get(itemCount)[itemIndex];
    assert.ok(Math.abs(actualX - expectedX) < 0.000001);
    assert.ok(Math.abs(actualY - expectedY) < 0.000001);
  }
}
assert.deepEqual(autoKeywordLayouts.get(4).slice(0, 2), autoKeywordLayouts.get(2));
const fourKeywordFirstRowCenter = autoKeywordLayouts.get(4)[0].y + autoKeywordLayouts.get(4)[0].height / 2;
const fourKeywordSecondRowCenter = autoKeywordLayouts.get(4)[2].y + autoKeywordLayouts.get(4)[2].height / 2;
// 两行中心距等于两个词块高，即第一行与第二行之间空出一个字高的间距
assert.ok(Math.abs(fourKeywordSecondRowCenter - fourKeywordFirstRowCenter - 0.055 * 2) < 0.001);

assert.throws(
  () => validateOverlays({
    ...normalizedOverlays,
    timed_overlays: [{
      type: "progressive_keywords",
      items: [{ start_word_index: 0, end_word_index: 0, display_text: "词" }],
    }],
  }, { words }),
  /必须是 2 到 3 个字符/,
);

const animatedList = validateOverlays({
  ...normalizedOverlays,
  timed_overlays: [{
    type: "progressive_list",
    enter_animation: "pop",
    items: [
      { start_word_index: 0, end_word_index: 1 },
      { start_word_index: 4, end_word_index: 5 },
    ],
  }],
}, { words });
const animatedListTrack = compileStructuredOverlayTrack(captionProject, words, animatedList);
assert.equal(animatedListTrack.states[0].enter_animation, "pop");
assert.equal(animatedListTrack.states[0].animation_duration, 0.18);
assert.match(buildAss(captionProject, captionTrack, animatedListTrack), /\\fad\(180,0\)/);

const customKeywordOverlays = validateOverlays({
  ...normalizedOverlays,
  timed_overlays: [{
    id: "overlay-keywords-custom",
    type: "progressive_keywords",
    layout: "custom",
    enter_animation: "none",
    items: [{
      start_word_index: 0,
      end_word_index: 1,
      display_text: "自定义",
      box: { x: 0.1, y: 0.2, width: 0.3, height: 0.12 },
    }],
  }],
}, { words });
assert.deepEqual(customKeywordOverlays.timed_overlays[0].items[0].box, {
  x: 0.1,
  y: 0.2,
  width: 0.3,
  height: 0.12,
  unit: "ratio",
});
assert.throws(
  () => validateOverlays({
    ...normalizedOverlays,
    timed_overlays: [{
      type: "progressive_keywords",
      enter_animation: "bounce",
      items: [{ start_word_index: 0, end_word_index: 0, display_text: "这是" }],
    }],
  }, { words }),
  /只支持 none 或 pop/,
);
assert.throws(
  () => validateOverlays({
    ...normalizedOverlays,
    timed_overlays: [{
      type: "progressive_keywords",
      layout: "circle",
      items: [{ start_word_index: 0, end_word_index: 0, display_text: "这是" }],
    }],
  }, { words }),
  /只支持 auto 或 custom/,
);
assert.throws(
  () => validateOverlays({
    ...normalizedOverlays,
    timed_overlays: [{
      type: "progressive_keywords",
      items: [0, 1, 2, 3, 4].map((wordIndex) => ({
        start_word_index: wordIndex,
        end_word_index: wordIndex,
      })),
    }],
  }, { words }),
  /最多支持 4 个条目/,
);
assert.throws(
  () => validateOverlays({
    ...normalizedOverlays,
    timed_overlays: [{
      type: "progressive_list",
      items: [
        { start_word_index: 0, end_word_index: 2 },
        { start_word_index: 2, end_word_index: 3 },
      ],
    }],
  }, { words }),
  /不能重叠/,
);
const migratedV1 = validateOverlays({
  version: 1,
  captions: overlays.captions,
});
assert.equal(migratedV1.version, 2);
assert.deepEqual(migratedV1.timed_overlays, []);

assert.throws(() => validateTranscript([{ text: "错", start: 1, end: 0.5 }]), /start < end/);

process.stdout.write("wanggan-editing tests passed\n");
