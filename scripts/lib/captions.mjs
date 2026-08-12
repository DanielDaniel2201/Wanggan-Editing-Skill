import fs from "node:fs";
import path from "node:path";
import {
  EFFECT_TARGETS,
  WangganError,
  effectDefinition,
  readJson,
  roundTime,
  writeJson,
} from "./core.mjs";

export const CAPTION_FONT_FAMILIES = Object.freeze({
  DEFAULT: "Microsoft YaHei",
  SONG: "华文中宋",
});

const SUPPORTED_FONT_FAMILIES = new Set(Object.values(CAPTION_FONT_FAMILIES));
const FONT_FAMILY_ALIASES = new Map([
  ["Noto Sans SC", CAPTION_FONT_FAMILIES.DEFAULT],
  ["Microsoft YaHei UI", CAPTION_FONT_FAMILIES.DEFAULT],
  ["STZhongsong", CAPTION_FONT_FAMILIES.SONG],
]);

const DEFAULT_CAPTIONS = Object.freeze({
  enabled: false,
  coordinate_space: "screen",
  box: Object.freeze({
    x: 0.06,
    y: 0.70,
    width: 0.88,
    height: 0.20,
    unit: "ratio",
  }),
  style: Object.freeze({
    font_family: CAPTION_FONT_FAMILIES.DEFAULT,
    font_size_ratio: 0.06,
    color: "#FFFFFF",
    stroke_color: "#000000",
    stroke_width_ratio: 0.0055,
    align: "center",
  }),
  cue_fonts: Object.freeze({}),
  cue_font_size_ratios: Object.freeze({}),
});

const DEFAULT_PROGRESSIVE_LIST = Object.freeze({
  enabled: true,
  coordinate_space: "screen",
  box: Object.freeze({
    x: 0.08,
    y: 0.12,
    width: 0.84,
    height: 0.30,
    unit: "ratio",
  }),
  style: Object.freeze({
    font_family: CAPTION_FONT_FAMILIES.DEFAULT,
    font_size_ratio: 0.045,
    color: "#FFFFFF",
    stroke_color: "#000000",
    stroke_width_ratio: 0.004,
    item_gap_ratio: 0.014,
    align: "left",
  }),
});

const DEFAULT_PROGRESSIVE_KEYWORDS = Object.freeze({
  enabled: true,
  coordinate_space: "screen",
  box: Object.freeze({
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    unit: "ratio",
  }),
  style: Object.freeze({
    font_family: DEFAULT_CAPTIONS.style.font_family,
    font_size_ratio: DEFAULT_CAPTIONS.style.font_size_ratio * effectDefinition("large_bright").fontScale,
    color: effectDefinition("large_bright").color,
    stroke_color: DEFAULT_CAPTIONS.style.stroke_color,
    stroke_width_ratio: DEFAULT_CAPTIONS.style.stroke_width_ratio,
    item_gap_ratio: 0,
    align: "center",
  }),
});

const ENTER_ANIMATIONS = Object.freeze(["none", "pop"]);

function cloneDefaultCaptions() {
  return {
    ...DEFAULT_CAPTIONS,
    box: { ...DEFAULT_CAPTIONS.box },
    style: { ...DEFAULT_CAPTIONS.style },
    cue_fonts: { ...DEFAULT_CAPTIONS.cue_fonts },
    cue_font_size_ratios: { ...DEFAULT_CAPTIONS.cue_font_size_ratios },
  };
}

function cloneDefaultProgressiveList() {
  return {
    ...DEFAULT_PROGRESSIVE_LIST,
    box: { ...DEFAULT_PROGRESSIVE_LIST.box },
    style: { ...DEFAULT_PROGRESSIVE_LIST.style },
  };
}

function cloneDefaultProgressiveKeywords() {
  return {
    ...DEFAULT_PROGRESSIVE_KEYWORDS,
    box: { ...DEFAULT_PROGRESSIVE_KEYWORDS.box },
    style: { ...DEFAULT_PROGRESSIVE_KEYWORDS.style },
  };
}

export function defaultOverlays() {
  return {
    version: 2,
    captions: cloneDefaultCaptions(),
    timed_overlays: [],
  };
}

function finiteRatio(value, fallback, label, options = {}) {
  const numeric = value === undefined ? fallback : Number(value);
  const minimum = options.minimum ?? 0;
  const maximum = options.maximum ?? 1;
  if (!Number.isFinite(numeric) || numeric < minimum || numeric > maximum) {
    throw new WangganError(`${label} 必须在 ${minimum} 到 ${maximum} 之间`, { value });
  }
  return numeric;
}

function color(value, fallback, label) {
  const text = String(value ?? fallback).trim().toUpperCase();
  if (!/^#[0-9A-F]{6}$/.test(text)) {
    throw new WangganError(`${label} 必须是 #RRGGBB 颜色`, { value });
  }
  return text;
}

export function normalizedFontFamily(value, fallback = CAPTION_FONT_FAMILIES.DEFAULT) {
  const requested = String(value ?? fallback).trim() || fallback;
  const normalized = FONT_FAMILY_ALIASES.get(requested) || requested;
  if (!SUPPORTED_FONT_FAMILIES.has(normalized)) {
    throw new WangganError("字体只支持默认粗黑体或华文中宋", {
      value,
      allowed: [...SUPPORTED_FONT_FAMILIES],
    });
  }
  return normalized;
}

function normalizedCueFonts(value) {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new WangganError("字幕 cue_fonts 必须是对象", { value });
  }
  const result = {};
  for (const [cueId, fontFamily] of Object.entries(value)) {
    if (!/^caption-\d{3,}$/.test(cueId)) {
      throw new WangganError("字幕字体覆盖的 cue id 无效", { cueId });
    }
    result[cueId] = normalizedFontFamily(fontFamily);
  }
  return result;
}

function normalizedCueFontSizeRatios(value) {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new WangganError("字幕 cue_font_size_ratios 必须是对象", { value });
  }
  const result = {};
  for (const [cueId, fontSizeRatio] of Object.entries(value)) {
    if (!/^caption-\d{3,}$/.test(cueId)) {
      throw new WangganError("字幕字号覆盖的 cue id 无效", { cueId });
    }
    result[cueId] = finiteRatio(fontSizeRatio, DEFAULT_CAPTIONS.style.font_size_ratio, "单条字幕字号比例", {
      minimum: 0.015,
      maximum: 0.15,
    });
  }
  return result;
}

