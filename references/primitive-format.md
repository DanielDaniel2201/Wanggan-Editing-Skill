# Primitive 格式

Primitive 是 Foundation 或可信扩展注册的最小视觉/布局能力契约。它不是某条视频里的对象，也不是完整博主风格。

Profile 在 `profile.json` 中加载 Primitive 文件：

```json
{
  "primitives": ["primitives/transform.json", "primitives/visual-style.json"]
}
```

一个文件可以按类别声明多个 Primitive：

```json
{
  "schema_version": 1,
  "primitives": [
    {
      "id": "base.transform.translate-y",
      "category": "transform",
      "capability": "transform.translate-y",
      "channels": ["transform.translate-y.entry"],
      "description": "垂直位移"
    },
    {
      "id": "base.container.background-color",
      "category": "visual-style",
      "capability": "container.style",
      "asset_props": ["container.background_color"],
      "description": "容器背景颜色"
    }
  ]
}
```

字段含义：

- `id`：带声明 Profile namespace 的稳定 ID；Foundation 暂用 `base.*` 兼容已有 v3 Composition。
- `category`：`transform`、`visual-style`、`typography`、`layout`、`timing`、`visibility` 或 `content`。
- `capability`：AssetType 必须显式声明的兼容能力。
- `channels`：动画/时间变化写入 Compiler IR 的 channel。
- `asset_props`：静态样式或布局在 Asset `props` 中的字段路径。
- `description`：说明单位和语义，不写具体博主审美。

每个 Primitive 至少声明 `channels` 或 `asset_props`。AssetType/EffectType 通过 `uses_primitives` 引用它；Loader 会验证：

1. Primitive 已注册并从父 Profile 继承。
2. AssetType/EffectType 同时声明 Primitive 对应的 capability。
3. EffectType 的 `writes_channels` 全部来自它引用的 Primitive。
4. AssetType 的 `instance_schema` 覆盖 Primitive 声明的 Asset prop。
5. Asset Renderer 的 `supportedChannels` 与 `supportedAssetProps` 真正覆盖这些能力。Core Renderer 不硬编码 Primitive ID。

不要为了一个完整成品动画新增 Primitive。`上移淡入`应由 translate-y 与 opacity 原子 Effect 组合；只有无法用现有 capability/channel/Asset prop 表达的底层能力，才新增 Primitive。

普通创作者 Profile 优先继承 Foundation Primitive。确实需要新原子时，同时提供带 namespace 的 Primitive、AssetType/EffectType 和可信 runtime module，并验证预览与导出消费同一 channel。
