# 编辑现场接口 v1

`editor-state.json` 位于任务工程目录。

```json
{
  "version": 1,
  "savedAt": "2026-08-08T12:00:00.000Z",
  "currentTime": 12.467,
  "selectedWordIndexes": [81, 82, 83]
}
```

- `savedAt` 是最后一次“保存工程”的时间
- `currentTime` 是播放器停留秒数
- `selectedWordIndexes` 是当前选中的词语索引
- 保存工程只更新这个文件，不改 `composition.json`，不渲染视频
- 重新启动同一工程时恢复 Composition、字幕状态、播放位置和选择范围
