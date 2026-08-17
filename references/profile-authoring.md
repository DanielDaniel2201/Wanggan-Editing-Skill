# 编写自定义 Profile

自定义 Profile 与 Foundation、Base 走同一条加载、注册、校验、编译和导出路径。Profile 声明可复用类型与规则；当前视频中的 Asset/Effect 实例始终属于 `composition.json`。

## 先选起点

- 自己定义创作判断：继承 `foundation`。它只提供 Primitive、原子 AssetType/EffectType、Renderer、Operator 和通用约束，不带选择立场。
- 在示例风格上微调：继承 `base`。Base 是一套可运行案例，不是行业标准。
- 需要冻结全部定义：完整复制只用于高级 `eject`/快照场景，不是默认定制方式。

## 只改选择风格

要完全使用自己的选择规则，新建 Profile：

```json
{
  "schema_version": 1,
  "id": "my-ip",
  "version": "1.0.0",
  "extends": ["foundation"],
  "selection_rules_mode": "replace",
  "selection_rules": ["selection-rules.md"]
}
```

不改 JSON 类型定义。Agent 只换“该不该做效果”的文案规则。若继承 `base`，也应在不想继承 Base 创作判断时写 `selection_rules_mode: "replace"`。

## 只改样式或默认参数

不要复制整个 AssetType。用 `patches` 只写想改的字段：

```json
{
  "schema_version": 1,
  "patches": [
    {
      "kind": "asset_type",
      "id": "base.list",
      "changes": {
        "defaults": {
          "props": {
            "container": {
              "background_color": "#FFFFFF",
              "background_opacity": 0.94,
              "border_radius_ratio": 0.012,
              "padding_ratio": 0.018
            },
            "style": { "color": "#111111" }
          }
        }
      }
    }
  ]
}
```

未列出的字体、布局、Schema、capability 与 UI 配置保持继承值。

注意：patch 中的对象递归合并，数组整体替换。若要改 `ui.default_effects`，必须写出完整数组，避免只保留入场动画却丢掉 `base.progressive-reveal`。

## 添加声明式 EffectType

在 `effect-types/` 写一个 JSON，声明 `uses_primitives` 并使用已有 operator，例如 `core.style.opacity`。`extends: ["base"]` 后，审查页会按 capability 和 timing model 自动显示该效果，无需改 UI。Loader 会拒绝未注册 Primitive、operator 不会写入的 channel，或兼容 renderer 不会消费的 channel。

Base 已用 Foundation 的 `base.translate-y-entry` 和 `base.opacity-entry` 原子 Effect 组合出 `base.item-enter`，使用时仍只写一个 Effect config：

```json
{
  "from_translate_y_ratio": 0.035,
  "to_translate_y_ratio": 0,
  "from_opacity": 0,
  "to_opacity": 1,
  "duration": 0.28,
  "delay": 0,
  "easing": "ease-out"
}
```

浏览器预览和 ASS 导出消费同一组 `transform.translate-y.entry` / `style.opacity.entry` channel；Renderer 不需要知道这是“知识博主 List”还是“商务观点卡”。继承 Foundation 而不继承 Base 的创作者 Profile，可以用 EffectType `composes` 声明自己的组合效果，格式见 [EffectType](effect-type-format.md)。

审查页新建 Asset 时会使用 `ui.default_effects`；Agent 通过 `import` 写 Composition 时不会自动补这些实例，所以 selection rules 必须明确要求创建 `base.progressive-reveal` 和 `base.item-enter`。

## 添加新 AssetType

声明 `renderer`、`capabilities`、`uses_primitives`、`instance_schema` 和可选 `ui.create_from_selection`。新 Asset 必须使用已注册 renderer，或通过 runtime module 注册新 renderer。新 AssetType 属于 Profile；Agent 为具体视频创建的 Asset 实例属于 Composition，不要混在类型定义中。

## 组合复杂 EffectType

已有 Primitive 足够时不要新写 Core Operator。让 Profile 的 EffectType 用 `composes` 引用多个原子 EffectType，并用 `config` / `config_from` 组织固定参数和父配置映射。`base.item-enter` 与 `base.pop` 都使用这条路径。

只有现有原子 Effect 的 Operator 无法表达目标 channel 时，才进入 runtime module 路径。不要把一个博主的完整成品动画晋升成 Foundation Primitive。

## 覆盖或关闭 Constraint

