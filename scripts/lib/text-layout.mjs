import { alignableCharacter } from "./timeline.mjs";

export function textLength(text) {
  return Array.from(String(text || "").replace(/\s+/g, "")).length;
}

export function tokenizeForWrap(text) {
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

function styleKey(style) {
  if (!style) return "plain";
  return `${style.font_scale || 1}:${style.color || ""}`;
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

export function layoutStyledItems(items, maxWidth) {
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

export function alignedCueWordIndexes(cue, words) {
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

export function resolvedCueWordIndexes(cue, words) {
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

export function captionFragmentText(cue, words, start, end) {
  const { cueCharacters, wordIndexes } = resolvedCueWordIndexes(cue, words);
  const activeWordIndexes = new Set(words
    .filter((word) => word.end > start + 0.0005 && word.start < end - 0.0005)
    .map((word) => word.wordIndex));
  return String(cueCharacters
    .filter((_character, index) => activeWordIndexes.has(wordIndexes[index]))
    .join(""))
    .replace(/<[^>]*>/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

export function styleForWord(wordIndex, styleSpans) {
  if (!Number.isInteger(wordIndex)) return null;
  const span = styleSpans.find((item) => (
    wordIndex >= item.start_word_index && wordIndex <= item.end_word_index
  ));
  if (!span) return null;
  return {
    font_scale: span.font_scale,
    color: span.color,
  };
}

export function styledCaptionLayout(cue, words, styleSpans, maxWidth) {
  const { cueCharacters, wordIndexes } = alignedCueWordIndexes(cue, words);
  const styles = wordIndexes.map((wordIndex) => styleForWord(wordIndex, styleSpans));
  for (let index = 0; index < cueCharacters.length; index += 1) {
    if (styles[index] || alignableCharacter(cueCharacters[index])) continue;
    const left = styles.slice(0, index).reverse().find(Boolean) || null;
    const right = styles.slice(index + 1).find(Boolean) || null;
    if (left && right && styleKey(left) === styleKey(right)) styles[index] = left;
  }
  const items = cueCharacters.map((character, index) => ({ character, style: styles[index] || null }));
  return layoutStyledItems(items, maxWidth);
}
