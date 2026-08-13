import fs from "node:fs";
import path from "node:path";
import { WangganError } from "./core.mjs";
import { rangesOverlap, resolveEffectTiming, resolveWordRange } from "./timeline.mjs";
import { boxInsideScreen } from "./ass.mjs";

function assetTypeOf(asset) {
  return asset.type;
}

function lifecycleRange(asset, words) {
  if (asset.lifecycle?.kind === "full") {
    return {
      start: words[0]?.start ?? 0,
      end: words.at(-1)?.end ?? 0,
      start_word_index: 0,
      end_word_index: Math.max(0, words.length - 1),
    };
  }
  if (asset.lifecycle?.kind === "word_range") {
    return resolveWordRange(words, asset.lifecycle.start_word_index, asset.lifecycle.end_word_index, `Asset ${asset.id}`);
  }
  if (asset.props?.items?.length) {
    const first = asset.props.items[0];
    const last = asset.props.items.at(-1);
    return resolveWordRange(words, first.start_word_index, last.end_word_index, `Asset ${asset.id} items`);
  }
  return null;
}

function evaluateCapabilityMatch(constraint, context) {
  const { composition, profile } = context;
  for (const effect of composition.effects) {
    const effectType = profile.effectTypes.get(effect.type);
    const asset = composition.assets.find((item) => item.id === effect.target.asset_id);
    if (!asset) {
      throw new WangganError("Effect 目标不存在", { effect: effect.id, target: effect.target });
    }
    const assetType = profile.assetTypes.get(asset.type);
    const missing = (effectType.requires_capabilities || []).filter((capability) => (
      !(assetType.capabilities || []).includes(capability)
    ));
    if (missing.length) {
      throw new WangganError("Effect 所需能力与目标 Asset 不匹配", {
        constraint: constraint.id,
        effect: effect.id,
        asset: asset.id,
        missing,
      });
    }
  }
}

function timingRange(effect, composition, words, project) {
  const asset = composition.assets.find((item) => item.id === effect.target.asset_id);
  const range = resolveEffectTiming(effect, asset, {
    words,
    captionCues: project?.inputs?.captions?.cues || [],
  });
  if (!range) {
    throw new WangganError("无法解析 Effect 时间", { effect: effect.id, timing: effect.timing });
  }
  return range;
}

function evaluateChannelConflict(constraint, context) {
  const { composition, profile, words, project } = context;
  const byKey = new Map();
  for (const effect of composition.effects) {
    const effectType = profile.effectTypes.get(effect.type);
    if ((effectType.overlap_policy || "exclusive-per-channel") !== "exclusive-per-channel") continue;
    const range = timingRange(effect, composition, words, project);
    for (const channel of effectType.writes_channels || []) {
      const key = `${effect.target.asset_id}::${channel}`;
      const list = byKey.get(key) || [];
      for (const previous of list) {
        if (rangesOverlap(previous.range, range)) {
          throw new WangganError("同一 Asset 的 exclusive 通道发生重叠", {
            constraint: constraint.id,
            channel,
            previous: previous.effect.id,
            current: effect.id,
            target: effect.target.asset_id,
          }, 409);
        }
      }
      list.push({ effect, range });
      byKey.set(key, list);
    }
  }
}

function evaluateExclusiveActiveAssets(constraint, context) {
  const types = new Set(constraint.asset_types || []);
  const enabled = context.composition.assets
    .filter((asset) => asset.enabled !== false && types.has(asset.type))
    .map((asset) => ({ asset, range: lifecycleRange(asset, context.words) }))
    .filter((item) => item.range)
    .sort((left, right) => left.range.start - right.range.start);
  for (let index = 1; index < enabled.length; index += 1) {
    if (rangesOverlap(enabled[index - 1].range, enabled[index].range)) {
      throw new WangganError("启用的覆盖层时间不能重叠", {
        constraint: constraint.id,
        previous: enabled[index - 1].asset.id,
        current: enabled[index].asset.id,
      }, 409);
    }
  }
}

function evaluateLayerOrder(constraint, context) {
  const rank = new Map();
  (constraint.order || []).forEach((entry, index) => {
    const types = Array.isArray(entry) ? entry : [entry];
    for (const type of types) rank.set(type, index);
  });
  for (const asset of context.composition.assets) {
    const assetType = context.profile.assetTypes.get(asset.type);
    const expected = rank.get(asset.type);
    if (expected === undefined) continue;
    const layer = assetType.default_layer ?? 0;
    for (const other of context.composition.assets) {
      if (other.id === asset.id) continue;
      const otherExpected = rank.get(other.type);
      if (otherExpected === undefined) continue;
      const otherLayer = context.profile.assetTypes.get(other.type).default_layer ?? 0;
      if (expected < otherExpected && layer > otherLayer) {
        throw new WangganError("图层顺序与约束不一致", {
          constraint: constraint.id,
          asset: asset.id,
          other: other.id,
        });
      }
    }
  }
}

function evaluateWordBoundaries(constraint, context) {
  const { composition, words } = context;
  for (const asset of composition.assets) {
    if (asset.lifecycle?.kind === "word_range") {
      resolveWordRange(words, asset.lifecycle.start_word_index, asset.lifecycle.end_word_index, `Asset ${asset.id}`);
    }
    for (const item of asset.props?.items || []) {
      resolveWordRange(words, item.start_word_index, item.end_word_index, `Asset ${asset.id} 条目`);
    }
  }
  for (const effect of composition.effects) {
    if (effect.timing.kind === "word_range") {
      resolveWordRange(words, effect.timing.start_word_index, effect.timing.end_word_index, `Effect ${effect.id}`);
    }
  }
}

