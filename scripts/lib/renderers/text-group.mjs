import { resolveWordRange, subtractTimeRanges } from "../timeline.mjs";
import { splitCaptionLines } from "../text-layout.mjs";
import {
  assColor,
  assStrokeWidth,
  escapeAssText,
  normalizeBox,
  opacityAtTime,
  scaleAtTime,
} from "../ass.mjs";

function autoItemBoxes(itemCount) {
  const keywordBoxHeight = 0.055;
  const centeredBox = (centerX, centerY, width) => ({
    x: Number((centerX - width / 2).toFixed(6)),
    y: Number((centerY - keywordBoxHeight / 2).toFixed(6)),
    width,
    height: keywordBoxHeight,
    unit: "ratio",
  });
  const emphasisLineY = 1 / 6;
  const layouts = {
    1: [centeredBox(1 / 2, emphasisLineY, 0.36)],
    2: [centeredBox(1 / 3, emphasisLineY, 0.28), centeredBox(2 / 3, emphasisLineY, 0.28)],
    3: [
      centeredBox(1 / 4, emphasisLineY, 0.24),
      centeredBox(2 / 4, emphasisLineY, 0.24),
      centeredBox(3 / 4, emphasisLineY, 0.24),
    ],
    4: [
      centeredBox(1 / 3, emphasisLineY, 0.28),
      centeredBox(2 / 3, emphasisLineY, 0.28),
      centeredBox(1 / 3, emphasisLineY + keywordBoxHeight * 2, 0.28),
      centeredBox(2 / 3, emphasisLineY + keywordBoxHeight * 2, 0.28),
    ],
  };
  return layouts[itemCount] || [];
}

