# Profile 格式

`profile.json` 是 Profile 根清单，Base 与自定义 Profile 使用同一格式。

```json
{
  "schema_version": 1,
  "id": "base",
  "version": "1.0.0",
  "extends": [],
  "selection_rules": ["selection-rules.md"],
  "asset_types": ["asset-types/video.json"],
  "effect_types": ["effect-types/scale.json"],
  "constraints": ["constraints.json"],
  "runtime_modules": []
}
```

- `schema_version` 是文件格式版本
- `version` 是 Profile 语义版本
- 相对路径相对于当前 Profile 根目录解析，禁止 `..` 越界
- 新定义的 ID 必须使用当前 Profile namespace；只有显式 `override: true` 可以沿用父级 ID
- `extends` 按从父到子的顺序合并；相同 ID 默认报错，子定义必须写 `override: true` 才能替换
- `--profile base` 解析 Skill 内 `profiles/base`，也接受显式目录路径
- 解析后生成稳定 SHA-256 digest，写入工程 `profile-lock.json`
- Profile 文件变化后，审查页可以预览，但必须执行 `profile sync` 后才能导出
- 不支持旧工程格式或迁移入口；工程必须由三个强制输入执行 `init` 创建

详见 [asset-type-format.md](asset-type-format.md)、[effect-type-format.md](effect-type-format.md)、[constraints-format.md](constraints-format.md)。