function normalizedDisplayText(value, fallback, label) {
  const text = String(value ?? fallback)
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) throw new WangganError(`${label}不能为空`);
  if (Array.from(text).length > 120) {
    throw new WangganError(`${label}不能超过 120 个字符`, { value: text });
  }
  return text;
}

function normalizedSource(value) {
  return value === "human" ? "human" : "ai";
}

function normalizedEnterAnimation(value, fallback) {
  const animation = String(value ?? fallback).trim();
  if (!ENTER_ANIMATIONS.includes(animation)) {
    throw new WangganError("入场动画只支持 none 或 pop", {
      enter_animation: value ?? null,
      allowed: ENTER_ANIMATIONS,
    });
  }
  return animation;
}

function normalizedOverlayBox(input, fallback, label, options = {}) {
  const boxInput = input || {};
  const box = {
    x: finiteRatio(boxInput.x, fallback.x, `${label} x`),
    y: finiteRatio(boxInput.y, fallback.y, `${label} y`),
    width: finiteRatio(boxInput.width, fallback.width, `${label} width`, {
      minimum: options.minimumWidth ?? 0.05,
    }),
    height: finiteRatio(boxInput.height, fallback.height, `${label} height`, {
      minimum: options.minimumHeight ?? 0.05,
    }),
    unit: "ratio",
  };
  if (box.x + box.width > 1.000001 || box.y + box.height > 1.000001) {
    throw new WangganError(`${label}不能超出视频画面`, { box });
  }
  return box;
}

function autoKeywordBoxes(itemCount) {
  const keywordBoxHeight = 0.055;
  const centeredBox = (centerX, centerY, width) => ({
    x: Number((centerX - width / 2).toFixed(6)),
    y: Number((centerY - keywordBoxHeight / 2).toFixed(6)),
    width,
    height: keywordBoxHeight,
  });
  const emphasisLineY = 1 / 6;
  const layouts = {
    1: [
      centeredBox(1 / 2, emphasisLineY, 0.36),
    ],
    2: [
      centeredBox(1 / 3, emphasisLineY, 0.28),
      centeredBox(2 / 3, emphasisLineY, 0.28),
    ],
    3: [
      centeredBox(1 / 4, emphasisLineY, 0.24),
      centeredBox(2 / 4, emphasisLineY, 0.24),
      centeredBox(3 / 4, emphasisLineY, 0.24),
    ],
    4: [
      centeredBox(1 / 3, emphasisLineY, 0.28),
      centeredBox(2 / 3, emphasisLineY, 0.28),
      centeredBox(1 / 3, emphasisLineY + keywordBoxHeight * 2, 0.28),
      centeredBox(2 / 3, emphasisLineY + keywordBoxHeight * 2, 0.28),
    ],
  };
  return layouts[itemCount].map((box) => ({ ...box, unit: "ratio" }));
}

