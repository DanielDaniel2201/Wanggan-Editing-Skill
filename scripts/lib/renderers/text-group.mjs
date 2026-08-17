import { resolveWordRange, subtractTimeRanges } from "../timeline.mjs";
import { splitCaptionLines } from "../text-layout.mjs";
import {
  assColor,
  assStrokeWidth,
  escapeAssText,
  normalizeBox,
  opacityAtTime,
  scaleAtTime,
  translateYAtTime,
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

function sumAt(spans, time, resolver) {
  return (spans || []).reduce((value, span) => value + resolver(span, time), 0);
}

function assAlpha(opacity) {
  const alpha = Math.max(0, Math.min(255, Math.round((1 - opacity) * 255)));
  return `&H${alpha.toString(16).padStart(2, "0").toUpperCase()}&`;
}

function roundedRectPath(left, top, right, bottom, requestedRadius) {
  const width = Math.max(0, right - left);
  const height = Math.max(0, bottom - top);
  const radius = Math.max(0, Math.min(requestedRadius, width / 2, height / 2));
  if (radius < 1) return `m ${left} ${top} l ${right} ${top} ${right} ${bottom} ${left} ${bottom}`;
  const control = radius * 0.55228475;
  const n = (value) => Math.round(value);
  return [
    `m ${n(left + radius)} ${n(top)}`,
    `l ${n(right - radius)} ${n(top)}`,
    `b ${n(right - radius + control)} ${n(top)} ${n(right)} ${n(top + radius - control)} ${n(right)} ${n(top + radius)}`,
    `l ${n(right)} ${n(bottom - radius)}`,
    `b ${n(right)} ${n(bottom - radius + control)} ${n(right - radius + control)} ${n(bottom)} ${n(right - radius)} ${n(bottom)}`,
    `l ${n(left + radius)} ${n(bottom)}`,
    `b ${n(left + radius - control)} ${n(bottom)} ${n(left)} ${n(bottom - radius + control)} ${n(left)} ${n(bottom - radius)}`,
    `l ${n(left)} ${n(top + radius)}`,
    `b ${n(left)} ${n(top + radius - control)} ${n(left + radius - control)} ${n(top)} ${n(left + radius)} ${n(top)}`,
  ].join(" ");
}

function effectSegments(state, item, effects) {
  const applies = (entry) => !entry.item_id || entry.item_id === item.id;
  const relevant = [
    ...(effects.scale || []),
    ...(effects.opacity || []).filter(applies),
    ...(effects.textStyle || []).filter(applies),
    ...(effects.entryScale || []).filter((entry) => entry.target_kind === "asset" || entry.item_id === item.id),
    ...(effects.entryOpacity || []).filter((entry) => entry.target_kind === "asset" || entry.item_id === item.id),
    ...(effects.entryTranslateY || []).filter((entry) => entry.target_kind === "asset" || entry.item_id === item.id),
  ];
  const boundaries = new Set([state.start, state.end]);
  for (const effect of relevant) {
    if (effect.end <= state.start || effect.start >= state.end) continue;
    boundaries.add(Math.max(state.start, effect.start));
    boundaries.add(Math.min(state.end, effect.end));
    if (["ease-in", "ease-out", "ease-in-out"].includes(effect.easing)) {
      for (let step = 1; step < 8; step += 1) {
        const boundary = effect.start + ((effect.end - effect.start) * step) / 8;
        if (boundary > state.start && boundary < state.end) boundaries.add(boundary);
      }
    }
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
  const translateYSpans = (effects.entryTranslateY || [])
    .filter((entry) => entry.target_kind === "asset" || entry.item_id === item.id);
  const textStyle = activeSpan((effects.textStyle || []).filter(applies), time);
  return {
    scale: productAt(scaleSpans, time, scaleAtTime),
    opacity: productAt(opacitySpans, time, opacityAtTime),
    translateYRatio: sumAt(translateYSpans, time, translateYAtTime),
    fontScale: Number(textStyle?.font_scale || 1),
    color: textStyle?.color || null,
  };
}

export const textGroupRenderer = {
  id: "core.text-group",
  supportedAssetProps: [
    "box",
    "layout",
    "items",
    "style.font_family",
    "style.font_size_ratio",
    "style.color",
    "style.stroke_color",
    "style.stroke_width_ratio",
    "style.item_gap_ratio",
    "container.background_color",
    "container.background_opacity",
    "container.border_color",
    "container.border_opacity",
    "container.border_width_ratio",
    "container.border_radius_ratio",
    "container.padding_ratio",
  ],
  supportedChannels: [
    "visibility.items",
    "transform.scale",
    "style.opacity",
    "transform.scale.entry",
    "style.opacity.entry",
    "transform.translate-y.entry",
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
        "transform.translate-y.entry": [],
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
    const container = {
      background_color: "#000000",
      background_opacity: 0,
      border_color: "#000000",
      border_opacity: 0,
      border_width_ratio: 0,
      border_radius_ratio: 0,
      padding_ratio: 0,
      ...(resolved.props.container || {}),
    };
    const containerPadding = Math.max(0, Math.round(minDimension * Number(container.padding_ratio || 0)));
    const containerBorderWidth = Math.max(0, Math.round(minDimension * Number(container.border_width_ratio || 0)));
    const containerRadius = Math.max(0, Math.round(minDimension * Number(container.border_radius_ratio || 0)));
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
      const boxWidth = Math.max(1, project.displayWidth * fittedBox.width - containerPadding * 2);
      const maxChars = Math.max(6, Math.floor(boxWidth / fontSize));
      items = resolved.items.map((item) => ({
        ...item,
        lines: splitCaptionLines(item.display_text, maxChars),
      }));
      const lineCount = items.reduce((total, item) => total + item.lines.length, 0);
      const requiredHeight = lineCount * lineHeight
        + Math.max(0, items.length - 1) * itemGap
        + containerPadding * 2;
      const fittedHeight = Math.min(1, requiredHeight / project.displayHeight);
      fittedBox = {
        ...fittedBox,
        y: Number(Math.max(0, Math.min(1 - fittedHeight, fittedBox.y)).toFixed(6)),
        height: Number(fittedHeight.toFixed(6)),
      };
    }

    const visibility = resolved.channels["visibility.items"] || [];
    const popEntries = resolved.channels["transform.scale.entry"] || [];
    const translateEntries = resolved.channels["transform.translate-y.entry"] || [];
    const hasPop = popEntries.length > 0;
    const hasTranslateEntry = translateEntries.length > 0;
    const enterAnimation = hasPop ? "pop" : hasTranslateEntry ? "translate-opacity" : "none";
    const effects = {
      scale: resolved.channels["transform.scale"] || [],
      opacity: resolved.channels["style.opacity"] || [],
      textStyle: resolved.styleSpans || [],
      entryScale: resolved.channels["transform.scale.entry"] || [],
      entryOpacity: resolved.channels["style.opacity.entry"] || [],
      entryTranslateY: resolved.channels["transform.translate-y.entry"] || [],
    };
    const baseStates = [];
    if (resolved.enabled) {
      if (visibility.length) {
        for (const slice of visibility) {
          const visibleItems = items.filter((item) => slice.visible_item_ids.includes(item.id));
          const entering = items.find((item) => item.id === slice.entering_item_id);
          const pop = popEntries.find((entry) => entry.item_id === slice.entering_item_id);
          const translate = translateEntries.find((entry) => entry.item_id === slice.entering_item_id);
          baseStates.push({
            id: `${resolved.id}-state-${String(baseStates.length + 1).padStart(3, "0")}`,
            overlay_id: resolved.id,
            layout_mode: resolved.layoutMode,
            layout: resolved.layout,
            enter_animation: enterAnimation,
            entering_item_id: slice.entering_item_id,
            animation_duration: pop?.duration
              || translate?.duration
              || Math.max(0.001, Math.min(0.18, slice.end - (entering?.start ?? slice.start))),
            start: slice.start,
            end: slice.end,
            box: fittedBox,
            style,
            fontSize,
            strokeWidth,
            itemGap: isItems ? 0 : itemGap,
            lineHeight,
            container,
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
          container,
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
      if (
        state.layout_mode === "flow"
        && (Number(state.container.background_opacity) > 0 || containerBorderWidth > 0)
      ) {
        const left = Math.round(project.displayWidth * state.box.x);
        const top = Math.round(project.displayHeight * state.box.y);
        const right = Math.round(project.displayWidth * (state.box.x + state.box.width));
        const bottom = Math.round(project.displayHeight * (state.box.y + state.box.height));
        const shape = roundedRectPath(left, top, right, bottom, containerRadius);
        const tags = [
          "\\an7",
          "\\pos(0,0)",
          "\\p1",
          `\\c${assColor(state.container.background_color)}`,
          `\\1a${assAlpha(state.container.background_opacity)}`,
          `\\3c${assColor(state.container.border_color)}`,
          `\\3a${assAlpha(state.container.border_opacity)}`,
          `\\bord${containerBorderWidth}`,
          "\\shad0",
        ].join("");
        events.push({
          layer: 9,
          start: state.start,
          end: state.end,
          text: `{${tags}}${shape}{\\p0}`,
        });
      }
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
            const startY = Math.round(centerY + project.displayHeight * startStyle.translateYRatio);
            const endY = Math.round(centerY + project.displayHeight * endStyle.translateYRatio);
            const tags = [
              "\\an5",
              startY !== endY
                ? `\\move(${centerX},${startY},${centerX},${endY},0,${duration})`
                : `\\pos(${centerX},${startY})`,
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
      const leftX = Math.round(project.displayWidth * state.box.x) + containerPadding;
      let topY = Math.round(project.displayHeight * state.box.y) + containerPadding;
      for (const item of state.items) {
        for (const line of item.lines) {
          for (const segment of effectSegments(state, item, state.effects)) {
            const startStyle = visualStyleAt(state.effects, item, segment.start + 0.000001);
            const endStyle = visualStyleAt(state.effects, item, Math.max(segment.start, segment.end - 0.000001));
            const duration = Math.max(1, Math.round((segment.end - segment.start) * 1000));
            const startScale = Math.round(startStyle.scale * 100);
            const endScale = Math.round(endStyle.scale * 100);
            const startY = Math.round(topY + project.displayHeight * startStyle.translateYRatio);
            const endY = Math.round(topY + project.displayHeight * endStyle.translateYRatio);
            const tags = [
              "\\an7",
              startY !== endY
                ? `\\move(${leftX},${startY},${leftX},${endY},0,${duration})`
                : `\\pos(${leftX},${startY})`,
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
      container,
      requiredHeight: isItems ? items[0]?.requiredHeight : fittedBox.height * project.displayHeight,
      states,
      assEvents,
      group: {
        id: resolved.id,
        type: resolved.type,
        enabled: resolved.enabled,
        layout: resolved.layout,
        layout_mode: resolved.layoutMode,
        enter_animation: enterAnimation,
        box: fittedBox,
        style,
        items,
        fontSize,
        strokeWidth,
        itemGap: isItems ? 0 : itemGap,
        lineHeight,
        container,
        requiredHeight: isItems
          ? undefined
          : items.reduce((total, item) => total + item.lines.length, 0) * lineHeight
            + Math.max(0, items.length - 1) * itemGap
            + containerPadding * 2,
        source: resolved.origin.created_by === "human" ? "human" : "ai",
        human_modified: resolved.origin.human_modified,
        effects,
      },
    };
  },
};
