# EffectType 格式

```json
{
  "schema_version": 1,
  "kind": "effect_type",
  "id": "base.scale",
  "operator": "core.transform.scale",
  "requires_capabilities": ["transform.scale"],
  "timing_models": ["word_range"],
  "writes_channels": ["transform.scale"],
  "overlap_policy": "exclusive-per-channel",
  "config_schema": { "type": "object" },
  "ui": { "label": "画面缩放", "presets": [] }
}
```

- Core 只根据 `operator`、能力、通道、时间模型和 Schema 工作，不按 Effect ID 判断语义
- Operator 必须声明 `writesChannels` 和 `timingModels`；它们必须覆盖 EffectType 的声明
- 每个 capability 匹配的 Asset renderer 都必须消费全部 `writes_channels`，否则 Profile 加载失败
- 未声明组合策略时，同一 Asset 同一时间同一 exclusive 通道禁止重叠
- `ui.presets` 提供审查页可点击的固定配置，例如瞬间放大对应 `from_scale=1, to_scale=1.2, interpolation=step`
- `ui.preferred_target_source` 可指定系统 Asset 的优先来源；当前时间范围内已有兼容 Overlay 时优先作用于该 Overlay
- 审查页的逐字选择按钮只显示支持 `word_range` 的 Effect；其他时间模型通过 Asset 编辑器或 Composition 创建

Foundation 注册的类型：`base.scale`、`base.text-style`、`base.opacity`、`base.progressive-reveal`、`base.pop`、`base.item-enter`。

`base.item-enter` 使用 `core.transition.translate-opacity`，写入 `transform.translate-y.entry` 与 `style.opacity.entry`。其位移、透明度、duration、delay 和 easing 全部来自 config；浏览器和 ASS 导出必须同时消费这两个 channel。
