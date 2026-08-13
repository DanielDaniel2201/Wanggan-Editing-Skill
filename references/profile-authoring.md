# 编写自定义 Profile

自定义 Profile 与 Base 走同一条加载、注册、校验、编译和导出路径。

## 只改选择风格

复制 Base 的 `selection-rules.md` 语气，新建 Profile：

```json
{
  "schema_version": 1,
  "id": "my-ip",
  "version": "1.0.0",
  "extends": ["base"],
  "selection_rules": ["selection-rules.md"]
}
```

不改 JSON 类型定义。Agent 只换“该不该做效果”的文案规则。

## 添加声明式 EffectType

在 `effect-types/` 写一个 JSON，使用已有 operator，例如 `core.style.opacity`。`extends: ["base"]` 后，审查页会按 capability 和 timing model 自动显示该效果，无需改 UI。Loader 会拒绝 operator 不会写入的 channel，或兼容 renderer 不会消费的 channel。

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