```json
{
  "id": "base.primary-overlay-exclusion",
  "override": true,
  "enabled": false,
  "kind": "exclusive-active-assets"
}
```

不要改 Core 来取消父约束。

## 使用可信 runtime module

当需要 Core 不认识的渲染机制时，在 `runtime_modules` 里放 `.mjs`，默认导出 `register(api)`：

```js
export default function register(api) {
  api.registerAssetRenderer("my-ip.sticker", {
    supportedAssetProps: [],
    supportedChannels: ["transform.rotate"],
    supportsSuppression: true,
    resolve(context) {},
    finalize(resolved, project, context) {}
  });
  api.registerEffectOperator("my-ip.wiggle", {
    writesChannels: ["transform.rotate"],
    timingModels: ["word_range"],
    apply(context) {}
  });
  api.registerConstraintKind("my-ip.safe-zone", evaluator);
}
```

Profile 代码与普通 Node 模块一样具有本机权限，只加载可信来源。Loader 会先在不执行代码的情况下计算 digest 并核对 Profile lock；之后仅在当前命令显式带 `--allow-profile-code` 时执行模块。授权不会写入工程，后续 `import`、`validate`、`serve`、`render` 和 `profile sync` 都必须重新显式授权。

发布 Profile 前至少验证：

1. 每个 `uses_primitives` 都已注册，且 Renderer/Operator 真正覆盖对应 prop/channel；Core 不硬编码 Primitive ID。
2. 每个声明兼容的 Asset×Effect 组合确实改变 Compiler IR。
3. 浏览器预览与 ASS/FFmpeg 导出都消费同一 channel 状态。
4. Profile lock 变化时不会先执行 runtime module。
5. 新 AssetType、原子 EffectType 和复合 EffectType 在未修改 Core/UI 的情况下可创建、保存、预览和导出。

## Agent 的定制意图路由

1. 只改“什么内容值得做效果” → selection rules。
2. 已有能力，只改品牌色、容器或动画参数 → Profile patch / Effect config。
3. 已有 Primitive，要新语义对象或复杂动画 → Profile AssetType / EffectType `composes`。
4. 缺少 Primitive、channel、operator 或 renderer → 用户 Profile 的可信 runtime module。
5. 浏览器和导出任一端不认识新 channel → 还不是闭环，必须补齐两端并加一致性测试。
6. 多个独立 Profile 反复实现同一能力 → 再提议把它版本化晋升到 Foundation；不要为单个用户偷偷改官方 Foundation。

## 复杂特效的实施顺序

Agent 收到“做一个复杂特效”时，按下面顺序工作，不要先写一块不可拆分的成品逻辑：

1. 先把自然语言拆成：目标 Asset、原子视觉变化、触发时机和持续时间。例如“观点卡从下方弹入”可拆成 card Asset、translate-y、opacity、scale 与 entry timing。
2. 检查当前 Profile 继承到的 Primitive、AssetType 和 EffectType。只是参数不同就写 patch/config；已有原子足够就写复合 EffectType。
3. 需要新的语义对象但绘制能力已存在时，在创作者 Profile 新建 AssetType。参考 `scripts/fixtures/profiles/test-ip/asset-types/card.json`。
4. 需要组合动画时，用 `composes` 连接原子 EffectType。参考 `profiles/base/effect-types/item-enter.json`；Composition 仍只保存一个复合 Effect 实例。
5. 只有缺少底层 prop/channel 时才新增带 namespace 的 Primitive，并让 AssetType/EffectType 用 `uses_primitives` 引用。参考 `profiles/foundation/primitives/`，不要把完整博主风格直接做成 Primitive。
6. 只有现有 Renderer/Operator 无法消费或写入该能力时才增加可信 runtime module。Renderer 必须声明真实的 `supportedAssetProps` / `supportedChannels`，Operator 必须声明真实的 `writesChannels` / `timingModels`。
7. 先验证 Profile 能加载、组合能进入 Compiler IR，再验证同一实例的浏览器预览和 ASS/FFmpeg 导出。任一端缺失都不算实现完成；最后更新并核对 Profile lock/version。

仓库级改动至少运行 `node scripts/profile-test.mjs`、`node scripts/foundation-test.mjs`、`node scripts/test.mjs` 和 `python quick_validate.py .`。涉及新 channel、Renderer 或 Operator 时，还必须增加针对该能力的 IR 测试与预览/导出一致性测试，不能只证明 JSON 通过 Schema。
