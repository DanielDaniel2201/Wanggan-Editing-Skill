import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  SKILL_ROOT,
  WangganError,
  deepClone,
  readJson,
  sha256Hex,
  writeJson,
} from "./core.mjs";
import { compileSchema } from "./schema.mjs";
import { createRegistry, setBuiltinRegistry } from "./registry.mjs";
import { registerBuiltinOperators } from "./operators/index.mjs";
import { registerBuiltinRenderers } from "./renderers/index.mjs";
import { registerBuiltinConstraintKinds } from "./constraints.mjs";

const PROFILE_MANIFEST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["schema_version", "id", "version"],
  properties: {
    schema_version: { const: 1 },
    id: { type: "string", minLength: 1 },
    version: { type: "string", minLength: 1 },
    extends: { type: "array", items: { type: "string" } },
    selection_rules: { type: "array", items: { type: "string" } },
    asset_types: { type: "array", items: { type: "string" } },
    effect_types: { type: "array", items: { type: "string" } },
    constraints: { type: "array", items: { type: "string" } },
    runtime_modules: { type: "array", items: { type: "string" } },
  },
};

const ASSET_TYPE_SCHEMA = {
  type: "object",
  additionalProperties: true,
  required: ["schema_version", "kind", "id", "renderer", "capabilities"],
  properties: {
    schema_version: { const: 1 },
    kind: { const: "asset_type" },
    id: { type: "string", minLength: 1 },
    renderer: { type: "string", minLength: 1 },
    source_kinds: { type: "array", items: { type: "string" } },
    capabilities: { type: "array", items: { type: "string" } },
    default_layer: { type: "integer" },
    system_instance: { type: "object" },
    defaults: { type: "object" },
    instance_schema: { type: "object" },
    ui: { type: "object" },
    override: { type: "boolean" },
  },
};

const EFFECT_TYPE_SCHEMA = {
  type: "object",
  additionalProperties: true,
  required: ["schema_version", "kind", "id", "operator", "requires_capabilities", "writes_channels"],
  properties: {
    schema_version: { const: 1 },
    kind: { const: "effect_type" },
    id: { type: "string", minLength: 1 },
    operator: { type: "string", minLength: 1 },
    requires_capabilities: { type: "array", items: { type: "string" } },
    timing_models: { type: "array", items: { type: "string" } },
    writes_channels: { type: "array", items: { type: "string" } },
    overlap_policy: { type: "string" },
    config_schema: { type: "object" },
    ui: { type: "object" },
    override: { type: "boolean" },
  },
};

const CONSTRAINTS_FILE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["schema_version", "constraints"],
  properties: {
    schema_version: { const: 1 },
    constraints: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "kind"],
        properties: {
          id: { type: "string", minLength: 1 },
          kind: { type: "string", minLength: 1 },
          override: { type: "boolean" },
          enabled: { type: "boolean" },
        },
        additionalProperties: true,
      },
    },
  },
};

const validateManifest = compileSchema(PROFILE_MANIFEST_SCHEMA, "profile.json");
const validateAssetType = compileSchema(ASSET_TYPE_SCHEMA, "asset_type");
const validateEffectType = compileSchema(EFFECT_TYPE_SCHEMA, "effect_type");
const validateConstraintsFile = compileSchema(CONSTRAINTS_FILE_SCHEMA, "constraints.json");

function assertValid(validator, value, label) {
  if (validator(value)) return value;
  throw new WangganError(`${label} 不符合 Schema`, { errors: validator.errors });
}

function resolveProfileDir(profileInput) {
  const requested = String(profileInput || "").trim();
  if (!requested) throw new WangganError("必须指定 Profile");
  if (fs.existsSync(requested) && fs.statSync(requested).isDirectory()) {
    return path.resolve(requested);
  }
  const packaged = path.join(SKILL_ROOT, "profiles", requested);
  if (fs.existsSync(packaged) && fs.statSync(packaged).isDirectory()) {
    return packaged;
  }
  throw new WangganError("找不到 Profile", { profile: requested, tried: [requested, packaged] });
}

