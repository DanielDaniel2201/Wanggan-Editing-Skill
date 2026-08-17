import { roundTime } from "../core.mjs";
import { assColor, assStrokeWidth, escapeAssText } from "../ass.mjs";
import { captionFragmentText, styledCaptionLayout } from "../text-layout.mjs";
import { subtractTimeRanges } from "../timeline.mjs";

function suppressCaptionCues(cues, words, suppressionRanges) {
  if (!suppressionRanges.length) return cues;
  const output = [];
  for (const cue of cues) {
    const overlaps = suppressionRanges.filter((range) => range.end > cue.start && range.start < cue.end);
    if (!overlaps.length) {
      output.push(cue);
      continue;
    }
    const visibleIntervals = subtractTimeRanges(cue.start, cue.end, overlaps);
    for (const interval of visibleIntervals) {
      const text = captionFragmentText(cue, words, interval.start, interval.end);
      if (!text) continue;
      output.push({
        ...cue,
        id: `${cue.id}-part-${String(output.length + 1).padStart(3, "0")}`,
        source_cue_id: cue.source_cue_id || cue.id,
        start: roundTime(interval.start),
        end: roundTime(interval.end),
        text,
      });
    }
  }
  return output;
}

export const captionsRenderer = {
  id: "core.captions",
  supportedAssetProps: [
    "box",
    "style.font_family",
    "style.font_size_ratio",
    "style.color",
    "style.stroke_color",
    "style.stroke_width_ratio",
  ],
  supportedChannels: ["style.font-scale", "style.color"],
  supportsSuppression: true,
  resolve({ asset, typeDef, project }) {
    return {
      id: asset.id,
      type: asset.type,
      typeDef,
      enabled: asset.enabled !== false,
      layer: typeDef.default_layer ?? 300,
      capabilities: typeDef.capabilities || [],
      origin: asset.origin,
      source: { input: "captions", path: project.inputs?.captions?.path || project.subtitlePath },
      lifecycle: { kind: "full", start: 0, end: project.duration },
      props: asset.props,
      items: [],
      styleSpans: [],
      channels: {
        "style.font-scale": [],
        "style.color": [],
      },
    };
  },
  finalize(resolved, project, context) {
    const cues = context.captionCues || [];
    const visible = suppressCaptionCues(cues, context.words, context.suppressionRanges || []);
    const style = resolved.props.style;
    const box = resolved.props.box;
    const overrides = resolved.props.cue_overrides || {};
    const minDimension = Math.min(project.displayWidth, project.displayHeight);
    const fontSize = Math.max(12, Math.round(minDimension * style.font_size_ratio));
    const boxWidth = project.displayWidth * box.width;
    const compiled = visible.map((cue) => {
      const sourceCueId = cue.source_cue_id || cue.id;
      const override = overrides[sourceCueId] || {};
      const cueFontSizeRatio = override.font_size_ratio || style.font_size_ratio;
      const cueBaseFontSize = Math.max(12, Math.round(minDimension * cueFontSizeRatio));
      const cueMaxWidth = Math.max(6, boxWidth / cueBaseFontSize);
      const layout = styledCaptionLayout(cue, context.words, resolved.styleSpans, cueMaxWidth);
      return {
        ...cue,
        source_cue_id: sourceCueId,
        font_family: override.font_family || style.font_family,
        font_size_ratio: cueFontSizeRatio,
        font_size: cueBaseFontSize,
        layout_font_scale: layout.fontScale,
        lines: layout.lines.map((line) => line.map((segment) => segment.text).join("")),
        styledLines: layout.lines,
      };
    });
    const centerX = Math.round(project.displayWidth * (box.x + box.width / 2));
    const bottomY = Math.round(project.displayHeight * (box.y + box.height));
    const assEvents = resolved.enabled ? compiled.map((cue) => {
      const layoutFontScale = Number(cue.layout_font_scale) || 1;
      const cueFontSize = Math.max(1, Math.round((cue.font_size || fontSize) * layoutFontScale));
      const text = (cue.styledLines || [])
        .map((line) => line.map((segment) => {
          const escaped = escapeAssText(segment.text);
          if (!segment.style) return escaped;
          const emphasizedFontSize = Math.max(1, Math.round(cueFontSize * segment.style.font_scale));
          return `{\\fs${emphasizedFontSize}\\c${assColor(segment.style.color)}}${escaped}{\\fs${cueFontSize}\\c${assColor(style.color)}}`;
        }).join(""))
        .join("\\N");
      const cueFontName = String(cue.font_family || style.font_family).replace(/[,{}\\]/g, " ");
      return {
        layer: 0,
        start: cue.start,
        end: cue.end,
        text: `{\\an2\\pos(${centerX},${bottomY})\\fn${cueFontName}\\fs${cueFontSize}}${text}`,
      };
    }) : [];
    return {
      id: resolved.id,
      type: resolved.type,
      layer: resolved.layer,
      enabled: resolved.enabled,
      capabilities: resolved.capabilities,
      lifecycle: resolved.lifecycle,
      source: resolved.source,
      layout: { box },
      style,
      content: { kind: "cues", cues: compiled },
      fontSize,
      maxWidth: Math.max(6, boxWidth / fontSize),
      effectCount: resolved.styleSpans.length,
      cueCount: cues.length,
      playbackCueCount: compiled.length,
      states: compiled.map((cue) => ({
        start: cue.start,
        end: cue.end,
        content: cue,
      })),
      assEvents,
      playbackCaptions: compiled,
      captionTrack: {
        enabled: resolved.enabled,
        source: "srt",
        sourcePath: resolved.source.path,
        cueCount: cues.length,
        effectCount: resolved.styleSpans.length,
        playbackCueCount: compiled.length,
        box,
        style,
        fontSize,
      },
    };
  },
};
