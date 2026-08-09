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
    font_family: "Noto Sans SC",
    font_size_ratio: 0.06,
    color: "#FFFFFF",
    stroke_color: "#000000",
    stroke_width_ratio: 0.0055,
    align: "center",
  }),
});

function cloneDefaultCaptions() {
  return {
    ...DEFAULT_CAPTIONS,
    box: { ...DEFAULT_CAPTIONS.box },
    style: { ...DEFAULT_CAPTIONS.style },
  };
}

export function defaultOverlays() {
  return {
    version: 1,
    captions: cloneDefaultCaptions(),
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

export function validateOverlays(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WangganError("overlays.json 必须是对象");
  }
  if (value.version !== 1) {
    throw new WangganError("overlays.json 必须使用 v1 格式", { receivedVersion: value.version ?? null });
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
  return {
    version: 1,
    captions: {
      enabled: Boolean(input.enabled),
      coordinate_space: "screen",
      box: normalizedBox,
      style: {
        font_family: String(style.font_family || defaults.style.font_family)
          .replace(/[\r\n,]/g, " ")
          .trim() || defaults.style.font_family,
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
    },
  };
}

export function loadOverlays(overlaysPath) {
  if (!fs.existsSync(overlaysPath)) return defaultOverlays();
  return validateOverlays(readJson(overlaysPath));
}

export function saveOverlays(overlaysPath, overlays) {
  const normalized = validateOverlays(overlays);
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

function trimLineItems(items) {
  let start = 0;
  let end = items.length;
  while (start < end && /^\s$/u.test(items[start].character)) start += 1;
  while (end > start && /^\s$/u.test(items[end - 1].character)) end -= 1;
  return items.slice(start, end);
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

function styledCaptionLines(cue, words, captionEffects, maxChars) {
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
  const lines = [];
  let current = [];
  let currentWidth = 0;
  const flush = () => {
    const trimmed = trimLineItems(current);
    if (trimmed.length) lines.push(mergeStyledItems(trimmed));
    current = [];
    currentWidth = 0;
  };
  for (const token of tokenizedStyledItems(items)) {
    if (token.length === 1 && token[0].character === "\n") {
      flush();
      continue;
    }
    const tokenWidth = token.reduce((total, item) => (
      total + (item.style?.font_scale || 1) * (/^\s$/u.test(item.character) ? 0.5 : 1)
    ), 0);
    if (current.length && currentWidth + tokenWidth > maxChars) flush();
    current.push(...token);
    currentWidth += tokenWidth;
  }
  flush();
  return lines.length ? lines : [[{ text: "", style: null }]];
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

export function compileCaptionTrack(project, words, overlaysInput, effects = []) {
  const overlays = validateOverlays(overlaysInput);
  const source = loadCaptionCues(project, words);
  const captionEffects = effects.filter((effect) => effect.target === EFFECT_TARGETS.CAPTIONS_OVERLAY);
  const minDimension = Math.min(project.displayWidth, project.displayHeight);
  const fontSize = Math.max(12, Math.round(minDimension * overlays.captions.style.font_size_ratio));
  const boxWidth = project.displayWidth * overlays.captions.box.width;
  const maxChars = Math.max(6, Math.floor(boxWidth / fontSize));
  return {
    enabled: overlays.captions.enabled,
    source: source.source,
    sourcePath: source.sourcePath,
    cueCount: source.cues.length,
    box: overlays.captions.box,
    style: overlays.captions.style,
    fontSize,
    maxChars,
    effectCount: captionEffects.length,
    cues: source.cues.map((cue) => {
      const styledLines = captionEffects.length
        ? styledCaptionLines(cue, words, captionEffects, maxChars)
        : splitCaptionLines(cue.text, maxChars).map((line) => [{ text: line, style: null }]);
      return {
        ...cue,
        lines: styledLines.map((line) => line.map((segment) => segment.text).join("")),
        styledLines,
      };
    }),
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

export function buildAss(project, captionTrack) {
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
  const events = captionTrack.cues.map((cue) => {
    const text = (cue.styledLines || cue.lines.map((line) => [{ text: line, style: null }]))
      .map((line) => line.map((segment) => {
        const escaped = escapeAssText(segment.text);
        if (!segment.style) return escaped;
        const emphasizedFontSize = Math.max(1, Math.round(captionTrack.fontSize * segment.style.font_scale));
        return `{\\fs${emphasizedFontSize}\\c${assColor(segment.style.color)}}${escaped}{\\fs${captionTrack.fontSize}\\c${assColor(style.color)}}`;
      }).join(""))
      .join("\\N");
    return `Dialogue: 0,${assTime(cue.start)},${assTime(cue.end)},Default,,0,0,0,,{\\an2\\pos(${centerX},${bottomY})}${text}`;
  });
  return `${[...header, ...events].join("\n")}\n`;
}

export function writeCaptionAss(project, captionTrack, fileName = "render-captions.ass") {
  const filePath = path.join(project.projectDir, fileName);
  fs.writeFileSync(filePath, buildAss(project, captionTrack), "utf8");
  return filePath;
}
