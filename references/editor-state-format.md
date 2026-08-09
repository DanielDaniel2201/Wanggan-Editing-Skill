# 编辑现场接口 v1

`editor-state.json` 位于任务工程目录

```json
{
  "version": 1,
  "savedAt": "2026-08-08T12:00:00.000Z",
  "currentTime": 12.467,
  "selectedWordIndexes": [81, 82, 83, 84, 85, 86]
}
```

## 字段

- `savedAt` 是最后一次点击“保存工程”的时间
- `currentTime` 是播放器当前停留秒数
- `selectedWordIndexes` 是当前选中的逐字稿词语索引

## 恢复规则

- `effects.json` 恢复全部 AI 和人工画面效果
- `overlays.json` 恢复字幕启用或撤下状态
- `editor-state.json` 恢复播放位置和逐字稿选择范围
- 文件不存在时按播放位置 `0` 和空选择启动，兼容旧工程
- 保存和恢复都不得修改输入视频、输入逐字稿或输入 SRT