function assertInside(rootDir, targetPath, label) {
  const root = path.resolve(rootDir);
  const resolved = path.resolve(rootDir, targetPath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new WangganError(`${label} 不得越出 Profile 目录`, { path: targetPath });
  }
  return resolved;
}

function readDefinition(rootDir, relativePath, label) {
  const absolute = assertInside(rootDir, relativePath, label);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    throw new WangganError(`找不到 ${label}`, { path: relativePath });
  }
  const bytes = fs.readFileSync(absolute);
  return {
    relativePath: relativePath.replaceAll("\\", "/"),
    absolutePath: absolute,
    digest: `sha256:${sha256Hex(bytes)}`,
    value: JSON.parse(bytes.toString("utf8")),
  };
}

function assertOwnedId(definition, profileId, label) {
  if (definition.override === true) return definition;
  if (!definition.id.startsWith(`${profileId}.`)) {
    throw new WangganError(`${label} id 必须使用声明它的 Profile namespace`, {
      id: definition.id,
      profileId,
    });
  }
  return definition;
}

function fileDigest(filePath) {
  return `sha256:${sha256Hex(fs.readFileSync(filePath))}`;
}

function mergeById(kind, parentItems, childItems, label) {
  const result = new Map(parentItems.map((item) => [item.id, item]));
  for (const item of childItems) {
    if (result.has(item.id) && item.override !== true) {
      throw new WangganError(`${label} 重复且未声明 override`, { id: item.id, kind });
    }
    result.set(item.id, item);
  }
  return [...result.values()];
}

function createRuntimeApi(registry) {
  return {
    registerAssetRenderer: (id, renderer) => registry.registerAssetRenderer(id, renderer),
    registerEffectOperator: (id, operator) => registry.registerEffectOperator(id, operator),
    registerConstraintKind: (id, evaluator) => registry.registerConstraintKind(id, evaluator),
  };
}

export function createCoreRegistry() {
  const registry = createRegistry();
  registerBuiltinRenderers(registry);
  registerBuiltinOperators(registry);
  registerBuiltinConstraintKinds(registry);
  setBuiltinRegistry(registry);
  return registry;
}

async function loadRuntimeModules(profileDir, relativePaths, registry) {
  for (const relativePath of relativePaths) {
    const absolute = assertInside(profileDir, relativePath, "runtime module");
    if (!fs.existsSync(absolute)) {
      throw new WangganError("找不到 runtime module", { path: relativePath });
    }
    const module = await import(`${pathToFileURL(absolute).href}?t=${Date.now()}`);
    const register = module.default;
    if (typeof register !== "function") {
      throw new WangganError("runtime module 必须默认导出 register(api)", { path: relativePath });
    }
    register(createRuntimeApi(registry));
  }
}