function validateProgressiveList(input, overlayIndex, words) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new WangganError(`第 ${overlayIndex + 1} 个定时覆盖层必须是对象`);
  }
  if (!["progressive_list", "progressive_keywords"].includes(input.type)) {
    throw new WangganError("不支持的定时覆盖层类型", {
      type: input.type ?? null,
      allowed: ["progressive_list", "progressive_keywords"],
    });
  }
  const isKeywords = input.type === "progressive_keywords";
  if (!Array.isArray(words) || words.length === 0) {
    throw new WangganError("校验定时覆盖层时必须提供逐字稿");
  }
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new WangganError("清单至少需要一个条目", { overlayIndex });
  }
  const maximumItems = isKeywords ? 4 : 8;
  if (input.items.length > maximumItems) {
    throw new WangganError(
      isKeywords ? "关键词散布最多支持 4 个条目" : "单个清单最多支持 8 个条目",
      { overlayIndex, itemCount: input.items.length },
    );
  }

  const defaults = isKeywords ? cloneDefaultProgressiveKeywords() : cloneDefaultProgressiveList();
  const styleInput = input.style || {};
  const box = isKeywords
    ? { ...defaults.box }
    : normalizedOverlayBox(input.box, defaults.box, "清单区域");
  if (isKeywords && input.layout !== undefined && !["auto", "custom"].includes(input.layout)) {
    throw new WangganError("关键词布局只支持 auto 或 custom", {
      layout: input.layout,
      allowed: ["auto", "custom"],
    });
  }
  const layout = isKeywords && input.layout === "custom" ? "custom" : "auto";
  const autoBoxes = isKeywords ? autoKeywordBoxes(input.items.length) : [];

  const idPrefix = isKeywords ? "overlay-keywords" : "overlay-list";
  const overlayId = String(input.id || `${idPrefix}-${String(overlayIndex + 1).padStart(3, "0")}`).trim();
  if (!overlayId) throw new WangganError("定时覆盖层 id 不能为空", { overlayIndex });
  const items = input.items.map((item, itemIndex) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new WangganError(`清单 ${overlayId} 的第 ${itemIndex + 1} 个条目必须是对象`);
    }
    const startWordIndex = Number(item.start_word_index);
    const endWordIndex = Number(item.end_word_index);
    if (
      !Number.isInteger(startWordIndex)
      || !Number.isInteger(endWordIndex)
      || startWordIndex < 0
      || endWordIndex < startWordIndex
      || endWordIndex >= words.length
    ) {
      throw new WangganError("清单条目的逐字稿范围无效", {
        overlayId,
        itemIndex,
        start_word_index: item.start_word_index ?? null,
        end_word_index: item.end_word_index ?? null,
        wordCount: words.length,
      });
    }
    const selectedWords = words.slice(startWordIndex, endWordIndex + 1);
    const sourceText = selectedWords.map((word) => word.text).join("");
    const displayText = normalizedDisplayText(item.display_text, sourceText, "清单显示文字");
    if (isKeywords) {
      const characterCount = Array.from(displayText.replace(/\s/g, "")).length;
      if (characterCount < 2 || characterCount > 3) {
        throw new WangganError("关键词屏幕文案必须是 2 到 3 个字符", {
          overlayId,
          itemIndex,
          display_text: displayText,
          characterCount,
        });
      }
    }
    const normalizedItem = {
      id: String(item.id || `${overlayId}-item-${String(itemIndex + 1).padStart(3, "0")}`).trim(),
      start_word_index: startWordIndex,
      end_word_index: endWordIndex,
      start: selectedWords[0].start,
      end: selectedWords.at(-1).end,
      source_text: sourceText,
      display_text: displayText,
    };
    if (isKeywords) {
      normalizedItem.box = layout === "auto"
        ? autoBoxes[itemIndex]
        : normalizedOverlayBox(item.box, autoBoxes[itemIndex], `关键词 ${itemIndex + 1} 区域`, {
          minimumWidth: 0.10,
          minimumHeight: 0.01,
        });
    }
    return normalizedItem;
  });

  const itemIds = new Set();
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item.id || itemIds.has(item.id)) {
      throw new WangganError("清单条目 id 不能为空或重复", { overlayId, itemId: item.id });
    }
    itemIds.add(item.id);
    if (index > 0 && item.start_word_index <= items[index - 1].end_word_index) {
      throw new WangganError("清单条目必须按词序排列且不能重叠", {
        overlayId,
        previous: items[index - 1],
        current: item,
      });
    }
  }

  return {
    id: overlayId,
    type: input.type,
    enabled: input.enabled === undefined ? defaults.enabled : Boolean(input.enabled),
    coordinate_space: "screen",
    box,
    ...(isKeywords ? { layout } : {}),
    enter_animation: normalizedEnterAnimation(input.enter_animation, isKeywords ? "pop" : "none"),
    style: {
      font_family: normalizedFontFamily(styleInput.font_family, defaults.style.font_family),
      font_size_ratio: finiteRatio(
        styleInput.font_size_ratio,
        defaults.style.font_size_ratio,
        isKeywords ? "关键词字号比例" : "清单字号比例",
        { minimum: 0.015, maximum: 0.12 },
      ),
      color: isKeywords
        ? defaults.style.color
        : color(styleInput.color, defaults.style.color, "清单颜色"),
      stroke_color: color(styleInput.stroke_color, defaults.style.stroke_color, "清单描边颜色"),
      stroke_width_ratio: finiteRatio(
        styleInput.stroke_width_ratio,
        defaults.style.stroke_width_ratio,
        "清单描边比例",
        { minimum: 0, maximum: 0.03 },
      ),
      item_gap_ratio: finiteRatio(
        styleInput.item_gap_ratio,
        defaults.style.item_gap_ratio,
        "清单条目间距比例",
        { minimum: 0, maximum: 0.08 },
      ),
      align: isKeywords ? "center" : "left",
    },
    items,
    start: items[0].start,
    end: items.at(-1).end,
    source: normalizedSource(input.source),
    human_modified: Boolean(input.human_modified),
  };
}

export function validateOverlays(value, options = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WangganError("overlays.json 必须是对象");
  }
  if (![1, 2].includes(value.version)) {
    throw new WangganError("overlays.json 必须使用 v1 或 v2 格式", { receivedVersion: value.version ?? null });
  }
  const defaults = cloneDefaultCaptions();
  const input = value.captions || {};
  const box = input.box || {};
  const style = input.style || {};
  const normalizedBox = {
    x: finiteRatio(box.x, defaults.box.x, "字幕 x"),
    y: finiteRatio(box.y, defaults.box.y, "字幕 y"),
    width: finiteRatio(box.width, defaults.box.width, "字幕 width", { minimum: 0.05 }),
    height: finiteRatio(box.height, defaults.box.height, "字幕 height", { minimum: 0.05 }),
    unit: "ratio",
  };
  if (normalizedBox.x + normalizedBox.width > 1.000001 || normalizedBox.y + normalizedBox.height > 1.000001) {
    throw new WangganError("字幕区域不能超出视频画面", { box: normalizedBox });
  }
  const timedInputs = value.version === 2 ? value.timed_overlays ?? [] : [];
  if (!Array.isArray(timedInputs)) {
    throw new WangganError("timed_overlays 必须是数组");
  }
  const timedOverlays = timedInputs.map((input, index) => (
    validateProgressiveList(input, index, options.words)
  ));
  const overlayIds = new Set();
  const enabledByStart = [];
  for (const overlay of timedOverlays) {
    if (overlayIds.has(overlay.id)) throw new WangganError("定时覆盖层 id 重复", { id: overlay.id });
    overlayIds.add(overlay.id);
    if (overlay.enabled) enabledByStart.push(overlay);
  }
  enabledByStart.sort((left, right) => left.start - right.start);
  for (let index = 1; index < enabledByStart.length; index += 1) {
    if (enabledByStart[index].start < enabledByStart[index - 1].end) {
      throw new WangganError("启用的清单时间不能重叠", {
        previous: enabledByStart[index - 1],
        current: enabledByStart[index],
      });
    }
  }

  return {
    version: 2,
    captions: {
      enabled: Boolean(input.enabled),
      coordinate_space: "screen",
      box: normalizedBox,
      style: {
        font_family: normalizedFontFamily(style.font_family, defaults.style.font_family),
        font_size_ratio: finiteRatio(
          style.font_size_ratio,
          defaults.style.font_size_ratio,
          "字幕字号比例",
          { minimum: 0.015, maximum: 0.15 },
        ),
        color: color(style.color, defaults.style.color, "字幕颜色"),
        stroke_color: color(style.stroke_color, defaults.style.stroke_color, "字幕描边颜色"),
        stroke_width_ratio: finiteRatio(
          style.stroke_width_ratio,
          defaults.style.stroke_width_ratio,
          "字幕描边比例",
          { minimum: 0, maximum: 0.03 },
        ),
        align: "center",
      },
      cue_fonts: normalizedCueFonts(input.cue_fonts),
      cue_font_size_ratios: normalizedCueFontSizeRatios(input.cue_font_size_ratios),
    },
    timed_overlays: timedOverlays,
  };
}

