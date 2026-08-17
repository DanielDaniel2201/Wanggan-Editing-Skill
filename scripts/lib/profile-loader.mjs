import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  SKILL_ROOT,
  WangganError,
  deepClone,
  deepMerge,
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
    definition_namespace: { type: "string", minLength: 1 },
    extends: { type: "array", items: { type: "string" } },
    selection_rules: { type: "array", items: { type: "string" } },
    selection_rules_mode: { enum: ["append", "replace"] },
    primitives: { type: "array", items: { type: "string" } },
    asset_types: { type: "array", items: { type: "string" } },
    effect_types: { type: "array", items: { type: "string" } },
    constraints: { type: "array", items: { type: "string" } },
    patches: { type: "array", items: { type: "string" } },
    runtime_modules: { type: "array", items: { type: "string" } },
  },
};

const ASSET_TYPE_SCHEMA = {
  type: "object",
  additionalProperties: true,
  required: ["schema_version", "kind", "id", "renderer", "capabilities", "uses_primitives"],
  properties: {
    schema_version: { const: 1 },
    kind: { const: "asset_type" },
    id: { type: "string", minLength: 1 },
    renderer: { type: "string", minLength: 1 },
    source_kinds: { type: "array", items: { type: "string" } },
    capabilities: { type: "array", items: { type: "string" } },
    uses_primitives: { type: "array", items: { type: "string" } },
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
  required: ["schema_version", "kind", "id", "requires_capabilities", "writes_channels", "uses_primitives"],
  oneOf: [
    { required: ["operator"], not: { required: ["composes"] } },
    { required: ["composes"], not: { required: ["operator"] } },
  ],
  properties: {
    schema_version: { const: 1 },
    kind: { const: "effect_type" },
    id: { type: "string", minLength: 1 },
    operator: { type: "string", minLength: 1 },
    requires_capabilities: { type: "array", items: { type: "string" } },
    uses_primitives: { type: "array", items: { type: "string" } },
    timing_models: { type: "array", items: { type: "string" } },
    writes_channels: { type: "array", items: { type: "string" } },
    overlap_policy: { type: "string" },
    config_schema: { type: "object" },
    ui: { type: "object" },
    composes: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "effect_type"],
        properties: {
          id: { type: "string", minLength: 1 },
          effect_type: { type: "string", minLength: 1 },
          config: { type: "object" },
          config_from: {
            type: "object",
            additionalProperties: { type: "string", minLength: 1 },
          },
        },
      },
    },
    override: { type: "boolean" },
  },
};

const PRIMITIVES_FILE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["schema_version", "primitives"],
  properties: {
    schema_version: { const: 1 },
    primitives: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "category", "capability"],
        anyOf: [{ required: ["channels"] }, { required: ["asset_props"] }],
        properties: {
          id: { type: "string", minLength: 1 },
          category: {
            enum: ["transform", "visual-style", "typography", "layout", "timing", "visibility", "content"],
          },
          capability: { type: "string", minLength: 1 },
          channels: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
          asset_props: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
          description: { type: "string" },
          override: { type: "boolean" },
        },
      },
    },
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

const PATCHES_FILE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["schema_version", "patches"],
  properties: {
    schema_version: { const: 1 },
    patches: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "id", "changes"],
        properties: {
          kind: { enum: ["primitive", "asset_type", "effect_type", "constraint"] },
          id: { type: "string", minLength: 1 },
          changes: { type: "object" },
        },
      },
    },
  },
};

const validateManifest = compileSchema(PROFILE_MANIFEST_SCHEMA, "profile.json");
const validatePrimitivesFile = compileSchema(PRIMITIVES_FILE_SCHEMA, "primitives.json");
const validateAssetType = compileSchema(ASSET_TYPE_SCHEMA, "asset_type");
const validateEffectType = compileSchema(EFFECT_TYPE_SCHEMA, "effect_type");
const validateConstraintsFile = compileSchema(CONSTRAINTS_FILE_SCHEMA, "constraints.json");
const validatePatchesFile = compileSchema(PATCHES_FILE_SCHEMA, "patches.json");

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

function assertSafePatchValue(value, trail = []) {
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    if (["__proto__", "prototype", "constructor"].includes(key)) {
      throw new WangganError("definition patch 包含不安全字段", { path: [...trail, key] });
    }
    assertSafePatchValue(nested, [...trail, key]);
  }
}

