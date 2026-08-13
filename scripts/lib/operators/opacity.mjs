export const opacityOperator = {
  id: "core.style.opacity",
  phase: "style",
  priority: 80,
  writesChannels: ["style.opacity"],
  timingModels: ["word_range", "cue", "item"],
  apply({ effect, target, timing }) {
    const range = timing;
    target.channels["style.opacity"].push({
      effect_id: effect.id,
      start: range.start,
      end: range.end,
      start_word_index: range.start_word_index,
      end_word_index: range.end_word_index,
      item_id: range.item_id || null,
      from_opacity: Number(effect.config.from_opacity),
      to_opacity: Number(effect.config.to_opacity),
      interpolation: effect.config.interpolation,
    });
  },
};