export function loadOverlays(overlaysPath, words = null) {
  if (!fs.existsSync(overlaysPath)) return defaultOverlays();
  return validateOverlays(readJson(overlaysPath), { words });
}

export function saveOverlays(overlaysPath, overlays, words = null) {
  const normalized = validateOverlays(overlays, { words });
  writeJson(overlaysPath, normalized);
  return normalized;
}

function parseSrtTime(value) {
  const match = /^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{3})$/.exec(value.trim());
  if (!match) return NaN;
  return roundTime(
    Number(match[1]) * 3600
    + Number(match[2]) * 60
    + Number(match[3])
    + Number(match[4]) / 1000,
  );
}

function cleanCaptionText(text) {
  return String(text || "")
    .replace(/<[^>]*>/g, "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

export function parseSrt(text, options = {}) {
  const duration = Number(options.duration);
  const blocks = String(text || "").replace(/^\uFEFF/, "").trim().split(/\r?\n\s*\r?\n/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split(/\r?\n/).map((line) => line.trimEnd());
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) continue;
    const match = /^(\S+)\s+-->\s+(\S+)/.exec(lines[timingIndex].trim());
    if (!match) throw new WangganError("SRT 时间行无效", { line: lines[timingIndex] });
    const start = parseSrtTime(match[1]);
    const end = parseSrtTime(match[2]);
    const captionText = cleanCaptionText(lines.slice(timingIndex + 1).join("\n"));
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || !captionText) {
      throw new WangganError("SRT 字幕条目无效", { block });
    }
    cues.push({
      id: `caption-${String(cues.length + 1).padStart(3, "0")}`,
      start,
      end,
      text: captionText,
      source: "srt",
    });
  }
  if (!cues.length) throw new WangganError("SRT 没有可用字幕");
  for (let index = 0; index < cues.length; index += 1) {
    const cue = cues[index];
    if (index > 0 && cue.start < cues[index - 1].end) {
      throw new WangganError("SRT 字幕时间发生重叠", { previous: cues[index - 1], current: cue });
    }
    if (Number.isFinite(duration) && cue.end > duration + 0.2) {
      throw new WangganError("SRT 字幕结束时间超过视频时长", { cue, duration });
    }
  }
  return cues;
}

function textLength(text) {
  return Array.from(String(text || "").replace(/\s+/g, "")).length;
}

export function captionsFromWords(words, options = {}) {
  const minChars = Number(options.minChars ?? 6);
  const maxChars = Number(options.maxChars ?? 15);
  const pauseSeconds = Number(options.pauseSeconds ?? 0.45);
  const cues = [];
  let current = [];
  let currentLength = 0;

  const flush = () => {
    if (!current.length) return;
    cues.push({
      id: `caption-${String(cues.length + 1).padStart(3, "0")}`,
      start: current[0].start,
      end: current.at(-1).end,
      text: current.map((word) => word.text).join(""),
      start_word_index: current[0].wordIndex,
      end_word_index: current.at(-1).wordIndex,
      source: "transcript",
    });
    current = [];
    currentLength = 0;
  };

  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    const wordLength = textLength(word.text);
    if (current.length && currentLength + wordLength > maxChars) flush();
    current.push(word);
    currentLength += wordLength;
    const next = words[index + 1];
    const pause = next ? next.start - word.end : Infinity;
    const punctuation = /[。！？!?；;]$/.test(word.text);
    if (!next || punctuation || currentLength >= maxChars || (currentLength >= minChars && pause >= pauseSeconds)) {
      flush();
    }
  }
  return cues;
}

function tokenizeForWrap(text) {
  return String(text || "").match(/[A-Za-z0-9][A-Za-z0-9+._-]*|\s+|./gu) || [];
}

export function splitCaptionLines(text, maxChars) {
  const output = [];
  for (const sourceLine of String(text || "").split("\n")) {
    let line = "";
    let length = 0;
    for (const token of tokenizeForWrap(sourceLine)) {
      const tokenText = /^\s+$/.test(token) ? " " : token;
      const tokenLength = textLength(tokenText);
      if (line && length + tokenLength > maxChars) {
        output.push(line.trim());
        line = tokenText.trimStart();
        length = textLength(line);
      } else {
        line += tokenText;
        length += tokenLength;
      }
    }
    if (line.trim()) output.push(line.trim());
  }
  return output.length ? output : [""];
}

function mergedTimeRanges(ranges) {
  const sorted = ranges
    .map((range) => ({ ...range, start: roundTime(range.start), end: roundTime(range.end) }))
    .filter((range) => Number.isFinite(range.start) && Number.isFinite(range.end) && range.end > range.start)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const merged = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end + 0.0005) {
      previous.end = Math.max(previous.end, range.end);
      previous.overlay_ids = [...new Set([...(previous.overlay_ids || []), ...(range.overlay_ids || [])])];
      previous.item_ids = [...new Set([...(previous.item_ids || []), ...(range.item_ids || [])])];
    } else {
      merged.push({
        ...range,
        overlay_ids: [...(range.overlay_ids || [])],
        item_ids: [...(range.item_ids || [])],
      });
    }
  }
  return merged;
}

