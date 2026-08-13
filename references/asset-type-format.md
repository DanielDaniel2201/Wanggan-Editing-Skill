# AssetType 格式

```json
{
  "schema_version": 1,
  "kind": "asset_type",
  "id": "base.video",
  "renderer": "core.video",
  "source_kinds": ["input.video"],
  "capabilities": ["visual", "transform.scale"],
  "default_layer": 0,
  "instance_schema": { "type": "object", "additionalProperties": false },
  "ui": { "label": "主视频", "selectable": true }
}
```

- `id` 必须带 Profile namespace
- `renderer` 指向已注册 renderer，不是文件名
- `capabilities` 供 Effect 兼容判断；只能声明 renderer 实际支持的能力
- `instance_schema` 只校验该类型专有的 `props`
- `system_instance` 存在时，初始化自动创建对应 Asset
- `defaults` 提供实例默认 props
- `ui` 只提供展示与 Inspector 元数据，包括 `create_from_selection` 和 `default_effects`

审查 UI 从 `instance_schema` 读取条目数量和文案长度，不要在 UI 代码中重复这些限制。

Renderer 必须声明 `supportedChannels`。Profile Loader 会验证所有通过 capability 匹配的 Effect，其 `writes_channels` 都能被该 renderer 消费；不允许声明后静默丢弃。

Base 注册的类型：`base.video`、`base.captions`、`base.keywords`、`base.list`、`base.image`。
