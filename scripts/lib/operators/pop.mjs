export const popOperator = {
  id: "core.transition.scale-opacity",
  phase: "entry",
  priority: 100,
  writesChannels: ["transform.scale.entry", "style.opacity.entry"],
  timingModels: ["item_enter", "asset_enter"],
  apply({ effect, target }) {
    const duration = 0.18;
    const fromScale = 0.85;
    const toScale = 1;
    const fromOpacity = 0;
    const toOpacity = 1;
    if (effect.timing.kind === "asset_enter") {
      const entry = {
        effect_id: effect.id,
        start: target.lifecycle.start,
        end: Math.min(target.lifecycle.end, target.lifecycle.start + duration),
        duration: Math.min(duration, Math.max(0.001, target.lifecycle.end - target.lifecycle.start)),
        from_scale: fromScale,
        to_scale: toScale,
        from_opacity: fromOpacity,
        to_opacity: toOpacity,
        interpolation: "linear",
        target_kind: "asset",
      };
      target.channels["transform.scale.entry"].push(entry);
      target.channels["style.opacity.entry"].push(entry);
      return;
    }
    for (const item of target.items || []) {
      const next = (target.items || []).find((candidate) => candidate.start > item.start);
      const available = (next ? next.start : target.lifecycle.end) - item.start;
      const animationDuration = Math.max(0.001, Math.min(duration, available));
      const entry = {
        effect_id: effect.id,
        start: item.start,
        end: item.start + animationDuration,
        duration: animationDuration,
        item_id: item.id,
        from_scale: fromScale,
        to_scale: toScale,
        from_opacity: fromOpacity,
        to_opacity: toOpacity,
        interpolation: "linear",
        target_kind: "item",
      };
      target.channels["transform.scale.entry"].push(entry);
      target.channels["style.opacity.entry"].push(entry);
    }
  },
};