export function compileStructuredOverlayTrack(project, words, overlaysInput) {
  const overlays = validateOverlays(overlaysInput, { words });
  const minDimension = Math.min(project.displayWidth, project.displayHeight);
  const groups = overlays.timed_overlays.map((overlay) => {
    const fontSize = Math.max(12, Math.round(minDimension * overlay.style.font_size_ratio));
    const strokeWidth = Math.max(1, Math.round(minDimension * overlay.style.stroke_width_ratio));
    const itemGap = Math.round(project.displayHeight * overlay.style.item_gap_ratio);
    const lineHeight = Math.max(fontSize, Math.round(fontSize * 1.25));
    if (overlay.type === "progressive_keywords") {
      const items = overlay.items.map((item, itemIndex) => {
        const boxWidth = project.displayWidth * item.box.width;
        const maxChars = Math.max(2, Math.floor(boxWidth / fontSize));
        const lines = [item.display_text];
        const requiredHeight = lines.length * lineHeight;
        const fittedHeight = Math.min(1, requiredHeight / project.displayHeight);
        const centerY = item.box.y + item.box.height / 2;
        const fittedY = Math.max(0, Math.min(1 - fittedHeight, centerY - fittedHeight / 2));
        return {
          ...item,
          box: {
            ...item.box,
            y: Number(fittedY.toFixed(6)),
            height: Number(fittedHeight.toFixed(6)),
          },
          lines,
          maxChars,
          requiredHeight,
        };
      });
      return {
        ...overlay,
        items,
        fontSize,
        strokeWidth,
        itemGap: 0,
        lineHeight,
      };
    }
    const boxWidth = project.displayWidth * overlay.box.width;
    const maxChars = Math.max(6, Math.floor(boxWidth / fontSize));
    const items = overlay.items.map((item) => ({
      ...item,
      lines: splitCaptionLines(item.display_text, maxChars),
    }));
    const lineCount = items.reduce((total, item) => total + item.lines.length, 0);
    const requiredHeight = lineCount * lineHeight + Math.max(0, items.length - 1) * itemGap;
    const fittedHeight = Math.min(1, requiredHeight / project.displayHeight);
    const fittedBox = {
      ...overlay.box,
      y: Number(Math.max(0, Math.min(1 - fittedHeight, overlay.box.y)).toFixed(6)),
      height: Number(fittedHeight.toFixed(6)),
    };
    return {
      ...overlay,
      box: fittedBox,
      items,
      fontSize,
      strokeWidth,
      itemGap,
      lineHeight,
      maxChars,
      requiredHeight,
    };
  });

  const states = [];
  const suppressionRanges = [];
  for (const group of groups) {
    if (!group.enabled) continue;
    for (let index = 0; index < group.items.length; index += 1) {
      const item = group.items[index];
      const stateEnd = index + 1 < group.items.length ? group.items[index + 1].start : group.end;
      states.push({
        id: `${group.id}-state-${String(index + 1).padStart(3, "0")}`,
        overlay_id: group.id,
        type: group.type,
        layout: group.layout || null,
        enter_animation: group.enter_animation,
        entering_item_id: item.id,
        animation_duration: Math.max(0.001, Math.min(0.18, stateEnd - item.start)),
        start: item.start,
        end: stateEnd,
        box: group.box,
        style: group.style,
        fontSize: group.fontSize,
        strokeWidth: group.strokeWidth,
        itemGap: group.itemGap,
        lineHeight: group.lineHeight,
        items: group.items.slice(0, index + 1),
      });
      suppressionRanges.push({
        start: item.start,
        end: item.end,
        overlay_ids: [group.id],
        item_ids: [item.id],
      });
    }
  }

  return {
    enabled: groups.some((group) => group.enabled),
    groupCount: groups.length,
    groups,
    states,
    suppressionRanges: mergedTimeRanges(suppressionRanges),
  };
}

function alignableCharacter(value) {
  return /[\p{L}\p{N}]/u.test(value);
}

function alignedCueWordIndexes(cue, words) {
  const cueCharacters = Array.from(String(cue.text || ""));
  const cueSequence = cueCharacters
    .map((character, characterIndex) => ({ character: character.toLocaleLowerCase(), characterIndex }))
    .filter((item) => alignableCharacter(item.character));
  const sourceSequence = words
    .filter((word) => word.end > cue.start - 0.02 && word.start < cue.end + 0.02)
    .flatMap((word) => Array.from(word.text)
      .map((character) => ({ character: character.toLocaleLowerCase(), wordIndex: word.wordIndex }))
      .filter((item) => alignableCharacter(item.character)));
  const rows = cueSequence.length + 1;
  const columns = sourceSequence.length + 1;
  const matrix = Array.from({ length: rows }, () => new Uint16Array(columns));
  for (let row = 1; row < rows; row += 1) {
    for (let column = 1; column < columns; column += 1) {
      matrix[row][column] = cueSequence[row - 1].character === sourceSequence[column - 1].character
        ? matrix[row - 1][column - 1] + 1
        : Math.max(matrix[row - 1][column], matrix[row][column - 1]);
    }
  }
  const wordIndexes = Array(cueCharacters.length).fill(null);
  let row = cueSequence.length;
  let column = sourceSequence.length;
  while (row > 0 && column > 0) {
    if (cueSequence[row - 1].character === sourceSequence[column - 1].character) {
      wordIndexes[cueSequence[row - 1].characterIndex] = sourceSequence[column - 1].wordIndex;
      row -= 1;
      column -= 1;
    } else if (matrix[row - 1][column] >= matrix[row][column - 1]) {
      row -= 1;
    } else {
      column -= 1;
    }
  }
  return { cueCharacters, wordIndexes };
}

function resolvedCueWordIndexes(cue, words) {
  const aligned = alignedCueWordIndexes(cue, words);
  const resolved = [...aligned.wordIndexes];
  for (let index = 0; index < resolved.length; index += 1) {
    if (Number.isInteger(resolved[index])) continue;
    const left = resolved.slice(0, index).reverse().find(Number.isInteger);
    const right = resolved.slice(index + 1).find(Number.isInteger);
    resolved[index] = left ?? right ?? null;
  }
  return { cueCharacters: aligned.cueCharacters, wordIndexes: resolved };
}

function subtractTimeRanges(start, end, ranges) {
  let visible = [{ start, end }];
  for (const range of ranges) {
    const next = [];
    for (const interval of visible) {
      if (range.end <= interval.start || range.start >= interval.end) {
        next.push(interval);
        continue;
      }
      if (range.start > interval.start) next.push({ start: interval.start, end: Math.min(range.start, interval.end) });
      if (range.end < interval.end) next.push({ start: Math.max(range.end, interval.start), end: interval.end });
    }
    visible = next;
  }
  return visible.filter((interval) => interval.end - interval.start > 0.0005);
}

function captionFragmentText(cue, words, start, end) {
  const { cueCharacters, wordIndexes } = resolvedCueWordIndexes(cue, words);
  const activeWordIndexes = new Set(words
    .filter((word) => word.end > start + 0.0005 && word.start < end - 0.0005)
    .map((word) => word.wordIndex));
  return cleanCaptionText(cueCharacters
    .filter((_character, index) => activeWordIndexes.has(wordIndexes[index]))
    .join(""));
}

