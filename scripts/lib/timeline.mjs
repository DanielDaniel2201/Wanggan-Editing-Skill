import { WangganError, roundTime } from "./core.mjs";

export function alignableCharacter(value) {
  return /[\p{L}\p{N}]/u.test(value);
}

export function normalizeAlignableText(text) {
  return Array.from(String(text || ""))
    .filter((character) => alignableCharacter(character))
    .map((character) => character.toLocaleLowerCase())
    .join("");
}

export function resolveWordRange(words, startWordIndex, endWordIndex, label = "词语范围") {
  const start = Number(startWordIndex);
  const end = Number(endWordIndex);
  if (
    !Number.isInteger(start)
    || !Number.isInteger(end)
    || start < 0
    || end < start
    || end >= words.length
  ) {
    throw new WangganError(`${label}无效`, {
      start_word_index: startWordIndex ?? null,
      end_word_index: endWordIndex ?? null,
      wordCount: words.length,
    });
  }
  const selected = words.slice(start, end + 1);
  return {
    start_word_index: start,
    end_word_index: end,
    start: selected[0].start,
    end: selected.at(-1).end,
    source_text: selected.map((word) => word.text).join(""),
    words: selected,
  };
}

export function sourceText(words, startWordIndex, endWordIndex) {
  return resolveWordRange(words, startWordIndex, endWordIndex).source_text;
}

function cueRange(cue, words, label) {
  if (!cue) throw new WangganError(`${label}不存在`);
  if (Number.isInteger(cue.start_word_index) && Number.isInteger(cue.end_word_index)) {
    return resolveWordRange(words, cue.start_word_index, cue.end_word_index, label);
  }
  return {
    start: Number(cue.start),
    end: Number(cue.end),
    start_word_index: null,
    end_word_index: null,
    source_text: cue.text || "",
  };
}

function itemRange(item, words, label) {
  if (!item) throw new WangganError(`${label}不存在`);
  if (Number.isInteger(item.start_word_index) && Number.isInteger(item.end_word_index)) {
    return resolveWordRange(words, item.start_word_index, item.end_word_index, label);
  }
  if (Number.isFinite(Number(item.start)) && Number.isFinite(Number(item.end))) {
    return {
      start: Number(item.start),
      end: Number(item.end),
      start_word_index: item.start_word_index ?? null,
      end_word_index: item.end_word_index ?? null,
      source_text: item.source_text || item.display_text || "",
    };
  }
  throw new WangganError(`${label}缺少可解析的时间范围`);
}

function assetRange(target, words, label) {
  if (
    Number.isFinite(Number(target?.lifecycle?.start))
    && Number.isFinite(Number(target?.lifecycle?.end))
  ) {
    return target.lifecycle;
  }
  if (target?.lifecycle?.kind === "word_range") {
    return resolveWordRange(
      words,
      target.lifecycle.start_word_index,
      target.lifecycle.end_word_index,
      label,
    );
  }
  const items = target?.items || target?.props?.items || [];
  if (items.length) {
    const first = itemRange(items[0], words, `${label} first item`);
    const last = itemRange(items.at(-1), words, `${label} last item`);
    return {
      start: first.start,
      end: last.end,
      start_word_index: first.start_word_index,
      end_word_index: last.end_word_index,
    };
  }
  if (target?.lifecycle?.kind === "full") {
    return {
      start: words[0]?.start ?? 0,
      end: words.at(-1)?.end ?? 0,
      start_word_index: 0,
      end_word_index: Math.max(0, words.length - 1),
    };
  }
  throw new WangganError(`${label}缺少可解析的 lifecycle`);
}

export function resolveEffectTiming(effect, target, context) {
  const { words, captionCues = [] } = context;
  const timing = effect?.timing || {};
  switch (timing.kind) {
    case "word_range":
      return resolveWordRange(words, timing.start_word_index, timing.end_word_index, `Effect ${effect.id} 时间范围`);
    case "cue": {
      const cue = captionCues.find((candidate) => candidate.id === timing.cue_id);
      return cueRange(cue, words, `Effect ${effect.id} cue ${timing.cue_id}`);
    }
    case "item": {
      const item = (target?.items || target?.props?.items || []).find((candidate) => candidate.id === timing.item_id);
      return {
        ...itemRange(item, words, `Effect ${effect.id} item ${timing.item_id}`),
        item_id: timing.item_id,
      };
    }
    case "asset_items":
    case "item_enter":
      if (!(target?.items || target?.props?.items || []).length) {
        throw new WangganError(`Effect ${effect.id} 的 ${timing.kind} 需要目标 Asset 含有 items`);
      }
      return assetRange(target, words, `Effect ${effect.id} asset`);
    case "asset_enter":
      return assetRange(target, words, `Effect ${effect.id} asset`);
    default:
      throw new WangganError(`Effect ${effect?.id || "unknown"} 缺少有效 timing.kind`, {
        timing: timing.kind ?? null,
      });
  }
}