function walkBoxes(value, visit) {
  if (!value || typeof value !== "object") return;
  if (["x", "y", "width", "height"].every((key) => Number.isFinite(Number(value[key])))) {
    visit(value);
  }
  if (Array.isArray(value)) {
    for (const item of value) walkBoxes(item, visit);
    return;
  }
  for (const nested of Object.values(value)) walkBoxes(nested, visit);
}

function evaluateScreenBounds(constraint, context) {
  for (const asset of context.composition.assets) {
    walkBoxes(asset.props, (box) => {
      if (!boxInsideScreen(box)) {
        throw new WangganError("比例 box 必须完整位于画面内", {
          constraint: constraint.id,
          asset: asset.id,
          box,
        });
      }
    });
  }
}

function characterCount(text) {
  return Array.from(String(text || "").replace(/\s/g, "")).length;
}

function evaluateAssetLimits(constraint, context) {
  const { composition, words, project } = context;
  for (const rule of constraint.rules || []) {
    for (const asset of composition.assets.filter((item) => item.type === rule.asset_type)) {
      const items = asset.props?.items || [];
      if (rule.max_items !== undefined && items.length > rule.max_items) {
        throw new WangganError("Asset 条目数量超过上限", {
          constraint: constraint.id,
          asset: asset.id,
          itemCount: items.length,
          max_items: rule.max_items,
        });
      }
      if (rule.item_text) {
        for (const item of items) {
          const range = resolveWordRange(words, item.start_word_index, item.end_word_index, "条目");
          const text = String(item.display_text ?? range.source_text).replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
          const count = characterCount(text);
          if (rule.item_text.min_chars !== undefined && count < rule.item_text.min_chars) {
            throw new WangganError("条目屏幕文案过短", { asset: asset.id, display_text: text, count });
          }
          if (rule.item_text.max_chars !== undefined && count > rule.item_text.max_chars) {
            throw new WangganError("条目屏幕文案过长", { asset: asset.id, display_text: text, count });
          }
        }
      }
      if (rule.items_ordered && items.length > 1) {
        const sorted = [...items].sort((left, right) => left.start_word_index - right.start_word_index);
        for (let index = 1; index < sorted.length; index += 1) {
          if (sorted[index].start_word_index <= sorted[index - 1].end_word_index) {
            throw new WangganError("条目必须按词序排列且不能重叠", {
              asset: asset.id,
              previous: sorted[index - 1],
              current: sorted[index],
            });
          }
        }
      }
      if (rule.extensions && asset.props?.image_path) {
        const imagePath = path.resolve(project?.projectDir || process.cwd(), asset.props.image_path);
        const extension = path.extname(imagePath).toLowerCase();
        if (!rule.extensions.includes(extension)) {
          throw new WangganError("贴图只支持 PNG、JPG、JPEG、WebP 或 BMP", {
            image_path: asset.props.image_path,
            extension,
          });
        }
        if (!fs.existsSync(imagePath) || !fs.statSync(imagePath).isFile()) {
          throw new WangganError(`找不到贴图文件：${imagePath}`);
        }
      }
    }
  }
}

const KIND_EVALUATORS = {
  "capability-match": evaluateCapabilityMatch,
  "exclusive-per-channel": evaluateChannelConflict,
  "exclusive-active-assets": evaluateExclusiveActiveAssets,
  suppress() {},
  "layer-order": evaluateLayerOrder,
  "word-boundaries": evaluateWordBoundaries,
  "screen-bounds": evaluateScreenBounds,
  "asset-limits": evaluateAssetLimits,
};

export function collectSuppressionRanges(profile, composition, words) {
  const ranges = [];
  for (const constraint of profile.constraints) {
    if (constraint.kind !== "suppress") continue;
    const sourceTypes = new Set(constraint.when?.asset_types || []);
    const phase = constraint.when?.phase || "item_active";
    for (const asset of composition.assets) {
      if (!asset.enabled || !sourceTypes.has(asset.type)) continue;
      const items = asset.props?.items || [];
      if (phase === "item_active") {
        for (const item of items) {
          const range = resolveWordRange(words, item.start_word_index, item.end_word_index, "抑制条目");
          ranges.push({
            start: range.start,
            end: range.end,
            asset_ids: [asset.id],
            overlay_ids: [asset.id],
            item_ids: [item.id || `${asset.id}:${item.start_word_index}`],
            targets: constraint.targets || [],
          });
        }
      } else {
        const range = lifecycleRange(asset, words);
        if (range) {
          ranges.push({
            start: range.start,
            end: range.end,
            asset_ids: [asset.id],
            overlay_ids: [asset.id],
            item_ids: [],
            targets: constraint.targets || [],
          });
        }
      }
    }
  }
  return ranges;
}

export function evaluateConstraints(profile, composition, context = {}) {
  const payload = { ...context, profile, composition };
  for (const constraint of profile.constraints) {
    const evaluator = profile.registry.getConstraintKind(constraint.kind);
    evaluator(constraint, payload);
  }
}

export function registerBuiltinConstraintKinds(registry) {
  for (const [kind, evaluator] of Object.entries(KIND_EVALUATORS)) {
    registry.registerConstraintKind(kind, evaluator);
  }
}

export { assetTypeOf, lifecycleRange };