function loadOneProfile(profileDir, stack) {
  const manifestPath = path.join(profileDir, "profile.json");
  if (!fs.existsSync(manifestPath)) {
    throw new WangganError("Profile 缺少 profile.json", { profileDir });
  }
  const manifest = assertValid(validateManifest, readJson(manifestPath), "profile.json");
  if (stack.includes(manifest.id)) {
    throw new WangganError("Profile 存在循环继承", { cycle: [...stack, manifest.id] });
  }
  const files = [{
    relativePath: "profile.json",
    absolutePath: manifestPath,
    digest: fileDigest(manifestPath),
  }];

  const assetTypes = [];
  for (const relativePath of manifest.asset_types || []) {
    const file = readDefinition(profileDir, relativePath, "AssetType");
    files.push(file);
    assetTypes.push(assertOwnedId(
      assertValid(validateAssetType, file.value, file.relativePath),
      manifest.id,
      "AssetType",
    ));
  }
  const effectTypes = [];
  for (const relativePath of manifest.effect_types || []) {
    const file = readDefinition(profileDir, relativePath, "EffectType");
    files.push(file);
    effectTypes.push(assertOwnedId(
      assertValid(validateEffectType, file.value, file.relativePath),
      manifest.id,
      "EffectType",
    ));
  }
  const constraints = [];
  for (const relativePath of manifest.constraints || []) {
    const file = readDefinition(profileDir, relativePath, "Constraint");
    files.push(file);
    const document = assertValid(validateConstraintsFile, file.value, file.relativePath);
    constraints.push(...document.constraints.map((constraint) => (
      assertOwnedId(constraint, manifest.id, "Constraint")
    )));
  }
  const selectionRules = [];
  for (const relativePath of manifest.selection_rules || []) {
    const absolute = assertInside(profileDir, relativePath, "selection rules");
    if (!fs.existsSync(absolute)) {
      throw new WangganError("找不到选择规则 Markdown", { path: relativePath });
    }
    files.push({
      relativePath: relativePath.replaceAll("\\", "/"),
      absolutePath: absolute,
      digest: fileDigest(absolute),
    });
    selectionRules.push({
      path: relativePath.replaceAll("\\", "/"),
      text: fs.readFileSync(absolute, "utf8"),
    });
  }
  const runtimeModules = [];
  for (const relativePath of manifest.runtime_modules || []) {
    const absolute = assertInside(profileDir, relativePath, "runtime module");
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
      throw new WangganError("找不到 runtime module", { path: relativePath });
    }
    const file = {
      relativePath: relativePath.replaceAll("\\", "/"),
      absolutePath: absolute,
      digest: fileDigest(absolute),
    };
    files.push(file);
    runtimeModules.push(relativePath);
  }

  return {
    dir: profileDir,
    manifest,
    files,
    assetTypes,
    effectTypes,
    constraints,
    selectionRules,
    runtimeModules,
  };
}

function collectInheritance(profileInput, stack = []) {
  const profileDir = resolveProfileDir(profileInput);
  const current = loadOneProfile(profileDir, stack);
  const chain = [];
  for (const parent of current.manifest.extends || []) {
    chain.push(...collectInheritance(parent, [...stack, current.manifest.id]));
  }
  chain.push(current);
  return chain;
}

function assertNamespaced(id, profileId, label) {
  if (!id.includes(".")) {
    throw new WangganError(`${label} id 必须带 Profile namespace`, { id, profileId });
  }
}

