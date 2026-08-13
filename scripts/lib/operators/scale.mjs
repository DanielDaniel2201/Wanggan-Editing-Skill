export const scaleOperator = {
  id: "core.transform.scale",
  phase: "transform",
  priority: 100,
  writesChannels: ["transform.scale"],
  timingModels: ["word_range"],
  apply({ effect, target, timing }) {
    const range = timing;
    target.channels["transform.scale"].push({
      effect_id: effect.id,
      start: range.start,
      end: range.end,
      start_word_index: range.start_word_index,
      end_word_index: range.end_word_index,
      from_scale: Number(effect.config.from_scale),
      to_scale: Number(effect.config.to_scale),
      interpolation: effect.config.interpolation,
      underflow_fill: effect.config.underflow_fill,
    });
  },
};
