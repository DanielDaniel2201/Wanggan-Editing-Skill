# EffectType 格式

```json
{
  "schema_version": 1,
  "kind": "effect_type",
  "id": "base.scale",
  "operator": "core.transform.scale",
  "requires_capabilities": ["transform.scale"],
  "uses_primitives": ["base.transform.scale"],
  "timing_models": ["word_range"],
  "writes_channels": ["transform.scale"],
  "overlap_policy": "exclusive-per-channel",
  "config_schema": { "type": "object" },
  "ui": { "label": "画面缩放", "presets": [] }
}
```

- Core 只根据 `operator`、能力、通道、时间模型和 Schema 工作，不按 Effect ID 判断语义
- `uses_primitives` 声明该 EffectType 使用的原子能力；`writes_channels` 必须来自这些 Primitive
- Operator 必须声明 `writesChannels` 和 `timingModels`；它们必须覆盖 EffectType 的声明
- 每个 capability 匹配的 Asset renderer 都必须消费全部 `writes_channels`，否则 Profile 加载失败
- 未声明组合策略时，同一 Asset 同一时间同一 exclusive 通道禁止重叠
- `ui.presets` 提供审查页可点击的固定配置，例如瞬间放大对应 `from_scale=1, to_scale=1.2, interpolation=step`
- `ui.preferred_target_source` 可指定系统 Asset 的优先来源；当前时间范围内已有兼容 Overlay 时优先作用于该 Overlay
- 审查页的逐字选择按钮只显示支持 `word_range` 的 Effect；其他时间模型通过 Asset 编辑器或 Composition 创建

Foundation 注册原子 EffectType，例如 `base.scale`、`base.opacity`、`base.translate-y-entry`、`base.opacity-entry` 和 `base.progressive-reveal`。Base 在同一 Profile 机制上声明 `base.pop`、`base.item-enter` 等复合 EffectType。

复杂 EffectType 不写 `operator`，改用 `composes`：

```json
{
  "id": "my-ip.up-fade",
  "uses_primitives": ["base.transform.translate-y", "base.visual.opacity"],
  "requires_capabilities": ["transform.translate-y", "style.opacity"],
  "writes_channels": ["transform.translate-y.entry", "style.opacity.entry"],
  "timing_models": ["item_enter"],
  "composes": [
    {
      "id": "move",
      "effect_type": "base.translate-y-entry",
      "config": { "to_translate_y_ratio": 0 },
      "config_from": { "from_translate_y_ratio": "from_y", "duration": "duration", "easing": "easing" }
    },
    {
      "id": "fade",
      "effect_type": "base.opacity-entry",
      "config": { "to_opacity": 1 },
      "config_from": { "from_opacity": "from_opacity", "duration": "duration", "easing": "easing" }
    }
  ],
  "config_schema": {
    "type": "object",
    "additionalProperties": false,
    "required": ["from_y", "from_opacity", "duration", "easing"],
    "properties": {
      "from_y": { "type": "number" },
      "from_opacity": { "type": "number", "minimum": 0, "maximum": 1 },
      "duration": { "type": "number", "exclusiveMinimum": 0 },
      "easing": { "enum": ["linear", "ease-in", "ease-out", "ease-in-out"] }
    }
  }
}
```

- `composes[].effect_type` 必须是当前 Profile 已继承或注册的 EffectType。
- `config` 提供固定子配置；`config_from` 把父 Effect config 字段映射到子配置，键是子字段路径，值是父字段路径。
- 复合 Effect 的 capability、channel 和 timing model 必须覆盖所有子 Effect 契约，循环组合会被拒绝。
- `composition.json` 只保存一个复合 Effect 实例；Compiler 展开后调用原子 Operator，预览和导出继续消费相同 IR channel。
