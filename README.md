# wanggan-editing

一个面向口播视频的 Agent Skill，根据字级逐字稿添加网感缩放、字幕强调、普通烧录字幕、逐条累积清单和渐进关键词散布，并提供可逐字调整的本地审查网页

## 功能

- 根据语义添加短促重点、短促负面、长重点和长负面效果
- 对字幕中的特定字块应用大字号和亮颜色
- 在审查网页中逐字选择效果、拖动字幕位置并调整字幕最大宽度
- 普通字幕按中英文显示宽度自动排成一行或两行，预览和最终渲染共用排版结果
- 把第一、第二、第三等枚举条目移到画面上方逐条累积，条目之间恢复普通字幕
- 在审查网页中修改清单文案和逐字范围，并独立拖动和缩放清单区块
- 把开头 Hook 或正文重点压缩成一至四个 2–3 字块，用 `large_bright` 同款大号浅黄色样式依次展示
- 两个词块固定在屏幕高度 `2/3` 的水平三等分点，三个词块使用四等分点，四个词块使用空出一个字高的两行布局
- 结构化文字支持直接出现和固定轻微弹出动画，浏览器与最终 MP4 共用时间规则
- 在审查网页中编辑关键词文案、逐字范围和动画，并逐项拖动或恢复自动布局
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

结构化清单和关键词散布使用 `overlays.json` v2，可以由 Agent 识别条目后批量导入

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
