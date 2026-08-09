import fs from "node:fs";
import path from "node:path";

export class WangganError extends Error {
  constructor(message, details = null, statusCode = 400) {
    super(message);
    this.name = "WangganError";
    this.details = details;
    this.statusCode = statusCode;
  }
}

export function roundTime(value) {
  return Math.round(Number(value) * 1000) / 1000;
}

export function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new WangganError(`无法读取 JSON：${filePath}`, { cause: error.message });
  }
}

export function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.tmp`);
  fs.writeFileSync(tempPath, text, "utf8");
  try {
    fs.renameSync(tempPath, filePath);
  } catch {
    fs.copyFileSync(tempPath, filePath);
    fs.unlinkSync(tempPath);
  }
}

export function defaultEditorState() {
  return {
    version: 1,
    savedAt: null,
    currentTime: 0,
    selectedWordIndexes: [],
  };
}

export function validateEditorState(value, options = {}) {
  const wordCount = Number(options.wordCount ?? Infinity);
  const duration = Number(options.duration ?? Infinity);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WangganError("editor-state.json 必须是对象");
  }
  if (value.version !== 1) {
    throw new WangganError("editor-state.json 必须使用 v1 格式", { receivedVersion: value.version ?? null });
  }
  const currentTime = Number(value.currentTime ?? 0);
  if (!Number.isFinite(currentTime) || currentTime < 0 || currentTime > duration + 0.2) {
    throw new WangganError("保存的播放位置无效", { currentTime, duration });
  }
  const selectedWordIndexes = Array.isArray(value.selectedWordIndexes)
    ? [...new Set(value.selectedWordIndexes.map(Number))].sort((left, right) => left - right)
    : [];
  if (selectedWordIndexes.some((wordIndex) => !Number.isInteger(wordIndex) || wordIndex < 0 || wordIndex >= wordCount)) {
    throw new WangganError("保存的逐字稿选择范围无效", { selectedWordIndexes, wordCount });
  }
  return {
    version: 1,
    savedAt: value.savedAt ? String(value.savedAt) : null,
    currentTime: roundTime(Math.min(currentTime, duration)),
    selectedWordIndexes,
  };
}

export function loadEditorState(editorStatePath, options = {}) {
  if (!fs.existsSync(editorStatePath)) return defaultEditorState();
  return validateEditorState(readJson(editorStatePath), options);
}

export function saveEditorState(editorStatePath, value, options = {}) {
  const normalized = validateEditorState(value, options);
  writeJson(editorStatePath, normalized);
  return normalized;
}

export function validateTranscript(value) {
  if (!Array.isArray(value)) {
    throw new WangganError("逐字稿根节点必须是 JSON 数组");
  }
  if (!value.length) {
    throw new WangganError("逐字稿不能为空");
  }

  const words = value.map((item, wordIndex) => {
    const text = typeof item?.text === "string" ? item.text.trim() : "";
    const start = Number(item?.start);
    const end = Number(item?.end);
    if (!text) {
      throw new WangganError(`第 ${wordIndex} 个词缺少有效 text`, { wordIndex, item });
    }
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      throw new WangganError(`第 ${wordIndex} 个词的时间不是数字`, { wordIndex, item });
    }
    if (start < 0 || end <= start) {
      throw new WangganError(`第 ${wordIndex} 个词不满足 0 <= start < end`, { wordIndex, item });
    }
    return { text, start: roundTime(start), end: roundTime(end), wordIndex };
  });

  for (let index = 1; index < words.length; index += 1) {
    const previous = words[index - 1];
    const current = words[index];
    if (current.start < previous.start) {
      throw new WangganError("逐字稿没有按开始时间递增", { previous, current });
    }
    if (current.start < previous.end) {
      throw new WangganError("逐字稿中的相邻词语发生重叠", { previous, current });
    }
  }
  return words;
}

export function loadTranscript(transcriptPath) {
  return validateTranscript(readJson(transcriptPath));
}

function nearestBoundary(words, value, field) {
  return words
    .map((word) => ({
      wordIndex: word.wordIndex,
      text: word.text,
      value: word[field],
      distance: Math.abs(word[field] - value),
    }))
    .sort((left, right) => left.distance - right.distance)
    .slice(0, 3)
    .map(({ distance, ...item }) => item);
}

function findExactBoundary(words, value, field) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return -1;
  return words.findIndex((word) => Math.abs(word[field] - numeric) <= 0.0005);
}

function cleanSource(source) {
  return source === "human" ? "human" : "ai";
}

export const EFFECT_TARGETS = Object.freeze({
  VIDEO_MAIN: "video.main",
  CAPTIONS_OVERLAY: "overlay.captions",
});

export const EFFECT_DEFINITIONS = Object.freeze({
  short_emphasis: Object.freeze({
    target: EFFECT_TARGETS.VIDEO_MAIN,
    scalePercent: 120,
    motion: "cut",
    direction: "in",
    label: "缩近 Zoom in",
  }),
  short_negative: Object.freeze({
    target: EFFECT_TARGETS.VIDEO_MAIN,
    scalePercent: 75,
    motion: "cut",
    direction: "out",
    label: "短促负面",
  }),
  long_emphasis: Object.freeze({
    target: EFFECT_TARGETS.VIDEO_MAIN,
    scalePercent: 120,
    motion: "progressive",
    direction: "in",
    label: "长重点",
  }),
  long_negative: Object.freeze({
    target: EFFECT_TARGETS.VIDEO_MAIN,
    scalePercent: 75,
    motion: "progressive",
    direction: "out",
    label: "长负面",
  }),
  large_bright: Object.freeze({
    target: EFFECT_TARGETS.CAPTIONS_OVERLAY,
    fontScale: 1.25,
    color: "#FFF08A",
    label: "大字号、亮颜色",
  }),
});

export function effectDefinition(effectType) {
  return EFFECT_DEFINITIONS[effectType] || null;
}

export function resolveEffect(input, words, options = {}) {
  let startWordIndex = Number.isInteger(Number(input?.start_word_index))
    ? Number(input.start_word_index)
    : -1;
  let endWordIndex = Number.isInteger(Number(input?.end_word_index))
    ? Number(input.end_word_index)
    : -1;

  if (startWordIndex < 0 || endWordIndex < 0) {
    startWordIndex = findExactBoundary(words, input?.start, "start");
    endWordIndex = findExactBoundary(words, input?.end, "end");
    if (startWordIndex < 0 || endWordIndex < 0) {
      throw new WangganError("效果时间没有精确匹配逐字稿边界", {
        received: { start: input?.start, end: input?.end },
        nearestStart: nearestBoundary(words, Number(input?.start), "start"),
        nearestEnd: nearestBoundary(words, Number(input?.end), "end"),
      });
    }
  }

  if (startWordIndex >= words.length || endWordIndex >= words.length || endWordIndex < startWordIndex) {
    throw new WangganError("效果词语范围无效", {
      startWordIndex,
      endWordIndex,
      wordCount: words.length,
    });
  }

  if (input?.params !== undefined) {
    throw new WangganError("当前版本的效果参数已经固定，不能提交 params", { params: input.params });
  }

  const effectType = input?.effect_type;
  const definition = effectDefinition(effectType);
  if (!definition) {
    throw new WangganError("不支持的 effect_type", {
      effect_type: effectType ?? null,
      allowed: Object.keys(EFFECT_DEFINITIONS),
    });
  }
  const target = String(input?.target || definition.target).trim();
  if (target !== definition.target) {
    throw new WangganError("effect_type 与 target 不匹配", {
      effect_type: effectType,
      target,
      expectedTarget: definition.target,
    });
  }

  const selectedWords = words.slice(startWordIndex, endWordIndex + 1);
  const source = cleanSource(input?.source ?? options.defaultSource);
  return {
    id: String(input?.id || options.id || "").trim(),
    target,
    effect_type: effectType,
    start_word_index: startWordIndex,
    end_word_index: endWordIndex,
    start: selectedWords[0].start,
    end: selectedWords.at(-1).end,
    source,
    text: selectedWords.map((word) => word.text).join(""),
    human_modified: Boolean(input?.human_modified),
  };
}

function nextEffectId(index) {
  return `effect-${String(index + 1).padStart(3, "0")}`;
}

export function validateEffects(inputs, words, options = {}) {
  if (!Array.isArray(inputs)) {
    throw new WangganError("effects 必须是数组");
  }
  const effects = inputs
    .map((input, index) => resolveEffect(input, words, {
      defaultSource: options.defaultSource ?? "ai",
      id: input?.id || nextEffectId(index),
    }))
    .filter(Boolean)
    .sort((left, right) => (
      left.start - right.start
      || left.end - right.end
      || left.target.localeCompare(right.target)
    ));

  const ids = new Set();
  const previousByTarget = new Map();
  for (let index = 0; index < effects.length; index += 1) {
    const effect = effects[index];
    if (!effect.id) effect.id = nextEffectId(index);
    if (ids.has(effect.id)) {
      throw new WangganError("效果 id 重复", { id: effect.id });
    }
    ids.add(effect.id);
    const previous = previousByTarget.get(effect.target);
    if (previous && effect.start < previous.end) {
      throw new WangganError("同一效果目标发生重叠", { target: effect.target, previous, current: effect }, 409);
    }
    previousByTarget.set(effect.target, effect);
  }
  return effects;
}

export function effectsDocument(effects) {
  return { version: 3, effects };
}

export function loadEffects(effectsPath, words) {
  if (!fs.existsSync(effectsPath)) return [];
  const value = readJson(effectsPath);
  if (![2, 3].includes(value?.version) || !Array.isArray(value?.effects)) {
    throw new WangganError("effects.json 必须使用 v2 或 v3 格式", {
      receivedVersion: value?.version ?? null,
    });
  }
  return validateEffects(value.effects, words);
}

export function saveEffects(effectsPath, effects) {
  writeJson(effectsPath, effectsDocument(effects));
}

export function loadProject(projectInput) {
  const candidate = path.resolve(projectInput);
  const projectPath = fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()
    ? path.join(candidate, "project.json")
    : candidate;
  if (!fs.existsSync(projectPath)) {
    throw new WangganError(`找不到项目文件：${projectPath}`);
  }
  const project = readJson(projectPath);
  project.projectPath = projectPath;
  project.projectDir = path.dirname(projectPath);
  project.effectsPath = path.resolve(project.projectDir, project.effectsFile || "effects.json");
  project.overlaysPath = path.resolve(project.projectDir, project.overlaysFile || "overlays.json");
  project.editorStatePath = path.resolve(project.projectDir, project.editorStateFile || "editor-state.json");
  project.renderStatusPath = path.resolve(project.projectDir, project.renderStatusFile || "render-status.json");
  project.videoPath = path.resolve(project.videoPath);
  project.transcriptPath = path.resolve(project.transcriptPath);
  project.subtitlePath = project.subtitlePath ? path.resolve(project.subtitlePath) : null;
  project.previewVideoPath = path.resolve(project.previewVideoPath || project.videoPath);
  project.outputPath = path.resolve(project.outputPath);
  return project;
}

export function projectState(projectInput) {
  const project = typeof projectInput === "string" ? loadProject(projectInput) : projectInput;
  const words = loadTranscript(project.transcriptPath);
  const effects = loadEffects(project.effectsPath, words);
  const renderStatus = fs.existsSync(project.renderStatusPath)
    ? readJson(project.renderStatusPath)
    : { state: "idle" };
  const editorState = loadEditorState(project.editorStatePath, {
    wordCount: words.length,
    duration: project.duration,
  });
  return {
    project: {
      version: project.version,
      videoPath: project.videoPath,
      transcriptPath: project.transcriptPath,
      subtitlePath: project.subtitlePath,
      outputPath: project.outputPath,
      duration: project.duration,
      displayWidth: project.displayWidth,
      displayHeight: project.displayHeight,
    },
    words,
    effects,
    editorState,
    renderStatus,
  };
}

export function unwrapEffectsInput(value) {
  if (![2, 3].includes(value?.version) || !Array.isArray(value?.effects)) {
    throw new WangganError("导入文件必须包含 version: 2 或 3 和 effects 数组", {
      receivedVersion: value?.version ?? null,
    });
  }
  return value.effects;
}
