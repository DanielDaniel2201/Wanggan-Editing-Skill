# Composition 格式 v1

`composition.json` 是工程唯一真源。

```json
{
  "version": 1,
  "profile": { "id": "base", "version": "1.0.0", "digest": "sha256:..." },
  "assets": [],
  "effects": []
}
```

## Asset

```json
{
  "id": "keywords.001",
  "type": "base.keywords",
  "enabled": true,
  "source": { "kind": "agent-generated" },
  "lifecycle": { "kind": "word_range", "start_word_index": 30, "end_word_index": 45 },
  "props": {
    "layout": "auto",
    "items": [
      {
        "id": "keywords.001.item.001",
        "start_word_index": 30,
        "end_word_index": 34,
        "display_text": "效率"
      }
    ]
  },
  "origin": { "created_by": "agent", "human_modified": false }
}
```

系统自动创建 `video.main` 和 `captions.main`。Agent 只创建实例，不创建类型。

## Effect

```json
{
  "id": "effect.001",
  "type": "base.scale",
  "target": { "asset_id": "video.main" },
  "timing": { "kind": "word_range", "start_word_index": 30, "end_word_index": 45 },
  "config": {
    "from_scale": 1,
    "to_scale": 1.2,
    "interpolation": "linear",
    "underflow_fill": "black"
  },
  "origin": { "created_by": "agent", "human_modified": false }
}
```

Keyword/List 实例还要挂 `base.progressive-reveal`；需要弹出时再挂 `base.pop`。

## Timing

- `word_range`：`start_word_index` + `end_word_index`
- `cue`：`cue_id`
- `item`：`item_id`
- `asset_items`：以目标 Asset 的条目范围为准
- `item_enter`：逐条进入
- `asset_enter`：目标 Asset 进入

`timing.kind` 必填，并且必须同时被 EffectType 和 operator 支持。Compiler 先把 timing 解析为统一时间范围，再调用 operator。

导入文件可以只含 `assets` 和 `effects`。系统 Asset 会被保留并按提交内容合并 props。
