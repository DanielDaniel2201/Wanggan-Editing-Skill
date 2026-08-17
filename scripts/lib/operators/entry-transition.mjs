function clampDuration(value, available) {
  const requested = Math.max(0.001, Number(value));
  return Math.max(0.001, Math.min(requested, Math.max(0.001, available)));
}

function entriesFor(effect, target, fields) {
  const create = (start, end, targetKind, itemId = null) => {
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
      easing: effect.config.easing,
      interpolation: effect.config.easing,
      target_kind: targetKind,
      ...Object.fromEntries(fields.map((field) => [field, Number(effect.config[field])])),
    };
  };
  if (effect.timing.kind === "asset_enter") {
    return [create(target.lifecycle.start, target.lifecycle.end, "asset")];
  }
  return (target.items || []).map((item, index, items) => {
    const next = items[index + 1];
    return create(item.start, next ? next.start : target.lifecycle.end, "item", item.id);
  });
}

export const translateYEntryOperator = {
  id: "core.transition.translate-y",
  phase: "entry",
  priority: 105,
  writesChannels: ["transform.translate-y.entry"],
  timingModels: ["item_enter", "asset_enter"],
  apply({ effect, target }) {
    target.channels["transform.translate-y.entry"].push(...entriesFor(effect, target, [
      "from_translate_y_ratio",
      "to_translate_y_ratio",
    ]));
  },
};

export const scaleEntryOperator = {
  id: "core.transition.scale",
  phase: "entry",
  priority: 104,
  writesChannels: ["transform.scale.entry"],
  timingModels: ["item_enter", "asset_enter"],
  apply({ effect, target }) {
    target.channels["transform.scale.entry"].push(...entriesFor(effect, target, [
      "from_scale",
      "to_scale",
    ]));
  },
};

export const opacityEntryOperator = {
  id: "core.transition.opacity",
  phase: "entry",
  priority: 106,
  writesChannels: ["style.opacity.entry"],
  timingModels: ["item_enter", "asset_enter"],
  apply({ effect, target }) {
    target.channels["style.opacity.entry"].push(...entriesFor(effect, target, [
      "from_opacity",
      "to_opacity",
    ]));
  },
};
