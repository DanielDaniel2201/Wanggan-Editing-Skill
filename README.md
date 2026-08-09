# wanggan-editing

一个面向口播视频的 Agent Skill，根据字级逐字稿添加网感缩放、字幕强调、普通烧录字幕和逐条累积清单，并提供可逐字调整的本地审查网页

## 功能

- 根据语义添加短促重点、短促负面、长重点和长负面效果
- 对字幕中的特定字块应用大字号和亮颜色
- 在审查网页中逐字选择效果、拖动和缩放字幕区块
- 把第一、第二、第三等枚举条目移到画面上方逐条累积，条目之间恢复普通字幕
- 在审查网页中修改清单文案和逐字范围，并独立拖动和缩放清单区块
- 保持预览与 FFmpeg 最终渲染一致
- 用户确认前不生成最终视频，不覆盖原始素材

## 使用

把整个仓库放入项目的 `.agents/skills/wanggan-editing`，然后让 Agent 使用 `wanggan-editing` 处理视频

输入需要包含视频和扁平字级 JSON，逐字稿格式为：

```json
[
  { "text": "示", "start": 0.16, "end": 0.28 },
  { "text": "例", "start": 0.28, "end": 0.40 }
]
```

可选提供同名 SRT 作为普通字幕分句来源

结构化清单使用 `overlays.json` v2，可以由 Agent 识别条目后批量导入

```powershell
node scripts/wanggan.mjs import-overlays --project "<任务目录>" --input "<覆盖层 JSON>"
```

完整工作流程和命令见 [SKILL.md](SKILL.md)

## 环境

需要 Node.js、FFmpeg 和 FFprobe

```powershell
node scripts/wanggan.mjs doctor
node scripts/test.mjs
```
