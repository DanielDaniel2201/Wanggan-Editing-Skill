import { roundTime } from "./core.mjs";

export function assTime(seconds) {
  const centiseconds = Math.max(0, Math.round(Number(seconds) * 100));
  const hours = Math.floor(centiseconds / 360000);
  const minutes = Math.floor((centiseconds % 360000) / 6000);
  const remainder = Math.floor((centiseconds % 6000) / 100);
  const cs = centiseconds % 100;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

export function assColor(hex) {
  const match = /^#([0-9A-F]{2})([0-9A-F]{2})([0-9A-F]{2})$/i.exec(hex);
  if (!match) return "&H00FFFFFF";
  return `&H00${match[3]}${match[2]}${match[1]}`.toUpperCase();
}

export function escapeAssText(text) {
  return String(text || "")
    .replace(/\\/g, "\\\\")
    .replace(/{/g, "\\{")
    .replace(/}/g, "\\}");
}

export function assStrokeWidth(project, strokeWidthRatio) {
  const minDimension = Math.min(project.displayWidth, project.displayHeight);
  return Math.max(1, Math.round(minDimension * strokeWidthRatio * 0.5));
}

export function buildAssDocument(project, defaultStyle, events) {
  const outline = assStrokeWidth(project, defaultStyle.stroke_width_ratio);
  const fontName = String(defaultStyle.font_family).replace(/,/g, " ");
  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${project.displayWidth}`,
    `PlayResY: ${project.displayHeight}`,
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "YCbCr Matrix: None",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Default,${fontName},${defaultStyle.fontSize},${assColor(defaultStyle.color)},${assColor(defaultStyle.color)},${assColor(defaultStyle.stroke_color)},&H00000000,-1,0,0,0,100,100,0,0,1,${outline},0,${defaultStyle.alignment || 2},0,0,0,1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  const lines = events.map((event) => (
    `Dialogue: ${event.layer},${assTime(event.start)},${assTime(event.end)},Default,,0,0,0,,${event.text}`
  ));
  return `${[...header, ...lines].join("\n")}\n`;
}

export function easedProgress(progress, easing = "linear") {
  const value = Math.max(0, Math.min(1, Number(progress)));
  if (easing === "ease-in") return value * value;
  if (easing === "ease-out") return 1 - ((1 - value) ** 2);
  if (easing === "ease-in-out") {
    return value < 0.5
      ? 2 * value * value
      : 1 - (((-2 * value) + 2) ** 2) / 2;
  }
  return value;
}

function animatedValueAtTime(state, time, fromKey, toKey, fallback) {
  if (!state || time < state.start || time >= state.end) return fallback;
  const interpolation = state.easing || state.interpolation || "linear";
  if (interpolation === "step") return Number(state[toKey]);
  const duration = state.end - state.start;
  if (duration <= 0) return fallback;
  const progress = easedProgress((time - state.start) / duration, interpolation);
  const from = Number(state[fromKey] ?? fallback);
  const to = Number(state[toKey] ?? fallback);
  return from + (to - from) * progress;
}

export function scaleAtTime(state, time) {
  return animatedValueAtTime(state, time, "from_scale", "to_scale", 1);
}

export function opacityAtTime(state, time) {
  return animatedValueAtTime(state, time, "from_opacity", "to_opacity", 1);
}

export function translateYAtTime(state, time) {
  return animatedValueAtTime(
    state,
    time,
    "from_translate_y_ratio",
    "to_translate_y_ratio",
    0,
  );
}

export function mergeAdjacentScaleStates(states) {
  const sorted = [...states].sort((left, right) => (
    left.start_word_index - right.start_word_index
    || left.start - right.start
  ));
  const merged = [];
  for (const state of sorted) {
    const previous = merged.at(-1);
    const sameConfig = previous
      && previous.from_scale === state.from_scale
      && previous.to_scale === state.to_scale
      && previous.interpolation === state.interpolation;
    const adjacent = previous && previous.end_word_index + 1 === state.start_word_index;
    if (sameConfig && adjacent) {
      previous.end_word_index = state.end_word_index;
      previous.end = state.end;
    } else {
      merged.push({ ...state });
    }
  }
  return merged;
}

export function boxInsideScreen(box) {
  return box.x >= 0
    && box.y >= 0
    && box.width > 0
    && box.height > 0
    && box.x + box.width <= 1.000001
    && box.y + box.height <= 1.000001;
}

export function normalizeBox(box) {
  return {
    x: Number(box.x),
    y: Number(box.y),
    width: Number(box.width),
    height: Number(box.height),
    unit: "ratio",
  };
}

export { roundTime };
