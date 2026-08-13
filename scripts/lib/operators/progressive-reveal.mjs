export const progressiveRevealOperator = {
  id: "core.visibility.item-sequence",
  phase: "visibility",
  priority: 100,
  writesChannels: ["visibility.items"],
  timingModels: ["asset_items"],
  apply({ effect, target }) {
    const items = target.items || [];
    if (!items.length) return;
    const retainUntil = effect.config?.retain_until || "asset_end";
    const assetEnd = retainUntil === "asset_end"
      ? target.lifecycle.end
      : items.at(-1).end;
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const next = items[index + 1];
      target.channels["visibility.items"].push({
        effect_id: effect.id,
        start: item.start,
        end: next ? next.start : assetEnd,
        visible_item_ids: items.slice(0, index + 1).map((entry) => entry.id),
        entering_item_id: item.id,
      });
    }
  },
};
