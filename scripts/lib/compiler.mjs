import fs from "node:fs";
import path from "node:path";
import { COMPILER_VERSION } from "./core.mjs";
import { loadComposition } from "./composition.mjs";
import { collectSuppressionRanges } from "./constraints.mjs";
import { mergedTimeRanges, resolveEffectTiming } from "./timeline.mjs";
import { buildAssDocument } from "./ass.mjs";
import { loadProjectContext } from "./project.mjs";
import { expandEffectInstance } from "./profile-loader.mjs";

const PHASE_ORDER = ["visibility", "layout", "transform", "style", "entry", "composite"];

function sortEffects(effects, profile) {
  return [...effects].sort((left, right) => {
    const leftType = profile.effectTypes.get(left.type);
    const rightType = profile.effectTypes.get(right.type);
    const leftOp = profile.registry.getOperator(leftType.operator);
    const rightOp = profile.registry.getOperator(rightType.operator);
    const leftPhase = PHASE_ORDER.indexOf(leftOp.phase || "style");
    const rightPhase = PHASE_ORDER.indexOf(rightOp.phase || "style");
    if (leftPhase !== rightPhase) return leftPhase - rightPhase;
    const leftPriority = leftOp.priority || 100;
    const rightPriority = rightOp.priority || 100;
    if (leftPriority !== rightPriority) return leftPriority - rightPriority;
    return left.id.localeCompare(right.id);
  });
}

export async function compileProject(projectInput, options = {}) {
  const context = options.context || await loadProjectContext(projectInput, options);
  const { project, profile, words, captionCues, lockStatus } = context;
  const composition = options.composition || loadComposition(
    project.compositionPath,
    profile,
    words,
    project,
  );

  const resolvedAssets = composition.assets.map((asset) => {
    const typeDef = profile.assetTypes.get(asset.type);
    const renderer = profile.registry.getRenderer(typeDef.renderer);
    return renderer.resolve({ asset, typeDef, words, project, composition });
  });
  const resolvedById = new Map(resolvedAssets.map((asset) => [asset.id, asset]));

  const executableEffects = composition.effects.flatMap((effect) => expandEffectInstance(effect, profile));
  for (const effect of sortEffects(executableEffects, profile)) {
    const typeDef = profile.effectTypes.get(effect.type);
    const operator = profile.registry.getOperator(typeDef.operator);
    const target = resolvedById.get(effect.target.asset_id);
    const timing = resolveEffectTiming(effect, target, { words, captionCues });
    operator.apply({
      effect,
      typeDef,
      target,
      timing,
      assets: resolvedById,
      words,
      composition,
      project,
    });
  }

  const suppressionRanges = mergedTimeRanges(collectSuppressionRanges(profile, composition, words));
  const finalized = resolvedAssets.map((resolved) => {
    const renderer = profile.registry.getRenderer(resolved.typeDef.renderer);
    const assetSuppressionRanges = suppressionRanges.filter((range) => (
      !(range.targets || []).length
      || range.targets.includes(resolved.id)
      || range.targets.includes(resolved.type)
    ));
    return renderer.finalize(resolved, project, {
      words,
      captionCues,
      suppressionRanges: assetSuppressionRanges,
      composition,
    });
  });

  const playbackEffects = finalized.flatMap((asset) => asset.playbackEffects || []);
  const captionsAsset = finalized.find((asset) => asset.content?.kind === "cues");
  const structuredAssets = finalized.filter((asset) => asset.content?.kind === "items");
  const imageAssets = finalized.filter((asset) => asset.content?.kind === "image");
  const playbackCaptions = captionsAsset?.enabled ? captionsAsset.playbackCaptions || [] : [];
  const playbackOverlays = structuredAssets.flatMap((asset) => asset.states || []);
  const playbackImageOverlays = imageAssets.map((asset) => asset.playbackImage).filter(Boolean);

  const assEvents = finalized
    .filter((asset) => asset.enabled)
    .sort((left, right) => left.layer - right.layer)
    .flatMap((asset) => asset.assEvents || []);
  const defaultStyle = {
    font_family: captionsAsset?.style?.font_family || "Microsoft YaHei",
    fontSize: captionsAsset?.fontSize || 24,
    color: captionsAsset?.style?.color || "#FFFFFF",
    stroke_color: captionsAsset?.style?.stroke_color || "#000000",
    stroke_width_ratio: captionsAsset?.style?.stroke_width_ratio || 0.0055,
    alignment: 2,
  };
  const hasText = assEvents.length > 0;
  const assText = hasText ? buildAssDocument(project, defaultStyle, assEvents) : "";

  const playbackScene = {
    canvas: {
      width: project.displayWidth,
      height: project.displayHeight,
      duration: project.duration,
    },
    assets: finalized.map((asset) => ({
      id: asset.id,
      type: asset.type,
      layer: asset.layer,
      enabled: asset.enabled,
      capabilities: asset.capabilities,
      lifecycle: asset.lifecycle,
      layout: asset.layout,
      style: asset.style,
      content: asset.content,
      states: asset.states,
      source: asset.source,
    })),
  };

  return {
    compilerVersion: COMPILER_VERSION,
    profile: {
      id: profile.id,
      version: profile.version,
      digest: profile.digest,
    },
    profileLock: lockStatus,
    project,
    words,
    composition,
    catalog: profile.catalog(),
    playbackScene,
    playbackEffects,
    playbackCaptions,
    playbackOverlays,
    playbackImageOverlays,
    suppressionRanges,
    captionTrack: captionsAsset?.captionTrack || {
      enabled: false,
      source: "srt",
      sourcePath: project.subtitlePath,
      cueCount: captionCues.length,
      effectCount: 0,
      playbackCueCount: 0,
    },
    structuredOverlayTrack: {
      enabled: structuredAssets.some((asset) => asset.enabled),
      groupCount: structuredAssets.length,
      groups: structuredAssets.map((asset) => asset.group),
      suppressionRanges,
    },
    imageOverlayTrack: {
      enabled: playbackImageOverlays.length > 0,
      groupCount: imageAssets.length,
      groups: imageAssets.map((asset) => asset.group),
    },
    assText,
    hasAss: hasText,
    diagnostics: [],
  };
}

export function writeOverlayAss(project, ir, fileName = "render-overlays.ass") {
  const filePath = path.join(project.projectDir, fileName);
  fs.writeFileSync(filePath, ir.assText, "utf8");
  return filePath;
}
