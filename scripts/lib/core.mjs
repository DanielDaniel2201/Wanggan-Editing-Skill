import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SKILL_ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const COMPILER_VERSION = 20;

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

export function deepClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

export function deepMerge(base, extra) {
  if (!extra || typeof extra !== "object" || Array.isArray(extra)) return extra === undefined ? deepClone(base) : deepClone(extra);
  if (!base || typeof base !== "object" || Array.isArray(base)) return deepClone(extra);
  const result = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    result[key] = key in result ? deepMerge(result[key], value) : deepClone(value);
  }
  return result;
}

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}
