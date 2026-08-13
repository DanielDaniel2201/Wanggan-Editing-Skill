# Constraint 格式

```json
{
  "schema_version": 1,
  "constraints": [
    {
      "id": "base.primary-overlay-exclusion",
      "kind": "exclusive-active-assets",
      "asset_types": ["base.keywords", "base.list", "base.image"]
    }
  ]
}
```

内置 kind：`capability-match`、`exclusive-per-channel`、`exclusive-active-assets`、`suppress`、`layer-order`、`word-boundaries`、`screen-bounds`、`asset-limits`。

`suppress.targets` 是 AssetType ID 列表。Compiler 只把抑制范围传给这些目标的 renderer；目标 renderer 必须声明 `supportsSuppression: true`。

关闭父约束时使用相同 ID、`override: true` 和 `enabled: false`。修改约束也必须显式 override。
