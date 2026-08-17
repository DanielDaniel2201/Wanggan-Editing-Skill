import fs from "node:fs";
import path from "node:path";
import { WangganError, deepClone, deepMerge, readJson, writeJson } from "./core.mjs";
import { assertSchema } from "./schema.mjs";
import { resolveWordRange, validateEffectTiming } from "./timeline.mjs";
import { evaluateConstraints, lifecycleRange } from "./constraints.mjs";
import { expandEffectInstance } from "./profile-loader.mjs";

const FONT_ALIASES = new Map([
  ["Noto Sans SC", "Microsoft YaHei"],
  ["Microsoft YaHei UI", "Microsoft YaHei"],
  ["STZhongsong", "华文中宋"],
]);

export function normalizeFontFamily(value) {
  const requested = String(value || "").trim();
  return FONT_ALIASES.get(requested) || requested;
}

function normalizeFontsIn(value) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => normalizeFontsIn(item));
  const result = { ...value };
  if (typeof result.font_family === "string") {
    result.font_family = normalizeFontFamily(result.font_family);
  }
  for (const [key, nested] of Object.entries(result)) {
    if (nested && typeof nested === "object") result[key] = normalizeFontsIn(nested);
  }
  return result;
}

function nextPrefixedId(prefix, existing) {
  let index = 1;
  const taken = new Set(existing);
  while (taken.has(`${prefix}.${String(index).padStart(3, "0")}`)) index += 1;
  return `${prefix}.${String(index).padStart(3, "0")}`;
}

export function nextAssetId(typeId, assets) {
  const local = String(typeId).split(".").at(-1) || "asset";
  return nextPrefixedId(local, assets.map((item) => item.id));
}

export function nextEffectId(effects) {
  return nextPrefixedId("effect", effects.map((item) => item.id));
}

export function nextItemId(assetId, items) {
  return nextPrefixedId(`${assetId}.item`, (items || []).map((item) => item.id).filter(Boolean));
}

export function createSystemAssets(profile) {
  const assets = [];
  for (const typeDef of profile.assetTypes.values()) {
    if (!typeDef.system_instance?.id) continue;
    assets.push(normalizeAsset({
      id: typeDef.system_instance.id,
      type: typeDef.id,
      enabled: typeDef.system_instance.enabled !== false,
      source: deepClone(typeDef.system_instance.source || { kind: "system" }),
      lifecycle: deepClone(typeDef.system_instance.lifecycle || { kind: "full" }),
      props: deepMerge(typeDef.defaults?.props || {}, typeDef.system_instance.props || {}),
      origin: { created_by: "system", human_modified: false },
    }, typeDef));
  }
  return assets;
}

export function emptyComposition(profile) {
  return {
    version: 1,
    profile: {
      id: profile.id,
      version: profile.version,
      digest: profile.digest,
    },
    assets: createSystemAssets(profile),
    effects: [],
  };
}

function normalizeOrigin(value, fallback = "agent") {
  const createdBy = value?.created_by || value?.source || fallback;
  const mapped = createdBy === "human" || createdBy === "system" || createdBy === "agent"
    ? createdBy
    : createdBy === "ai" ? "agent" : fallback;
  return {
    created_by: mapped,
    human_modified: Boolean(value?.human_modified),
  };
}

function normalizeAsset(asset, typeDef) {
  const defaults = typeDef.defaults || {};
  const props = normalizeFontsIn(deepMerge(defaults.props || {}, asset.props || {}));
  if (Array.isArray(props.items)) {
    props.items = props.items.map((item, index) => ({
      ...item,
      id: item.id || `${asset.id}.item.${String(index + 1).padStart(3, "0")}`,
    }));
  }
  if (props.style?.color) props.style.color = String(props.style.color).toUpperCase();
  return {
    id: String(asset.id || "").trim(),
    type: typeDef.id,
    enabled: asset.enabled === undefined ? defaults.enabled !== false : Boolean(asset.enabled),
    source: deepClone(asset.source || defaults.source || { kind: "agent-generated" }),
    lifecycle: deepClone(asset.lifecycle || defaults.lifecycle || { kind: "full" }),
    props,
    origin: normalizeOrigin(asset.origin, typeDef.system_instance ? "system" : "agent"),
  };
}

function normalizeEffect(effect) {
  return {
    id: String(effect.id || "").trim(),
    type: String(effect.type || "").trim(),
    target: {
      asset_id: String(effect.target?.asset_id || "").trim(),
    },
    timing: deepClone(effect.timing || {}),
    config: deepClone(effect.config || {}),
    origin: normalizeOrigin(effect.origin, "agent"),
  };
}

