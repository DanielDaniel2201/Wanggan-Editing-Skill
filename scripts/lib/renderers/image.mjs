import fs from "node:fs";
import path from "node:path";
import { resolveWordRange } from "../timeline.mjs";
import { normalizeBox } from "../ass.mjs";

export const imageRenderer = {
  id: "core.image",
  supportedAssetProps: ["box"],
  supportedChannels: [
    "transform.scale",
    "style.opacity",
    "transform.scale.entry",
    "style.opacity.entry",
  ],
  supportsSuppression: true,
  resolve({ asset, typeDef, words, project }) {
    const range = resolveWordRange(
      words,
      asset.lifecycle.start_word_index,
      asset.lifecycle.end_word_index,
      `贴图 ${asset.id}`,
    );
    const imagePath = path.resolve(project.projectDir || process.cwd(), asset.props.image_path);
    return {
      id: asset.id,
      type: asset.type,
      typeDef,
      enabled: asset.enabled !== false,
      layer: typeDef.default_layer ?? 200,
      capabilities: typeDef.capabilities || [],
      origin: asset.origin,
      source: { kind: "file", path: asset.props.image_path, resolved: imagePath },
      lifecycle: {
        kind: "word_range",
        ...range,
      },
      props: {
        ...asset.props,
        fit: "contain",
        box: normalizeBox(asset.props.box),
      },
      items: [],
      styleSpans: [],
      channels: {
        "transform.scale": [],
        "style.opacity": [],
        "transform.scale.entry": [],
        "style.opacity.entry": [],
      },
    };
  },
  finalize(resolved, _project, context = {}) {
    const stat = fs.existsSync(resolved.source.resolved)
      ? fs.statSync(resolved.source.resolved)
      : { mtimeMs: 0, size: 0 };
    const assetUrl = `/overlay-images/${encodeURIComponent(resolved.id)}?v=${Math.round(stat.mtimeMs)}-${stat.size}`;
    const state = {
      id: resolved.id,
      overlay_id: resolved.id,
      enabled: resolved.enabled,
      image_path: resolved.props.image_path,
      resolved_image_path: resolved.source.resolved,
      asset_url: assetUrl,
      fit: "contain",
      box: resolved.props.box,
      start: resolved.lifecycle.start,
      end: resolved.lifecycle.end,
      start_word_index: resolved.lifecycle.start_word_index,
      end_word_index: resolved.lifecycle.end_word_index,
      source_text: resolved.lifecycle.source_text,
      source: resolved.origin.created_by === "human" ? "human" : "ai",
      human_modified: resolved.origin.human_modified,
    };
    const pop = resolved.channels["transform.scale.entry"]?.[0];
    const effects = {
      scale: resolved.channels["transform.scale"] || [],
      opacity: resolved.channels["style.opacity"] || [],
      entryScale: resolved.channels["transform.scale.entry"] || [],
      entryOpacity: resolved.channels["style.opacity.entry"] || [],
    };
    const suppressionRanges = context.suppressionRanges || [];
    state.effects = effects;
    state.suppression_ranges = suppressionRanges;
    return {
      id: resolved.id,
      type: resolved.type,
      layer: resolved.layer,
      enabled: resolved.enabled,
      capabilities: resolved.capabilities,
      lifecycle: resolved.lifecycle,
      source: {
        ...resolved.source,
        asset_url: assetUrl,
      },
      layout: { box: resolved.props.box, fit: "contain" },
      style: {},
      content: { kind: "image" },
      states: resolved.enabled ? [{
        start: resolved.lifecycle.start,
        end: resolved.lifecycle.end,
        enter_animation: pop ? "pop" : "none",
        animation_duration: pop?.duration || 0,
        layout: { box: resolved.props.box },
        effects,
        suppression_ranges: suppressionRanges,
      }] : [],
      playbackImage: resolved.enabled ? state : null,
      group: state,
    };
  },
};