function suppressCaptionCues(cues, words, suppressionRanges) {
  if (!suppressionRanges.length) return cues;
  const output = [];
  for (const cue of cues) {
    const overlaps = suppressionRanges.filter((range) => range.end > cue.start && range.start < cue.end);
    if (!overlaps.length) {
      output.push(cue);
      continue;
    }
    const visibleIntervals = subtractTimeRanges(cue.start, cue.end, overlaps);
    for (const interval of visibleIntervals) {
      const text = captionFragmentText(cue, words, interval.start, interval.end);
      if (!text) continue;
      output.push({
        ...cue,
        id: `${cue.id}-part-${String(output.length + 1).padStart(3, "0")}`,
        source_cue_id: cue.source_cue_id || cue.id,
        start: roundTime(interval.start),
        end: roundTime(interval.end),
        text,
      });
    }
  }
  return output;
}

function captionEffectForWord(wordIndex, captionEffects) {
  if (!Number.isInteger(wordIndex)) return null;
  return captionEffects.find((effect) => (
    wordIndex >= effect.start_word_index && wordIndex <= effect.end_word_index
  )) || null;
}

function resolvedCaptionStyle(effect) {
  if (!effect) return null;
  const definition = effectDefinition(effect.effect_type);
  if (!definition || definition.target !== EFFECT_TARGETS.CAPTIONS_OVERLAY) return null;
  return {
    effect_type: effect.effect_type,
    font_scale: definition.fontScale,
    color: definition.color,
  };
}

function styleKey(style) {
  return style?.effect_type || "plain";
}

function mergeStyledItems(items) {
  const segments = [];
  for (const item of items) {
    const previous = segments.at(-1);
    if (previous && styleKey(previous.style) === styleKey(item.style)) {
      previous.text += item.character;
    } else {
      segments.push({ text: item.character, style: item.style });
    }
  }
  return segments;
}

function tokenizedStyledItems(items) {
  const tokens = [];
  for (let index = 0; index < items.length;) {
    const item = items[index];
    if (item.character === "\n") {
      tokens.push([item]);
      index += 1;
      continue;
    }
    const asciiWord = /[A-Za-z0-9+._-]/.test(item.character);
    const whitespace = /^\s$/u.test(item.character);
    let end = index + 1;
    if (asciiWord || whitespace) {
      while (end < items.length) {
        const character = items[end].character;
        if (character === "\n") break;
        if (asciiWord !== /[A-Za-z0-9+._-]/.test(character)) break;
        if (whitespace !== /^\s$/u.test(character)) break;
        end += 1;
      }
    }
    tokens.push(items.slice(index, end));
    index = end;
  }
  return tokens;
}