export function validateComposition(value, profile, words, project = null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WangganError("composition.json 必须是对象");
  }
  if (value.version !== 1) {
    throw new WangganError("composition.json 必须使用 v1 格式", { receivedVersion: value.version ?? null });
  }
  if (!Array.isArray(value.assets) || !Array.isArray(value.effects)) {
    throw new WangganError("composition.json 必须包含 assets 和 effects 数组");
  }

  const assets = [];
  const ids = new Set();
  for (const raw of value.assets) {
    const typeDef = profile.assetTypes.get(raw?.type);
    if (!typeDef) {
      throw new WangganError("未注册的 AssetType", { type: raw?.type ?? null });
    }
    const asset = normalizeAsset(raw, typeDef);
    if (!asset.id) throw new WangganError("Asset id 不能为空");
    if (ids.has(asset.id)) throw new WangganError("Asset id 重复", { id: asset.id });
    ids.add(asset.id);
    if (typeof profile.registry.getRenderer(typeDef.renderer).normalizeProps === "function") {
      asset.props = profile.registry.getRenderer(typeDef.renderer).normalizeProps(asset, words, typeDef);
    }
    assertSchema(typeDef.instanceValidator, asset.props, `Asset ${asset.id} props`);
    if (asset.lifecycle.kind === "word_range") {
      resolveWordRange(words, asset.lifecycle.start_word_index, asset.lifecycle.end_word_index, `Asset ${asset.id}`);
    }
    assets.push(asset);
  }

  const effects = [];
  const effectIds = new Set();
  for (const raw of value.effects) {
    const typeDef = profile.effectTypes.get(raw?.type);
    if (!typeDef) {
      throw new WangganError("未注册的 EffectType", { type: raw?.type ?? null });
    }
    const effect = normalizeEffect(raw);
    if (!effect.id) throw new WangganError("Effect id 不能为空");
    if (effectIds.has(effect.id)) throw new WangganError("Effect id 重复", { id: effect.id });
    effectIds.add(effect.id);
    if (!effect.target.asset_id) throw new WangganError("Effect 缺少 target.asset_id", { id: effect.id });
    if (!ids.has(effect.target.asset_id)) {
      throw new WangganError("Effect 目标不存在", { id: effect.id, target: effect.target.asset_id });
    }
    const targetAsset = assets.find((asset) => asset.id === effect.target.asset_id);
    validateEffectTiming(
      effect,
      typeDef,
      targetAsset,
      words,
      project?.inputs?.captions?.cues || [],
    );
    assertSchema(typeDef.configValidator, effect.config, `Effect ${effect.id} config`);
    expandEffectInstance(effect, profile);
    effects.push(effect);
  }

  const composition = {
    version: 1,
    profile: {
      id: profile.id,
      version: profile.version,
      digest: profile.digest,
    },
    assets,
    effects,
  };
  evaluateConstraints(profile, composition, { words, project });
  return composition;
}

export function loadComposition(compositionPath, profile, words, project = null) {
  if (!fs.existsSync(compositionPath)) {
    return emptyComposition(profile);
  }
  return validateComposition(readJson(compositionPath), profile, words, project);
}

export function saveComposition(compositionPath, value, profile, words, project = null) {
  const normalized = validateComposition(value, profile, words, project);
  writeJson(compositionPath, normalized);
  return normalized;
}

export function markHumanModified(origin) {
  return {
    created_by: origin?.created_by || "human",
    human_modified: true,
  };
}

export function applyAssetPatch(composition, assetId, patch) {
  const assets = composition.assets.map((asset) => {
    if (asset.id !== assetId) return asset;
    const next = {
      ...asset,
      ...patch,
      id: asset.id,
      type: asset.type,
      source: patch.source ? { ...asset.source, ...patch.source } : asset.source,
      lifecycle: patch.lifecycle ? { ...asset.lifecycle, ...patch.lifecycle } : asset.lifecycle,
      props: patch.props ? deepMerge(asset.props, patch.props) : asset.props,
      origin: markHumanModified(asset.origin),
    };
    if (patch.enabled !== undefined) next.enabled = Boolean(patch.enabled);
    return next;
  });
  if (!assets.some((asset) => asset.id === assetId)) {
    throw new WangganError("找不到 Asset", { id: assetId }, 404);
  }
  return { ...composition, assets };
}

export function replaceAsset(composition, nextAsset) {
  const exists = composition.assets.some((asset) => asset.id === nextAsset.id);
  return {
    ...composition,
    assets: exists
      ? composition.assets.map((asset) => asset.id === nextAsset.id ? nextAsset : asset)
      : [...composition.assets, nextAsset],
  };
}

