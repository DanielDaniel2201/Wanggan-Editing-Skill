# 编写自定义 Profile

自定义 Profile 与 Foundation、Base 走同一条加载、注册、校验、编译和导出路径。

## 先选起点

- 自己定义创作判断：继承 `foundation`。它只提供 Asset、Effect、Channel、Renderer、Operator 和通用约束，不带选择立场。
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

在 `effect-types/` 写一个 JSON，使用已有 operator，例如 `core.style.opacity`。`extends: ["base"]` 后，审查页会按 capability 和 timing model 自动显示该效果，无需改 UI。Loader 会拒绝 operator 不会写入的 channel，或兼容 renderer 不会消费的 channel。

Foundation 已提供 `base.item-enter`，可仅通过 config 组合条目上移淡入：

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

浏览器预览和 ASS 导出消费同一组 `transform.translate-y.entry` / `style.opacity.entry` channel；Renderer 不需要知道这是“知识博主 List”还是“商务观点卡”。

审查页新建 Asset 时会使用 `ui.default_effects`；Agent 通过 `import` 写 Composition 时不会自动补这些实例，所以 selection rules 必须明确要求创建 `base.progressive-reveal` 和 `base.item-enter`。

## 添加新 AssetType

声明 `renderer`、`capabilities`、`instance_schema` 和可选 `ui.create_from_selection`。新 Asset 必须使用已注册 renderer，或通过 runtime module 注册新 renderer。

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

1. 每个声明兼容的 Asset×Effect 组合确实改变 Compiler IR。
2. 浏览器预览与 ASS/FFmpeg 导出都消费同一 channel 状态。
3. Profile lock 变化时不会先执行 runtime module。
4. 新 Effect 在未修改 Core/UI 的情况下可创建、保存、预览和导出。

## Agent 的定制意图路由

1. 只改“什么内容值得做效果” → selection rules。
2. 已有能力，只改品牌色、容器或动画参数 → Profile patch / Effect config。
3. 缺少 channel、operator 或 renderer → 用户 Profile 的可信 runtime module。
4. 浏览器和导出任一端不认识新 channel → 还不是闭环，必须补齐两端并加一致性测试。
5. 多个独立 Profile 反复实现同一能力 → 再提议把它版本化晋升到 Foundation；不要为单个用户偷偷改官方 Foundation。