function captionGlyphWidth(character) {
  if (/^\s$/u.test(character)) return 0.33;
  if (/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]$/u.test(character)) return 1;
  if (/^[MW@#%&]$/.test(character)) return 0.9;
  if (/^[A-Z]$/.test(character)) return 0.68;
  if (/^[mw]$/.test(character)) return 0.82;
  if (/^[ilI1|]$/.test(character)) return 0.3;
  if (/^[a-z]$/.test(character)) return 0.54;
  if (/^[0-9]$/.test(character)) return 0.58;
  if (/^[,.;:!?，。！？；：'"`·]$/u.test(character)) return 0.42;
  if (/^[()\[\]{}<>《》【】（）]$/u.test(character)) return 0.55;
  return 0.9;
}

function styledItemWidth(item) {
  return captionGlyphWidth(item.character) * (item.style?.font_scale || 1);
}

function layoutTokenWidth(token) {
  return token.reduce((total, item) => total + styledItemWidth(item), 0);
}

function tokenText(token) {
  return token.map((item) => item.character).join("");
}

function whitespaceToken(token) {
  return token.every((item) => /^\s$/u.test(item.character));
}

function trimLayoutTokens(tokens) {
  let start = 0;
  let end = tokens.length;
  while (start < end && whitespaceToken(tokens[start])) start += 1;
  while (end > start && whitespaceToken(tokens[end - 1])) end -= 1;
  return tokens.slice(start, end);
}

function normalizedLayoutTokens(items) {
  const rawTokens = tokenizedStyledItems(items);
  const output = [];
  for (let index = 0; index < rawTokens.length; index += 1) {
    const token = rawTokens[index];
    if (token.length === 1 && token[0].character === "\n") {
      const previous = output.at(-1);
      const next = rawTokens.slice(index + 1).find((candidate) => (
        !(candidate.length === 1 && candidate[0].character === "\n")
        && !whitespaceToken(candidate)
      ));
      if (previous && next && /[A-Za-z0-9]$/.test(tokenText(previous)) && /^[A-Za-z0-9]/.test(tokenText(next))) {
        output.push([{ character: " ", style: token[0].style || null }]);
      }
      continue;
    }
    if (whitespaceToken(token)) {
      if (!output.length || whitespaceToken(output.at(-1))) continue;
      output.push([{ character: " ", style: token[0].style || null }]);
      continue;
    }
    output.push(token);
  }
  return trimLayoutTokens(output);
}

function tokensWidth(tokens) {
  return trimLayoutTokens(tokens).reduce((total, token) => total + layoutTokenWidth(token), 0);
}

function visibleTokenCount(tokens) {
  return trimLayoutTokens(tokens).filter((token) => !whitespaceToken(token)).length;
}

function orphanPenalty(tokens) {
  const visible = trimLayoutTokens(tokens).filter((token) => !whitespaceToken(token));
  if (visible.length !== 1) return 0;
  const text = tokenText(visible[0]);
  return /^[A-Za-z0-9+._-]{1,10}$/.test(text) ? 4 : 1.5;
}

function boundaryPenalty(tokens, index, left, right) {
  const leftText = tokenText(trimLayoutTokens(left).at(-1) || []);
  const rightText = tokenText(trimLayoutTokens(right)[0] || []);
  let penalty = 0;
  if (/^[,.;:!?，。！？；：、）》】）]/u.test(rightText)) penalty += 4;
  if (/[（《【(\[]$/u.test(leftText)) penalty += 4;
  if (/[，。！？；：、,.;:!?]$/u.test(leftText)) penalty -= 0.6;
  if (whitespaceToken(tokens[index - 1]) || whitespaceToken(tokens[index])) penalty -= 0.35;
  return penalty;
}

function mergedLineFromTokens(tokens) {
  return mergeStyledItems(trimLayoutTokens(tokens).flat());
}

function bestTwoLineLayout(tokens, maxWidth) {
  const candidates = [];
  for (let index = 1; index < tokens.length; index += 1) {
    const left = trimLayoutTokens(tokens.slice(0, index));
    const right = trimLayoutTokens(tokens.slice(index));
    if (!visibleTokenCount(left) || !visibleTokenCount(right)) continue;
    const leftWidth = tokensWidth(left);
    const rightWidth = tokensWidth(right);
    const overflow = Math.max(0, leftWidth - maxWidth) + Math.max(0, rightWidth - maxWidth);
    const score = overflow * 1000
      + (orphanPenalty(left) + orphanPenalty(right)) * 100
      + boundaryPenalty(tokens, index, left, right) * 50
      + Math.max(leftWidth, rightWidth) * 2
      + Math.abs(leftWidth - rightWidth);
    candidates.push({ left, right, leftWidth, rightWidth, overflow, score });
  }
  candidates.sort((left, right) => left.score - right.score);
  return candidates[0] || null;
}

function layoutStyledItems(items, maxWidth) {
  const tokens = normalizedLayoutTokens(items);
  if (!tokens.length) return { lines: [[{ text: "", style: null }]], fontScale: 1 };
  const totalWidth = tokensWidth(tokens);
  if (totalWidth <= maxWidth) {
    return { lines: [mergedLineFromTokens(tokens)], fontScale: 1 };
  }
  const twoLine = bestTwoLineLayout(tokens, maxWidth);
  if (!twoLine) {
    return { lines: [mergedLineFromTokens(tokens)], fontScale: Math.min(1, maxWidth / totalWidth) };
  }
  const widestLine = Math.max(twoLine.leftWidth, twoLine.rightWidth);
  return {
    lines: [mergedLineFromTokens(twoLine.left), mergedLineFromTokens(twoLine.right)],
    fontScale: Math.min(1, maxWidth / widestLine),
  };
}

export function layoutCaptionText(text, maxWidth) {
  const items = Array.from(String(text || ""), (character) => ({ character, style: null }));
  const layout = layoutStyledItems(items, Number(maxWidth));
  return {
    lines: layout.lines.map((line) => line.map((segment) => segment.text).join("")),
    fontScale: layout.fontScale,
  };
}

function styledCaptionLayout(cue, words, captionEffects, maxWidth) {
  const { cueCharacters, wordIndexes } = alignedCueWordIndexes(cue, words);
  const styles = wordIndexes.map((wordIndex) => resolvedCaptionStyle(
    captionEffectForWord(wordIndex, captionEffects),
  ));
  for (let index = 0; index < cueCharacters.length; index += 1) {
    if (styles[index] || alignableCharacter(cueCharacters[index])) continue;
    const left = styles.slice(0, index).reverse().find(Boolean) || null;
    const right = styles.slice(index + 1).find(Boolean) || null;
    if (left && right && styleKey(left) === styleKey(right)) styles[index] = left;
  }
  const items = cueCharacters.map((character, index) => ({ character, style: styles[index] || null }));
  return layoutStyledItems(items, maxWidth);
}

export function loadCaptionCues(project, words) {
  if (project.subtitlePath) {
    if (!fs.existsSync(project.subtitlePath)) {
      throw new WangganError(`找不到字幕文件：${project.subtitlePath}`);
    }
    return {
      source: "srt",
      sourcePath: project.subtitlePath,
      cues: parseSrt(fs.readFileSync(project.subtitlePath, "utf8"), { duration: project.duration }),
    };
  }
  return {
    source: "transcript",
    sourcePath: project.transcriptPath,
    cues: captionsFromWords(words),
  };
}

export function compileCaptionTrack(project, words, overlaysInput, effects = [], options = {}) {
  const overlays = validateOverlays(overlaysInput, { words });
  const source = loadCaptionCues(project, words);
  const visibleCues = suppressCaptionCues(source.cues, words, options.suppressionRanges || []);
  const captionEffects = effects.filter((effect) => effect.target === EFFECT_TARGETS.CAPTIONS_OVERLAY);
  const minDimension = Math.min(project.displayWidth, project.displayHeight);
  const fontSize = Math.max(12, Math.round(minDimension * overlays.captions.style.font_size_ratio));
  const boxWidth = project.displayWidth * overlays.captions.box.width;
  const maxWidth = Math.max(6, boxWidth / fontSize);
  return {
    enabled: overlays.captions.enabled,
    source: source.source,
    sourcePath: source.sourcePath,
    cueCount: source.cues.length,
    playbackCueCount: visibleCues.length,
    box: overlays.captions.box,
    style: overlays.captions.style,
    fontSize,
    maxWidth,
    effectCount: captionEffects.length,
    cues: visibleCues.map((cue) => {
      const sourceCueId = cue.source_cue_id || cue.id;
      const cueFontSizeRatio = overlays.captions.cue_font_size_ratios[sourceCueId]
        || overlays.captions.style.font_size_ratio;
      const cueBaseFontSize = Math.max(12, Math.round(minDimension * cueFontSizeRatio));
      const cueMaxWidth = Math.max(6, boxWidth / cueBaseFontSize);
      const layout = styledCaptionLayout(cue, words, captionEffects, cueMaxWidth);
      const styledLines = layout.lines;
      return {
        ...cue,
        source_cue_id: sourceCueId,
        font_family: overlays.captions.cue_fonts[sourceCueId] || overlays.captions.style.font_family,
        font_size_ratio: cueFontSizeRatio,
        font_size: cueBaseFontSize,
        layout_font_scale: layout.fontScale,
        lines: styledLines.map((line) => line.map((segment) => segment.text).join("")),
        styledLines,
      };
    }),
  };
}

export function compileScreenOverlays(project, words, overlaysInput, effects = []) {
  const overlays = validateOverlays(overlaysInput, { words });
  const structuredTrack = compileStructuredOverlayTrack(project, words, overlays);
  const captionTrack = compileCaptionTrack(project, words, overlays, effects, {
    suppressionRanges: structuredTrack.suppressionRanges,
  });
  return {
    overlays,
    captionTrack,
    structuredTrack,
    playbackCaptions: captionTrack.cues,
    playbackOverlays: structuredTrack.states,
  };
}

function assTime(seconds) {
  const centiseconds = Math.max(0, Math.round(Number(seconds) * 100));
  const hours = Math.floor(centiseconds / 360000);
  const minutes = Math.floor((centiseconds % 360000) / 6000);
  const remainder = Math.floor((centiseconds % 6000) / 100);
  const cs = centiseconds % 100;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

function assColor(hex) {
  const match = /^#([0-9A-F]{2})([0-9A-F]{2})([0-9A-F]{2})$/i.exec(hex);
  if (!match) return "&H00FFFFFF";
  return `&H00${match[3]}${match[2]}${match[1]}`.toUpperCase();
}

function escapeAssText(text) {
  return String(text || "")
    .replace(/\\/g, "\\\\")
    .replace(/{/g, "\\{")
    .replace(/}/g, "\\}");
}

export function buildAss(project, captionTrack, structuredTrack = { states: [] }) {
  const style = captionTrack.style;
  const box = captionTrack.box;
  const centerX = Math.round(project.displayWidth * (box.x + box.width / 2));
  const bottomY = Math.round(project.displayHeight * (box.y + box.height));
  const outline = Math.max(1, Math.round(Math.min(project.displayWidth, project.displayHeight) * style.stroke_width_ratio));
  const fontName = String(style.font_family).replace(/,/g, " ");
  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${project.displayWidth}`,
    `PlayResY: ${project.displayHeight}`,
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "YCbCr Matrix: TV.709",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Default,${fontName},${captionTrack.fontSize},${assColor(style.color)},${assColor(style.color)},${assColor(style.stroke_color)},&H00000000,-1,0,0,0,100,100,0,0,1,${outline},0,2,0,0,0,1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  const captionEvents = captionTrack.enabled ? captionTrack.cues.map((cue) => {
    const layoutFontScale = Number(cue.layout_font_scale) || 1;
    const cueFontSize = Math.max(1, Math.round((cue.font_size || captionTrack.fontSize) * layoutFontScale));
    const text = (cue.styledLines || cue.lines.map((line) => [{ text: line, style: null }]))
      .map((line) => line.map((segment) => {
        const escaped = escapeAssText(segment.text);
        if (!segment.style) return escaped;
        const emphasizedFontSize = Math.max(1, Math.round(cueFontSize * segment.style.font_scale));
        return `{\\fs${emphasizedFontSize}\\c${assColor(segment.style.color)}}${escaped}{\\fs${cueFontSize}\\c${assColor(style.color)}}`;
      }).join(""))
      .join("\\N");
    const cueFontName = String(cue.font_family || style.font_family).replace(/[,{}\\]/g, " ");
    return `Dialogue: 0,${assTime(cue.start)},${assTime(cue.end)},Default,,0,0,0,,{\\an2\\pos(${centerX},${bottomY})\\fn${cueFontName}\\fs${cueFontSize}}${text}`;
  }) : [];
  const structuredEvents = (structuredTrack.states || []).flatMap((state) => {
    const events = [];
    const styleFontName = String(state.style.font_family).replace(/[,{}\\]/g, " ");
    const animationDuration = Math.max(1, Math.round(Number(state.animation_duration || 0.18) * 1000));
    const animationTags = (item) => (
      state.enter_animation === "pop" && item.id === state.entering_item_id
        ? `\\fad(${animationDuration},0)\\fscx85\\fscy85\\t(0,${animationDuration},\\fscx100\\fscy100)`
        : ""
    );
    if (state.type === "progressive_keywords") {
      for (const item of state.items) {
        const centerX = Math.round(project.displayWidth * (item.box.x + item.box.width / 2));
        const centerY = Math.round(project.displayHeight * (item.box.y + item.box.height / 2));
        const tags = [
          "\\an5",
          `\\pos(${centerX},${centerY})`,
          `\\fn${styleFontName}`,
          `\\fs${state.fontSize}`,
          `\\c${assColor(state.style.color)}`,
          `\\3c${assColor(state.style.stroke_color)}`,
          `\\bord${state.strokeWidth}`,
          animationTags(item),
        ].join("");
        events.push(
          `Dialogue: 10,${assTime(state.start)},${assTime(state.end)},Default,,0,0,0,,{${tags}}${item.lines.map(escapeAssText).join("\\N")}`,
        );
      }
      return events;
    }
    const leftX = Math.round(project.displayWidth * state.box.x);
    let topY = Math.round(project.displayHeight * state.box.y);
    for (const item of state.items) {
      for (const line of item.lines) {
        const tags = [
          "\\an7",
          `\\pos(${leftX},${topY})`,
          `\\fn${styleFontName}`,
          `\\fs${state.fontSize}`,
          `\\c${assColor(state.style.color)}`,
          `\\3c${assColor(state.style.stroke_color)}`,
          `\\bord${state.strokeWidth}`,
          animationTags(item),
        ].join("");
        events.push(
          `Dialogue: 10,${assTime(state.start)},${assTime(state.end)},Default,,0,0,0,,{${tags}}${escapeAssText(line)}`,
        );
        topY += state.lineHeight;
      }
      topY += state.itemGap;
    }
    return events;
  });
  return `${[...header, ...captionEvents, ...structuredEvents].join("\n")}\n`;
}

export function writeOverlayAss(
  project,
  captionTrack,
  structuredTrack,
  fileName = "render-overlays.ass",
) {
  const filePath = path.join(project.projectDir, fileName);
  fs.writeFileSync(filePath, buildAss(project, captionTrack, structuredTrack), "utf8");
  return filePath;
}