export function removeAsset(composition, assetId) {
  const asset = composition.assets.find((item) => item.id === assetId);
  if (!asset) throw new WangganError("找不到 Asset", { id: assetId }, 404);
  if (asset.origin.created_by === "system") {
    throw new WangganError("不能删除系统 Asset", { id: assetId });
  }
  return {
    ...composition,
    assets: composition.assets.filter((item) => item.id !== assetId),
    effects: composition.effects.filter((effect) => effect.target.asset_id !== assetId),
  };
}

function configsEqual(left, right) {
  return JSON.stringify(left || {}) === JSON.stringify(right || {});
}

export function applyEffectRange(composition, change, words) {
  const start = Number(change.start_word_index);
  const end = Number(change.end_word_index);
  resolveWordRange(words, start, end, "选择范围");
  const targetId = change.target?.asset_id;
  if (!targetId) throw new WangganError("选择效果必须指定 target.asset_id");
  const nextEffects = [];
  let modifiesAgent = false;
  for (const effect of composition.effects) {
    const sameTarget = effect.target.asset_id === targetId;
    const sameType = !change.type || effect.type === change.type;
    const sameConfig = !change.config || configsEqual(effect.config, change.config);
    const timed = effect.timing?.kind === "word_range";
    const overlapsWords = timed
      && effect.timing.start_word_index <= end
      && effect.timing.end_word_index >= start;
    const shouldCut = sameTarget && overlapsWords && (
      change.clear_channels
      || (change.enabled && sameType)
      || (!change.enabled && sameType && sameConfig)
    );
    if (!shouldCut) {
      nextEffects.push(effect);
      continue;
    }
    if (effect.origin.created_by === "agent") modifiesAgent = true;
    if (effect.timing.start_word_index < start) {
      nextEffects.push({
        ...effect,
        id: `${effect.id}-pre`,
        timing: { ...effect.timing, end_word_index: start - 1 },
        origin: markHumanModified(effect.origin),
      });
    }
    if (effect.timing.end_word_index > end) {
      nextEffects.push({
        ...effect,
        id: `${effect.id}-post`,
        timing: { ...effect.timing, start_word_index: end + 1 },
        origin: markHumanModified(effect.origin),
      });
    }
  }
  if (change.enabled && change.type) {
    nextEffects.push({
      id: nextEffectId(nextEffects),
      type: change.type,
      target: { asset_id: targetId },
      timing: {
        kind: "word_range",
        start_word_index: start,
        end_word_index: end,
      },
      config: deepClone(change.config || {}),
      origin: {
        created_by: modifiesAgent ? "agent" : "human",
        human_modified: modifiesAgent,
      },
    });
  }
  const used = new Set();
  const unique = nextEffects.map((effect, index) => {
    let id = effect.id;
    if (!id || used.has(id) || /-(pre|post)$/.test(id)) {
      id = `effect.${String(index + 1).padStart(3, "0")}`;
      while (used.has(id)) {
        index += 1;
        id = `effect.${String(index + 1).padStart(3, "0")}`;
      }
    }
    used.add(id);
    return { ...effect, id };
  });
  return { ...composition, effects: unique };
}

export function importCompositionFragment(current, fragment, profile, words, project) {
  if (!fragment || typeof fragment !== "object") {
    throw new WangganError("导入文件必须是对象");
  }
  const systemAssets = current.assets.filter((asset) => asset.origin.created_by === "system");
  const incomingAssets = Array.isArray(fragment.assets) ? fragment.assets : [];
  const mergedSystem = systemAssets.map((asset) => {
    const incoming = incomingAssets.find((item) => item.id === asset.id);
    if (!incoming) return asset;
    return {
      ...asset,
      enabled: incoming.enabled === undefined ? asset.enabled : incoming.enabled,
      props: incoming.props ? deepMerge(asset.props, incoming.props) : asset.props,
      origin: incoming.origin?.human_modified ? markHumanModified(asset.origin) : asset.origin,
    };
  });
  const nonSystem = incomingAssets.filter((asset) => (
    !systemAssets.some((item) => item.id === asset.id)
  ));
  return validateComposition({
    version: 1,
    assets: [...mergedSystem, ...nonSystem],
    effects: Array.isArray(fragment.effects) ? fragment.effects : current.effects,
  }, profile, words, project);
}

export function deriveAssetLifecycle(asset, words) {
  if (asset.lifecycle?.kind === "word_range") {
    return resolveWordRange(words, asset.lifecycle.start_word_index, asset.lifecycle.end_word_index, `Asset ${asset.id}`);
  }
  if (asset.props?.items?.length) {
    const first = asset.props.items[0];
    const last = asset.props.items.at(-1);
    return resolveWordRange(words, first.start_word_index, last.end_word_index, `Asset ${asset.id}`);
  }
  return lifecycleRange(asset, words);
}

export function compositionPathFor(project) {
  return path.resolve(project.projectDir, project.compositionFile || "composition.json");
}
