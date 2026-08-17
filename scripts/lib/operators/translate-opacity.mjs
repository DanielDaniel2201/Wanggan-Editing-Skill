function clampDuration(value, available) {
  const requested = Math.max(0.001, Number(value));
  return Math.max(0.001, Math.min(requested, Math.max(0.001, available)));
}

function entryFor(effect, start, end, targetKind, itemId = null) {
  const delay = Math.max(0, Number(effect.config.delay || 0));
  const available = Math.max(0.001, end - start);
  const delayedStart = start + Math.min(delay, Math.max(0, available - 0.001));
  const duration = clampDuration(effect.config.duration, end - delayedStart);
  return {
    effect_id: effect.id,
    start: delayedStart,
    end: Math.min(end, delayedStart + duration),
    duration,
    item_id: itemId,
    from_translate_y_ratio: Number(effect.config.from_translate_y_ratio),
    to_translate_y_ratio: Number(effect.config.to_translate_y_ratio),
    from_opacity: Number(effect.config.from_opacity),
    to_opacity: Number(effect.config.to_opacity),
    easing: effect.config.easing,
    interpolation: effect.config.easing,
    target_kind: targetKind,
  };
}

export const translateOpacityOperator = {
  id: "core.transition.translate-opacity",
  phase: "entry",
  priority: 110,
  writesChannels: ["transform.translate-y.entry", "style.opacity.entry"],
  timingModels: ["item_enter", "asset_enter"],
  apply({ effect, target }) {
    if (effect.timing.kind === "asset_enter") {
      const entry = entryFor(
        effect,
        target.lifecycle.start,
        target.lifecycle.end,
        "asset",
      );
      target.channels["transform.translate-y.entry"].push(entry);
      target.channels["style.opacity.entry"].push(entry);
      return;
    }
    for (const item of target.items || []) {
      const next = (target.items || []).find((candidate) => candidate.start > item.start);
      const end = next ? next.start : target.lifecycle.end;
      const entry = entryFor(effect, item.start, end, "item", item.id);
      target.channels["transform.translate-y.entry"].push(entry);
      target.channels["style.opacity.entry"].push(entry);
    }
  },
};