export function resolveTextGroupItems(asset, words, typeDef) {
  const layoutMode = (typeDef.capabilities || []).includes("layout.items") ? "items" : "flow";
  const layout = asset.props.layout === "custom" ? "custom" : "auto";
  const autoBoxes = layoutMode === "items" ? autoItemBoxes(asset.props.items.length) : [];
  const items = asset.props.items.map((item, itemIndex) => {
    const range = resolveWordRange(words, item.start_word_index, item.end_word_index, `条目 ${itemIndex + 1}`);
    const displayText = String(item.display_text ?? range.source_text)
      .replace(/[\r\n]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return {
      id: item.id || `${asset.id}.item.${String(itemIndex + 1).padStart(3, "0")}`,
      start_word_index: range.start_word_index,
      end_word_index: range.end_word_index,
      start: range.start,
      end: range.end,
      source_text: range.source_text,
      display_text: displayText,
      box: layoutMode === "items"
        ? (layout === "auto" ? autoBoxes[itemIndex] : normalizeBox(item.box || autoBoxes[itemIndex]))
        : null,
    };
  });
  const lifecycle = items.length
    ? { kind: "word_range", start: items[0].start, end: items.at(-1).end, start_word_index: items[0].start_word_index, end_word_index: items.at(-1).end_word_index }
    : { kind: "word_range", start: 0, end: 0 };
  return { layoutMode, layout, items, lifecycle };
}

function activeSpan(spans, time) {
  return (spans || []).find((span) => time >= span.start && time < span.end) || null;
}

function productAt(spans, time, resolver) {
  return (spans || []).reduce((value, span) => value * resolver(span, time), 1);
}

function assAlpha(opacity) {
  const alpha = Math.max(0, Math.min(255, Math.round((1 - opacity) * 255)));
  return `&H${alpha.toString(16).padStart(2, "0").toUpperCase()}&`;
}

function effectSegments(state, item, effects) {
  const applies = (entry) => !entry.item_id || entry.item_id === item.id;
  const relevant = [
    ...(effects.scale || []),
    ...(effects.opacity || []).filter(applies),
    ...(effects.textStyle || []).filter(applies),
    ...(effects.entryScale || []).filter((entry) => entry.target_kind === "asset" || entry.item_id === item.id),
    ...(effects.entryOpacity || []).filter((entry) => entry.target_kind === "asset" || entry.item_id === item.id),
  ];
  const boundaries = new Set([state.start, state.end]);
  for (const effect of relevant) {
    if (effect.end <= state.start || effect.start >= state.end) continue;
    boundaries.add(Math.max(state.start, effect.start));
    boundaries.add(Math.min(state.end, effect.end));
  }
  const sorted = [...boundaries].sort((left, right) => left - right);
  return sorted.slice(0, -1)
    .map((start, index) => ({ start, end: sorted[index + 1] }))
    .filter((segment) => segment.end - segment.start > 0.0005);
}

function visualStyleAt(effects, item, time) {
  const applies = (entry) => !entry.item_id || entry.item_id === item.id;
  const scaleSpans = [
    ...(effects.scale || []),
    ...(effects.entryScale || []).filter((entry) => entry.target_kind === "asset" || entry.item_id === item.id),
  ];
  const opacitySpans = [
    ...(effects.opacity || []).filter(applies),
    ...(effects.entryOpacity || []).filter((entry) => entry.target_kind === "asset" || entry.item_id === item.id),
  ];
  const textStyle = activeSpan((effects.textStyle || []).filter(applies), time);
  return {
    scale: productAt(scaleSpans, time, scaleAtTime),
    opacity: productAt(opacitySpans, time, opacityAtTime),
    fontScale: Number(textStyle?.font_scale || 1),
    color: textStyle?.color || null,
  };
}

export const textGroupRenderer = {
  id: "core.text-group",
  supportedChannels: [
    "visibility.items",
    "transform.scale",
    "style.opacity",
    "transform.scale.entry",
    "style.opacity.entry",
    "style.font-scale",
    "style.color",
  ],
  supportsSuppression: true,
  normalizeProps(asset, words, typeDef) {
    const resolved = resolveTextGroupItems(asset, words, typeDef);
    return {
      ...asset.props,
      ...(resolved.layoutMode === "items" ? { layout: resolved.layout } : {}),
      items: resolved.items.map((item) => ({
        id: item.id,
        start_word_index: item.start_word_index,
        end_word_index: item.end_word_index,
        display_text: item.display_text,
        ...(item.box ? { box: item.box } : {}),
      })),
    };
  },
  resolve({ asset, typeDef, words }) {
    const resolvedItems = resolveTextGroupItems(asset, words, typeDef);
    return {
      id: asset.id,
      type: asset.type,
      typeDef,
      enabled: asset.enabled !== false,
      layer: typeDef.default_layer ?? 400,
      capabilities: typeDef.capabilities || [],
      origin: asset.origin,
      source: asset.source,
      lifecycle: resolvedItems.lifecycle,
      props: asset.props,
      layoutMode: resolvedItems.layoutMode,
      layout: resolvedItems.layout,
      items: resolvedItems.items,
      styleSpans: [],
      channels: {
        "visibility.items": [],
        "transform.scale": [],
        "style.opacity": [],
        "transform.scale.entry": [],
        "style.opacity.entry": [],
        "style.font-scale": [],
        "style.color": [],
      },
    };
  },
  finalize(resolved, project, context = {}) {
    const minDimension = Math.min(project.displayWidth, project.displayHeight);
    const style = resolved.props.style;
    const fontSize = Math.max(12, Math.round(minDimension * style.font_size_ratio));
    const strokeWidth = Math.max(1, Math.round(minDimension * style.stroke_width_ratio));
    const itemGap = Math.round(project.displayHeight * (style.item_gap_ratio || 0));
    const lineHeight = Math.max(fontSize, Math.round(fontSize * 1.25));
    const isItems = resolved.layoutMode === "items";
    let fittedBox = resolved.props.box ? { ...resolved.props.box } : { x: 0, y: 0, width: 1, height: 1, unit: "ratio" };
    let items = resolved.items;
    if (isItems) {
      items = resolved.items.map((item) => {
        const requiredHeight = lineHeight;
        const fittedHeight = Math.min(1, requiredHeight / project.displayHeight);
        const centerY = item.box.y + item.box.height / 2;
        const fittedY = Math.max(0, Math.min(1 - fittedHeight, centerY - fittedHeight / 2));
        return {
          ...item,
          box: {
            ...item.box,
            y: Number(fittedY.toFixed(6)),
            height: Number(fittedHeight.toFixed(6)),
          },
          lines: [item.display_text],
          requiredHeight,
        };
      });
    } else {
      const boxWidth = project.displayWidth * fittedBox.width;
      const maxChars = Math.max(6, Math.floor(boxWidth / fontSize));
      items = resolved.items.map((item) => ({
        ...item,
        lines: splitCaptionLines(item.display_text, maxChars),
      }));
      const lineCount = items.reduce((total, item) => total + item.lines.length, 0);
      const requiredHeight = lineCount * lineHeight + Math.max(0, items.length - 1) * itemGap;
      const fittedHeight = Math.min(1, requiredHeight / project.displayHeight);
      fittedBox = {
        ...fittedBox,
        y: Number(Math.max(0, Math.min(1 - fittedHeight, fittedBox.y)).toFixed(6)),
        height: Number(fittedHeight.toFixed(6)),
      };
    }

    const visibility = resolved.channels["visibility.items"] || [];
    const popEntries = resolved.channels["transform.scale.entry"] || [];
    const hasPop = popEntries.length > 0;
    const effects = {
      scale: resolved.channels["transform.scale"] || [],
      opacity: resolved.channels["style.opacity"] || [],
      textStyle: resolved.styleSpans || [],
      entryScale: resolved.channels["transform.scale.entry"] || [],
      entryOpacity: resolved.channels["style.opacity.entry"] || [],
    };
    const baseStates = [];
    if (resolved.enabled) {
      if (visibility.length) {
        for (const slice of visibility) {
          const visibleItems = items.filter((item) => slice.visible_item_ids.includes(item.id));
          const entering = items.find((item) => item.id === slice.entering_item_id);
          const pop = popEntries.find((entry) => entry.item_id === slice.entering_item_id);
          baseStates.push({
            id: `${resolved.id}-state-${String(baseStates.length + 1).padStart(3, "0")}`,
            overlay_id: resolved.id,
            layout_mode: resolved.layoutMode,
            layout: resolved.layout,
            enter_animation: hasPop ? "pop" : "none",
            entering_item_id: slice.entering_item_id,
            animation_duration: pop?.duration || Math.max(0.001, Math.min(0.18, slice.end - (entering?.start ?? slice.start))),
            start: slice.start,
            end: slice.end,
            box: fittedBox,
            style,
            fontSize,
            strokeWidth,
            itemGap: isItems ? 0 : itemGap,
            lineHeight,
            items: visibleItems,
            effects,
          });
        }
      } else {
        baseStates.push({
          id: `${resolved.id}-state-001`,
          overlay_id: resolved.id,
          layout_mode: resolved.layoutMode,
          layout: resolved.layout,
          enter_animation: "none",
          entering_item_id: items[0]?.id || null,
          animation_duration: 0.18,
          start: resolved.lifecycle.start,
          end: resolved.lifecycle.end,
          box: fittedBox,
          style,
          fontSize,
          strokeWidth,
          itemGap: isItems ? 0 : itemGap,
          lineHeight,
          items,
          effects,
        });
      }
    }

    const states = baseStates.flatMap((state) => (
      subtractTimeRanges(state.start, state.end, context.suppressionRanges || []).map((interval, intervalIndex) => ({
        ...state,
        id: `${state.id}-visible-${String(intervalIndex + 1).padStart(3, "0")}`,
        start: interval.start,
        end: interval.end,
      }))
    ));

    const assEvents = states.flatMap((state) => {
      const events = [];
      const styleFontName = String(state.style.font_family).replace(/[,{}\\]/g, " ");
      const outline = assStrokeWidth(project, state.style.stroke_width_ratio);
      if (state.layout_mode === "items") {
        for (const item of state.items) {
          const centerX = Math.round(project.displayWidth * (item.box.x + item.box.width / 2));
          const centerY = Math.round(project.displayHeight * (item.box.y + item.box.height / 2));
          for (const segment of effectSegments(state, item, state.effects)) {
            const startStyle = visualStyleAt(state.effects, item, segment.start + 0.000001);
            const endStyle = visualStyleAt(state.effects, item, Math.max(segment.start, segment.end - 0.000001));
            const duration = Math.max(1, Math.round((segment.end - segment.start) * 1000));
            const startScale = Math.round(startStyle.scale * 100);
            const endScale = Math.round(endStyle.scale * 100);
            const tags = [
              "\\an5",
              `\\pos(${centerX},${centerY})`,
              `\\fn${styleFontName}`,
              `\\fs${Math.max(1, Math.round(state.fontSize * startStyle.fontScale))}`,
              `\\c${assColor(startStyle.color || state.style.color)}`,
              `\\3c${assColor(state.style.stroke_color)}`,
              `\\bord${outline}`,
              `\\fscx${startScale}\\fscy${startScale}`,
              `\\alpha${assAlpha(startStyle.opacity)}`,
              startScale !== endScale || Math.abs(startStyle.opacity - endStyle.opacity) > 0.001
                ? `\\t(0,${duration},\\fscx${endScale}\\fscy${endScale}\\alpha${assAlpha(endStyle.opacity)})`
                : "",
            ].join("");
            events.push({
              layer: 10,
              start: segment.start,
              end: segment.end,
              text: `{${tags}}${item.lines.map(escapeAssText).join("\\N")}`,
            });
          }
        }
        return events;
      }
      const leftX = Math.round(project.displayWidth * state.box.x);
      let topY = Math.round(project.displayHeight * state.box.y);
      for (const item of state.items) {
        for (const line of item.lines) {
          for (const segment of effectSegments(state, item, state.effects)) {
            const startStyle = visualStyleAt(state.effects, item, segment.start + 0.000001);
            const endStyle = visualStyleAt(state.effects, item, Math.max(segment.start, segment.end - 0.000001));
            const duration = Math.max(1, Math.round((segment.end - segment.start) * 1000));
            const startScale = Math.round(startStyle.scale * 100);
            const endScale = Math.round(endStyle.scale * 100);
            const tags = [
              "\\an7",
              `\\pos(${leftX},${topY})`,
              `\\fn${styleFontName}`,
              `\\fs${Math.max(1, Math.round(state.fontSize * startStyle.fontScale))}`,
              `\\c${assColor(startStyle.color || state.style.color)}`,
              `\\3c${assColor(state.style.stroke_color)}`,
              `\\bord${outline}`,
              `\\fscx${startScale}\\fscy${startScale}`,
              `\\alpha${assAlpha(startStyle.opacity)}`,
              startScale !== endScale || Math.abs(startStyle.opacity - endStyle.opacity) > 0.001
                ? `\\t(0,${duration},\\fscx${endScale}\\fscy${endScale}\\alpha${assAlpha(endStyle.opacity)})`
                : "",
            ].join("");
            events.push({
              layer: 10,
              start: segment.start,
              end: segment.end,
              text: `{${tags}}${escapeAssText(line)}`,
            });
          }
          topY += state.lineHeight;
        }
        topY += state.itemGap;
      }
      return events;
    });

    return {
      id: resolved.id,
      type: resolved.type,
      layer: resolved.layer,
      enabled: resolved.enabled,
      capabilities: resolved.capabilities,
      lifecycle: resolved.lifecycle,
      source: resolved.source,
      layout: { mode: resolved.layoutMode, layout: resolved.layout, box: fittedBox },
      style,
      content: { kind: "items", items },
      fontSize,
      strokeWidth,
      itemGap: isItems ? 0 : itemGap,
      lineHeight,
      requiredHeight: isItems ? items[0]?.requiredHeight : fittedBox.height * project.displayHeight,
      states,
      assEvents,
      group: {
        id: resolved.id,
        type: resolved.type,
        enabled: resolved.enabled,
        layout: resolved.layout,
        layout_mode: resolved.layoutMode,
        enter_animation: hasPop ? "pop" : "none",
        box: fittedBox,
        style,
        items,
        fontSize,
        strokeWidth,
        itemGap: isItems ? 0 : itemGap,
        lineHeight,
        requiredHeight: isItems
          ? undefined
          : items.reduce((total, item) => total + item.lines.length, 0) * lineHeight + Math.max(0, items.length - 1) * itemGap,
        source: resolved.origin.created_by === "human" ? "human" : "ai",
        human_modified: resolved.origin.human_modified,
        effects,
      },
    };
  },
};
