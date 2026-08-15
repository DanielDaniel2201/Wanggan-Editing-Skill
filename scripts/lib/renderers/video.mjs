import { mergeAdjacentScaleStates } from "../ass.mjs";

export const videoRenderer = {
  id: "core.video",
  supportedChannels: ["transform.scale"],
  supportsSuppression: false,
  resolve({ asset, typeDef, words, project }) {
    return {
      id: asset.id,
      type: asset.type,
      typeDef,
      enabled: asset.enabled !== false,
      layer: typeDef.default_layer ?? 0,
      capabilities: typeDef.capabilities || [],
      origin: asset.origin,
      source: { input: "video", path: project.videoPath },
      lifecycle: { kind: "full", start: 0, end: project.duration },
      props: asset.props || {},
      items: [],
      styleSpans: [],
      channels: {
        "transform.scale": [],
      },
    };
  },
  finalize(resolved, project) {
    const scales = mergeAdjacentScaleStates(resolved.channels["transform.scale"] || []);
    return {
      id: resolved.id,
      type: resolved.type,
      layer: resolved.layer,
      enabled: resolved.enabled,
      capabilities: resolved.capabilities,
      lifecycle: resolved.lifecycle,
      source: resolved.source,
      layout: { kind: "full-frame" },
      style: {},
      content: { kind: "video" },
      states: scales.map((state) => ({
        start: state.start,
        end: state.end,
        transform: {
          scale: {
            from: state.from_scale,
            to: state.to_scale,
            interpolation: state.interpolation,
            underflow_fill: state.underflow_fill,
          },
        },
      })),
      playbackEffects: scales.map((state) => ({
        id: state.effect_id,
        asset_id: resolved.id,
        start: state.start,
        end: state.end,
        start_word_index: state.start_word_index,
        end_word_index: state.end_word_index,
        scale_percent: Math.round(state.to_scale * 100),
        motion: state.interpolation === "linear" ? "progressive" : "cut",
        direction: state.to_scale >= 1 ? "in" : "out",
        effect_label: state.to_scale >= 1
          ? (state.interpolation === "linear" ? "过渡放大" : "瞬间放大")
          : (state.interpolation === "linear" ? "过渡缩小" : "瞬间缩小"),
        from_scale: state.from_scale,
        to_scale: state.to_scale,
        interpolation: state.interpolation,
      })),
    };
  },
};