export async function loadProfile(profileInput, options = {}) {
  const chain = collectInheritance(profileInput);
  const ids = chain.map((item) => item.manifest.id);
  if (new Set(ids).size !== ids.length) {
    throw new WangganError("Profile 继承链包含重复 id", { ids });
  }

  let assetTypes = [];
  let effectTypes = [];
  let constraints = [];
  const selectionRules = [];
  const files = [];
  const runtimeModuleRefs = [];
  for (const item of chain) {
    assetTypes = mergeById("asset_type", assetTypes, item.assetTypes, "AssetType");
    effectTypes = mergeById("effect_type", effectTypes, item.effectTypes, "EffectType");
    constraints = mergeById("constraint", constraints, item.constraints, "Constraint");
    selectionRules.push(...item.selectionRules);
    files.push(...item.files.map((file) => ({ ...file, profileId: item.manifest.id })));
    for (const relativePath of item.runtimeModules) {
      runtimeModuleRefs.push({ profileId: item.manifest.id, profileDir: item.dir, relativePath });
    }
  }

  const leaf = chain.at(-1);
  for (const assetType of assetTypes) assertNamespaced(assetType.id, leaf.manifest.id, "AssetType");
  for (const effectType of effectTypes) assertNamespaced(effectType.id, leaf.manifest.id, "EffectType");

  const hasNonBaseCode = runtimeModuleRefs.some((item) => item.profileId !== "base");
  if (options.loadRuntime !== false && hasNonBaseCode && !options.allowProfileCode) {
    throw new WangganError("非 Base Profile 包含 runtime module，需要显式 --allow-profile-code", {
      modules: runtimeModuleRefs.map((item) => item.relativePath),
    });
  }

  const registry = options.registry || createCoreRegistry();
  if (options.loadRuntime !== false) {
    for (const item of runtimeModuleRefs) {
      await loadRuntimeModules(
        item.profileDir,
        [item.relativePath],
        registry,
      );
    }
  }

  for (const assetType of assetTypes) {
    if (options.loadRuntime !== false && !registry.hasRenderer(assetType.renderer)) {
      throw new WangganError("AssetType 引用了未注册的 renderer", {
        assetType: assetType.id,
        renderer: assetType.renderer,
      });
    }
    assetType.instanceValidator = compileSchema(assetType.instance_schema || { type: "object" }, assetType.id);
  }
  for (const effectType of effectTypes) {
    if (options.loadRuntime !== false && !registry.hasOperator(effectType.operator)) {
      throw new WangganError("EffectType 引用了未注册的 operator", {
        effectType: effectType.id,
        operator: effectType.operator,
      });
    }
    if (options.loadRuntime !== false) {
      const operator = registry.getOperator(effectType.operator);
      const unsupportedWrites = (effectType.writes_channels || []).filter((channel) => (
        !(operator.writesChannels || []).includes(channel)
      ));
      if (unsupportedWrites.length) {
        throw new WangganError("EffectType 声明了 operator 不会写入的 channel", {
          effectType: effectType.id,
          operator: effectType.operator,
          unsupportedWrites,
        });
      }
      const unsupportedTiming = (effectType.timing_models || []).filter((model) => (
        !(operator.timingModels || []).includes(model)
      ));
      if (unsupportedTiming.length) {
        throw new WangganError("EffectType 声明了 operator 不支持的 timing model", {
          effectType: effectType.id,
          operator: effectType.operator,
          unsupportedTiming,
        });
      }
      const compatibleAssets = assetTypes.filter((assetType) => (
        (effectType.requires_capabilities || []).every((capability) => (
          (assetType.capabilities || []).includes(capability)
        ))
      ));
      if (!compatibleAssets.length) {
        throw new WangganError("EffectType 没有任何兼容 AssetType", { effectType: effectType.id });
      }
      for (const assetType of compatibleAssets) {
        const renderer = registry.getRenderer(assetType.renderer);
        const unsupportedChannels = (effectType.writes_channels || []).filter((channel) => (
          !(renderer.supportedChannels || []).includes(channel)
        ));
        if (unsupportedChannels.length) {
          throw new WangganError("Asset renderer 无法消费 EffectType channel", {
            effectType: effectType.id,
            assetType: assetType.id,
            renderer: assetType.renderer,
            unsupportedChannels,
          });
        }
      }
    }
    effectType.configValidator = compileSchema(effectType.config_schema || { type: "object" }, effectType.id);
  }
  for (const constraint of constraints) {
    if (constraint.enabled === false) continue;
    if (options.loadRuntime !== false && !registry.hasConstraintKind(constraint.kind)) {
      throw new WangganError("Constraint 引用了未注册的 kind", {
        constraint: constraint.id,
        kind: constraint.kind,
      });
    }
    if (options.loadRuntime !== false && constraint.kind === "suppress") {
      for (const target of constraint.targets || []) {
        const assetType = assetTypes.find((candidate) => candidate.id === target);
        if (!assetType) throw new WangganError("suppress target 不是已注册 AssetType", { constraint: constraint.id, target });
        const renderer = registry.getRenderer(assetType.renderer);
        if (!renderer.supportsSuppression) {
          throw new WangganError("suppress target renderer 不支持抑制", {
            constraint: constraint.id,
            target,
            renderer: assetType.renderer,
          });
        }
      }
    }
  }

  const allFiles = files;
  const digestSource = allFiles
    .map((file) => `${file.profileId || leaf.manifest.id}:${file.relativePath}:${file.digest}`)
    .sort()
    .join("\n");
  const digest = `sha256:${sha256Hex(digestSource)}`;

  return {
    id: leaf.manifest.id,
    version: leaf.manifest.version,
    dir: leaf.dir,
    extends: chain.slice(0, -1).map((item) => item.manifest.id),
    digest,
    files: allFiles,
    assetTypes: new Map(assetTypes.map((item) => [item.id, item])),
    effectTypes: new Map(effectTypes.map((item) => [item.id, item])),
    constraints: constraints.filter((item) => item.enabled !== false),
    allConstraints: constraints,
    selectionRules,
    registry,
    allowProfileCode: Boolean(options.allowProfileCode),
    hasRuntimeCode: runtimeModuleRefs.length > 0,
    catalog() {
      return profileCatalog(this);
    },
    lock() {
      return {
        schema_version: 1,
        id: this.id,
        version: this.version,
        digest: this.digest,
        extends: this.extends,
        files: this.files.map((file) => ({
          profileId: file.profileId || this.id,
          path: file.relativePath,
          digest: file.digest,
        })),
      };
    },
  };
}