function applyPatches(kind, items, patches, label, validator) {
  const result = new Map(items.map((item) => [item.id, item]));
  for (const patch of patches.filter((item) => item.kind === kind)) {
    const current = result.get(patch.id);
    if (!current) {
      throw new WangganError(`${label} patch 指向未注册定义`, { id: patch.id, kind });
    }
    const reserved = ["schema_version", "kind", "id", "override"]
      .filter((key) => Object.hasOwn(patch.changes, key));
    if (reserved.length) {
      throw new WangganError(`${label} patch 不得修改定义身份字段`, {
        id: patch.id,
        reserved,
      });
    }
    assertSafePatchValue(patch.changes);
    const merged = deepMerge(current, patch.changes);
    result.set(patch.id, assertValid(validator, merged, `${label} patch ${patch.id}`));
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

  const primitives = [];
  for (const relativePath of manifest.primitives || []) {
    const file = readDefinition(profileDir, relativePath, "Primitive");
    files.push(file);
    const document = assertValid(validatePrimitivesFile, file.value, file.relativePath);
    primitives.push(...document.primitives.map((primitive) => (
      assertOwnedId(primitive, manifest.definition_namespace || manifest.id, "Primitive")
    )));
  }
  const assetTypes = [];
  for (const relativePath of manifest.asset_types || []) {
    const file = readDefinition(profileDir, relativePath, "AssetType");
    files.push(file);
    assetTypes.push(assertOwnedId(
      assertValid(validateAssetType, file.value, file.relativePath),
      manifest.definition_namespace || manifest.id,
      "AssetType",
    ));
  }
  const effectTypes = [];
  for (const relativePath of manifest.effect_types || []) {
    const file = readDefinition(profileDir, relativePath, "EffectType");
    files.push(file);
    effectTypes.push(assertOwnedId(
      assertValid(validateEffectType, file.value, file.relativePath),
      manifest.definition_namespace || manifest.id,
      "EffectType",
    ));
  }
  const constraints = [];
  for (const relativePath of manifest.constraints || []) {
    const file = readDefinition(profileDir, relativePath, "Constraint");
    files.push(file);
    const document = assertValid(validateConstraintsFile, file.value, file.relativePath);
    constraints.push(...document.constraints.map((constraint) => (
      assertOwnedId(constraint, manifest.definition_namespace || manifest.id, "Constraint")
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
  const patches = [];
  for (const relativePath of manifest.patches || []) {
    const file = readDefinition(profileDir, relativePath, "definition patches");
    files.push(file);
    const document = assertValid(validatePatchesFile, file.value, file.relativePath);
    patches.push(...document.patches);
  }

  return {
    dir: profileDir,
    manifest,
    files,
    primitives,
    assetTypes,
    effectTypes,
    constraints,
    selectionRules,
    runtimeModules,
    patches,
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

  let primitives = [];
  let assetTypes = [];
  let effectTypes = [];
  let constraints = [];
  const selectionRules = [];
  const files = [];
  const runtimeModuleRefs = [];
  for (const item of chain) {
    primitives = mergeById("primitive", primitives, item.primitives, "Primitive");
    assetTypes = mergeById("asset_type", assetTypes, item.assetTypes, "AssetType");
    effectTypes = mergeById("effect_type", effectTypes, item.effectTypes, "EffectType");
    constraints = mergeById("constraint", constraints, item.constraints, "Constraint");
    primitives = applyPatches(
      "primitive",
      primitives,
      item.patches,
      "Primitive",
      (value) => validatePrimitivesFile({ schema_version: 1, primitives: [value] }),
    );
    assetTypes = applyPatches("asset_type", assetTypes, item.patches, "AssetType", validateAssetType);
    effectTypes = applyPatches("effect_type", effectTypes, item.patches, "EffectType", validateEffectType);
    constraints = applyPatches(
      "constraint",
      constraints,
      item.patches,
      "Constraint",
      (value) => validateConstraintsFile({ schema_version: 1, constraints: [value] }),
    );
    if (item.manifest.selection_rules_mode === "replace") selectionRules.length = 0;
    selectionRules.push(...item.selectionRules);
    files.push(...item.files.map((file) => ({ ...file, profileId: item.manifest.id })));
    for (const relativePath of item.runtimeModules) {
      runtimeModuleRefs.push({ profileId: item.manifest.id, profileDir: item.dir, relativePath });
    }
  }

  const leaf = chain.at(-1);
  for (const primitive of primitives) assertNamespaced(primitive.id, leaf.manifest.id, "Primitive");
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

  const primitiveById = new Map(primitives.map((item) => [item.id, item]));
  const requirePrimitives = (owner, label) => (owner.uses_primitives || []).map((id) => {
    const primitive = primitiveById.get(id);
    if (!primitive) throw new WangganError(`${label} 引用了未注册的 Primitive`, { id: owner.id, primitive: id });
    if (!(owner.capabilities || owner.requires_capabilities || []).includes(primitive.capability)) {
      throw new WangganError(`${label} 使用 Primitive 但未声明对应 capability`, {
        id: owner.id,
        primitive: id,
        capability: primitive.capability,
      });
    }
    return primitive;
  });
  const schemaSupportsPath = (schema, dottedPath) => {
    let current = schema;
    for (const key of String(dottedPath).split(".")) {
      if (current?.properties?.[key]) {
        current = current.properties[key];
        continue;
      }
      if (current?.additionalProperties === true || typeof current?.additionalProperties === "object") return true;
      return false;
    }
    return true;
  };

  for (const assetType of assetTypes) {
    if (options.loadRuntime !== false && !registry.hasRenderer(assetType.renderer)) {
      throw new WangganError("AssetType 引用了未注册的 renderer", {
        assetType: assetType.id,
        renderer: assetType.renderer,
      });
    }
    const usedPrimitives = requirePrimitives(assetType, "AssetType");
    const unsupportedProps = usedPrimitives.flatMap((primitive) => (
      (primitive.asset_props || [])
        .filter((propPath) => !schemaSupportsPath(assetType.instance_schema || {}, propPath))
        .map((propPath) => ({ primitive: primitive.id, propPath }))
    ));
    if (unsupportedProps.length) {
      throw new WangganError("AssetType 使用 Primitive 但 instance_schema 未声明对应属性", {
        assetType: assetType.id,
        unsupportedProps,
      });
    }
    if (options.loadRuntime !== false) {
      const renderer = registry.getRenderer(assetType.renderer);
      const unsupportedPrimitiveChannels = [...new Set(usedPrimitives.flatMap((item) => item.channels || []))]
        .filter((channel) => !(renderer.supportedChannels || []).includes(channel));
      const unsupportedPrimitiveProps = [...new Set(usedPrimitives.flatMap((item) => item.asset_props || []))]
        .filter((propPath) => !(renderer.supportedAssetProps || []).includes(propPath));
      if (unsupportedPrimitiveChannels.length || unsupportedPrimitiveProps.length) {
        throw new WangganError("Asset renderer 无法消费 Primitive contract", {
          assetType: assetType.id,
          renderer: assetType.renderer,
          unsupportedPrimitiveChannels,
          unsupportedPrimitiveProps,
        });
      }
    }
    assetType.instanceValidator = compileSchema(assetType.instance_schema || { type: "object" }, assetType.id);
  }
  for (const effectType of effectTypes) {
    const usedPrimitives = requirePrimitives(effectType, "EffectType");
    const primitiveChannels = new Set(usedPrimitives.flatMap((item) => item.channels || []));
    const undeclaredPrimitiveChannels = (effectType.writes_channels || []).filter((channel) => (
      !primitiveChannels.has(channel)
    ));
    if (undeclaredPrimitiveChannels.length) {
      throw new WangganError("EffectType 写入了未由 Primitive 声明的 channel", {
        effectType: effectType.id,
        undeclaredPrimitiveChannels,
      });
    }
    if (!effectType.composes && options.loadRuntime !== false && !registry.hasOperator(effectType.operator)) {
      throw new WangganError("EffectType 引用了未注册的 operator", {
        effectType: effectType.id,
        operator: effectType.operator,
      });
    }
    if (!effectType.composes && options.loadRuntime !== false) {
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

  const effectById = new Map(effectTypes.map((item) => [item.id, item]));
  const visitComposite = (effectType, stack = []) => {
    if (!effectType.composes) return;
    if (stack.includes(effectType.id)) {
      throw new WangganError("EffectType composes 存在循环引用", { cycle: [...stack, effectType.id] });
    }
    const stepIds = new Set();
    for (const step of effectType.composes) {
      if (stepIds.has(step.id)) throw new WangganError("EffectType composes step id 重复", { effectType: effectType.id, step: step.id });
      stepIds.add(step.id);
      const child = effectById.get(step.effect_type);
      if (!child) throw new WangganError("EffectType composes 引用了未注册 EffectType", { effectType: effectType.id, child: step.effect_type });
      const missingCapabilities = (child.requires_capabilities || []).filter((item) => !(effectType.requires_capabilities || []).includes(item));
      const missingChannels = (child.writes_channels || []).filter((item) => !(effectType.writes_channels || []).includes(item));
      const unsupportedTiming = (effectType.timing_models || []).filter((item) => !(child.timing_models || []).includes(item));
      if (missingCapabilities.length || missingChannels.length || unsupportedTiming.length) {
        throw new WangganError("复合 EffectType 未覆盖子 EffectType 契约", {
          effectType: effectType.id,
          child: child.id,
          missingCapabilities,
          missingChannels,
          unsupportedTiming,
        });
      }
      visitComposite(child, [...stack, effectType.id]);
    }
  };
  for (const effectType of effectTypes) visitComposite(effectType);
  if (options.loadRuntime !== false) {
    for (const effectType of effectTypes.filter((item) => item.composes)) {
      const compatibleAssets = assetTypes.filter((assetType) => (
        (effectType.requires_capabilities || []).every((capability) => (
          (assetType.capabilities || []).includes(capability)
        ))
      ));
      if (!compatibleAssets.length) {
        throw new WangganError("复合 EffectType 没有任何兼容 AssetType", { effectType: effectType.id });
      }
      for (const assetType of compatibleAssets) {
        const renderer = registry.getRenderer(assetType.renderer);
        const unsupportedChannels = (effectType.writes_channels || []).filter((channel) => (
          !(renderer.supportedChannels || []).includes(channel)
        ));
        if (unsupportedChannels.length) {
          throw new WangganError("Asset renderer 无法消费复合 EffectType channel", {
            effectType: effectType.id,
            assetType: assetType.id,
            renderer: assetType.renderer,
            unsupportedChannels,
          });
        }
      }
    }
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
    primitiveTypes: primitiveById,
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
    primitiveTypes: [...profile.primitiveTypes.values()].map((item) => ({
      id: item.id,
      category: item.category,
      capability: item.capability,
      channels: item.channels || [],
      asset_props: item.asset_props || [],
      description: item.description || "",
    })),
    assetTypes: [...profile.assetTypes.values()].map((item) => ({
      id: item.id,
      capabilities: item.capabilities || [],
      uses_primitives: item.uses_primitives || [],
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
      uses_primitives: item.uses_primitives || [],
      timing_models: item.timing_models || [],
      writes_channels: item.writes_channels || [],
      overlap_policy: item.overlap_policy || "exclusive-per-channel",
      config_schema: item.config_schema || { type: "object" },
      composes: deepClone(item.composes || []),
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

function readConfigPath(value, dottedPath) {
  return String(dottedPath).split(".").reduce((current, key) => current?.[key], value);
}

function writeConfigPath(target, dottedPath, value) {
  const parts = String(dottedPath).split(".");
  let current = target;
  for (const key of parts.slice(0, -1)) {
    if (["__proto__", "prototype", "constructor"].includes(key)) {
      throw new WangganError("composes config_from 包含不安全字段", { path: dottedPath });
    }
    if (!current[key] || typeof current[key] !== "object" || Array.isArray(current[key])) current[key] = {};
    current = current[key];
  }
  const finalKey = parts.at(-1);
  if (["__proto__", "prototype", "constructor"].includes(finalKey)) {
    throw new WangganError("composes config_from 包含不安全字段", { path: dottedPath });
  }
  current[finalKey] = deepClone(value);
}

export function expandEffectInstance(effect, profile, stack = []) {
  const typeDef = profile.effectTypes.get(effect.type);
  if (!typeDef) throw new WangganError("未注册的 EffectType", { type: effect.type });
  if (!typeDef.composes) return [effect];
  if (stack.includes(typeDef.id)) {
    throw new WangganError("EffectType composes 实例展开出现循环", { cycle: [...stack, typeDef.id] });
  }
  return typeDef.composes.flatMap((step) => {
    const childType = profile.effectTypes.get(step.effect_type);
    const childConfig = deepClone(step.config || {});
    for (const [childPath, parentPath] of Object.entries(step.config_from || {})) {
      const value = readConfigPath(effect.config || {}, parentPath);
      if (value !== undefined) writeConfigPath(childConfig, childPath, value);
    }
    if (!childType.configValidator(childConfig)) {
      throw new WangganError("复合 EffectType 子配置不符合 Schema", {
        effectType: typeDef.id,
        step: step.id,
        child: childType.id,
        errors: childType.configValidator.errors,
      });
    }
    return expandEffectInstance({
      ...effect,
      id: `${effect.id}.${step.id}`,
      type: childType.id,
      config: childConfig,
    }, profile, [...stack, typeDef.id]);
  });
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