export function validateEffectTiming(effect, typeDef, asset, words, captionCues = []) {
  const kind = effect?.timing?.kind;
  if (!kind) {
    throw new WangganError("Effect 必须声明 timing.kind", { effect: effect?.id || null });
  }
  const allowed = typeDef.timing_models || [];
  if (allowed.length && !allowed.includes(kind)) {
    throw new WangganError("Effect 时间模型不受支持", {
      id: effect.id,
      timing: kind,
      allowed,
    });
  }
  return resolveEffectTiming(effect, asset, { words, captionCues });
}

function nearbyWords(words, wordIndex, radius = 4) {
  const start = Math.max(0, wordIndex - radius);
  const end = Math.min(words.length - 1, wordIndex + radius);
  return words.slice(start, end + 1).map((word) => ({
    wordIndex: word.wordIndex,
    text: word.text,
    start: word.start,
    end: word.end,
  }));
}

export function alignCuesToWords(cues, words) {
  const wordChars = words.flatMap((word) => (
    Array.from(word.text)
      .filter((character) => alignableCharacter(character))
      .map((character) => ({
        character: character.toLocaleLowerCase(),
        wordIndex: word.wordIndex,
      }))
  ));
  let cursor = 0;
  const aligned = [];
  for (const cue of cues) {
    const cueChars = Array.from(cue.text)
      .filter((character) => alignableCharacter(character))
      .map((character) => character.toLocaleLowerCase());
    if (!cueChars.length) {
      throw new WangganError("SRT 与逐字稿无法对齐：字幕没有可对齐字符", { cue });
    }
    const startCursor = cursor;
    for (let index = 0; index < cueChars.length; index += 1) {
      const expected = cueChars[index];
      const actual = wordChars[cursor];
      if (!actual || actual.character !== expected) {
        const wordIndex = actual?.wordIndex ?? words.at(-1)?.wordIndex ?? 0;
        throw new WangganError("SRT 与逐字稿无法顺序对齐", {
          cue: { id: cue.id, start: cue.start, end: cue.end, text: cue.text },
          cueCharacterIndex: index,
          expected,
          actual: actual?.character ?? null,
          nearbyWords: nearbyWords(words, wordIndex),
          timeDifference: actual
            ? roundTime(words[actual.wordIndex].start - cue.start)
            : roundTime(words.at(-1).end - cue.end),
        });
      }
      cursor += 1;
    }
    const startWordIndex = wordChars[startCursor].wordIndex;
    const endWordIndex = wordChars[cursor - 1].wordIndex;
    if (endWordIndex < startWordIndex) {
      throw new WangganError("SRT 对齐结果不是连续词语范围", { cue, startWordIndex, endWordIndex });
    }
    aligned.push({
      ...cue,
      start_word_index: startWordIndex,
      end_word_index: endWordIndex,
    });
  }
  if (cursor !== wordChars.length) {
    const leftover = wordChars[cursor];
    throw new WangganError("SRT 与逐字稿无法顺序对齐：逐字稿仍有剩余文字", {
      leftoverWordIndex: leftover?.wordIndex ?? null,
      nearbyWords: leftover ? nearbyWords(words, leftover.wordIndex) : [],
    });
  }
  return aligned;
}

export function mergedTimeRanges(ranges) {
  const sorted = ranges
    .map((range) => ({ ...range, start: roundTime(range.start), end: roundTime(range.end) }))
    .filter((range) => Number.isFinite(range.start) && Number.isFinite(range.end) && range.end > range.start)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const merged = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    const targetKey = [...(range.targets || [])].sort().join("\u0000");
    const previousTargetKey = [...(previous?.targets || [])].sort().join("\u0000");
    if (previous && targetKey === previousTargetKey && range.start <= previous.end + 0.0005) {
      previous.end = Math.max(previous.end, range.end);
      previous.overlay_ids = [...new Set([...(previous.overlay_ids || []), ...(range.overlay_ids || [])])];
      previous.item_ids = [...new Set([...(previous.item_ids || []), ...(range.item_ids || [])])];
      previous.asset_ids = [...new Set([...(previous.asset_ids || []), ...(range.asset_ids || [])])];
    } else {
      merged.push({
        ...range,
        overlay_ids: [...(range.overlay_ids || [])],
        item_ids: [...(range.item_ids || [])],
        asset_ids: [...(range.asset_ids || [])],
        targets: [...(range.targets || [])],
      });
    }
  }
  return merged;
}

export function subtractTimeRanges(start, end, ranges) {
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

export function rangesOverlap(left, right) {
  return left.start < right.end && right.start < left.end;
}
