export const textStyleOperator = {
  id: "core.style.text",
  phase: "style",
  priority: 100,
  writesChannels: ["style.font-scale", "style.color"],
  timingModels: ["word_range", "cue", "item"],
  apply({ effect, target, timing }) {
    const range = timing;
    const span = {
      effect_id: effect.id,
      start: range.start,
      end: range.end,
      start_word_index: range.start_word_index,
      end_word_index: range.end_word_index,
      item_id: range.item_id || null,
      font_scale: Number(effect.config.font_scale),
      color: String(effect.config.color).toUpperCase(),
    };
    target.channels["style.font-scale"].push(span);
    target.channels["style.color"].push(span);
    target.styleSpans.push(span);
  },
};