export function profileCatalog(profile) {
  return {
    id: profile.id,
    version: profile.version,
    digest: profile.digest,
    extends: profile.extends,
    selection_rules: profile.selectionRules.map((item) => ({ path: item.path })),
    assetTypes: [...profile.assetTypes.values()].map((item) => ({
      id: item.id,
      capabilities: item.capabilities || [],
      default_layer: item.default_layer ?? 0,
      source_kinds: item.source_kinds || [],
      system_instance: item.system_instance ? { id: item.system_instance.id, type: item.id } : null,
      defaults: deepClone(item.defaults || {}),
      instance_schema: item.instance_schema || { type: "object" },
      supported_channels: profile.registry.getRenderer(item.renderer).supportedChannels || [],
      ui: item.ui || { label: item.id },
    })),
    effectTypes: [...profile.effectTypes.values()].map((item) => ({
      id: item.id,
      requires_capabilities: item.requires_capabilities || [],
      timing_models: item.timing_models || [],
      writes_channels: item.writes_channels || [],
      overlap_policy: item.overlap_policy || "exclusive-per-channel",
      config_schema: item.config_schema || { type: "object" },
      ui: item.ui || { label: item.id },
    })),
    constraints: profile.constraints.map((item) => ({
      id: item.id,
      kind: item.kind,
      enabled: item.enabled !== false,
    })),
    systemAssets: [...profile.assetTypes.values()]
      .filter((item) => item.system_instance?.id)
      .map((item) => ({ id: item.system_instance.id, type: item.id })),
  };
}

export function compareProfileLock(profile, lock) {
  if (!lock || typeof lock !== "object") {
    return { ok: false, changes: ["缺少 profile-lock.json"] };
  }
  const changes = [];
  if (lock.id !== profile.id) changes.push(`Profile id 从 ${lock.id} 变为 ${profile.id}`);
  if (lock.version !== profile.version) changes.push(`Profile 版本从 ${lock.version} 变为 ${profile.version}`);
  if (lock.digest !== profile.digest) changes.push("Profile digest 已变化");
  const previous = new Map((lock.files || []).map((file) => [`${file.profileId}:${file.path}`, file.digest]));
  const current = new Map(profile.files.map((file) => [`${file.profileId || profile.id}:${file.relativePath}`, file.digest]));
  for (const [key, digest] of current) {
    if (!previous.has(key)) changes.push(`新增定义文件 ${key}`);
    else if (previous.get(key) !== digest) changes.push(`定义文件已变化 ${key}`);
  }
  for (const key of previous.keys()) {
    if (!current.has(key)) changes.push(`定义文件已删除 ${key}`);
  }
  return { ok: changes.length === 0, changes };
}

export function writeProfileLock(lockPath, profile) {
  const lock = profile.lock();
  writeJson(lockPath, lock);
  return lock;
}

export function loadProfileLock(lockPath) {
  if (!fs.existsSync(lockPath)) return null;
  return readJson(lockPath);
}
