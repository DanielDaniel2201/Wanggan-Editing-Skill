---
name: wanggan-editing
description: 为口播视频按逐字时间戳添加网感缩放、普通烧录字幕、逐条累积清单、渐进关键词散布和定时图片贴图。由 Agent 阅读 Profile 选择规则后写入 composition.json，脚本负责校验、审查网页和确认后导出 MP4。适用于网感剪辑、重点放大、负面缩小、字幕烧录、清单枚举、Hook 关键词、图片 overlay 和人机协同初剪。
---

# 网感剪辑

语义判断和视频处理分开：

- Agent 阅读当前 Profile 的 Markdown 选择规则，决定创建哪些 Asset 和 Effect
- 脚本用 JSON Schema 与 Constraint 做硬校验，编译同一份 IR 供预览和导出
- 原视频、words、SRT 和外部图片只读
- 用户确认前只提供实时预览，不渲染最终 MP4

## 工作流程

1. 运行环境检查

```powershell
node scripts/wanggan.mjs doctor
```

2. 用三个强制输入初始化任务目录

必须同时提供剪辑好的口播 MP4、扁平字级 JSON（每项含 `text`、`start`、`end`）和对齐的 UTF-8 SRT。缺一项就拒绝。

```powershell
node scripts/wanggan.mjs init --video "<视频路径>" --words "<逐字稿路径>" --srt "<SRT 路径>" --profile base --project "<任务目录>"
```

- `--profile base` 加载 Skill 内 `profiles/base`
- 也接受显式 Profile 目录路径
- 非 Base Profile 若包含 `runtime_modules`，必须加 `--allow-profile-code`

3. 读取 Profile 选择规则并设计效果

先加载当前工程的 Profile，再完整阅读它声明的全部 selection rule Markdown。Base 的规则在 [profiles/base/selection-rules.md](profiles/base/selection-rules.md)。

按这个顺序判断：划分完整语义块 → 是否值得做效果 → 创建哪些 Asset/Effect → 检查密度和边界 → 写入 Composition。

不要只根据“不、没有、失败、重要”等单字词机械分类。

4. 把决定写成 Composition 片段并原子导入

格式见 [references/composition-format.md](references/composition-format.md)。不要手写 `start`、`end`、`source_text`；脚本从 words 派生。

```powershell
node scripts/wanggan.mjs import --project "<任务目录>" --input "<composition 片段>"
```

5. 启动审查网页

```powershell
node scripts/wanggan.mjs serve --project "<任务目录>" --port 8911
```

把输出的本地地址交给用户。画面效果、字幕、覆盖层点击即保存并热重载。用户确认前不要渲染。

6. 仅在用户明确确认后出片

```powershell
node scripts/wanggan.mjs render --project "<任务目录>"
```

审查页的“确认并生成成片”执行同一流程。Profile 与 lock 不一致时必须先：

```powershell
node scripts/wanggan.mjs profile sync --project "<任务目录>"
```

## 硬性规则

- 初始化强制接收视频、扁平 words JSON 和 SRT；SRT 必须与 words 顺序对齐
- `composition.json` 是 Asset/Effect 唯一真源；不读取、写入或迁移旧工程格式
- Core 不内置 `base.keywords`、`base.scale` 等业务类型；类型只来自已加载 Profile
- 四种视频缩放都是 `base.scale` 的不同 config；大字亮色是 `base.text-style` 的 config
- Keyword/List 的累积出现和 pop 是独立 Effect，不是 Asset 内置行为
- capability、channel 和 timing model 是强契约；声明兼容的组合必须能真实进入 Compiler IR、预览和导出
- 预览和最终 MP4 消费同一个 Compiler IR
- 时间单位是秒；词语范围必须落在 words 边界上
- 人工修改保留原 `created_by`，同时写 `human_modified: true`
- 不覆盖输入文件和已存在的输出文件
- 不自动调用外部模型

## 按需阅读

- [选择规则](profiles/base/selection-rules.md)
- [Composition](references/composition-format.md)
- [Profile 编写](references/profile-authoring.md)
- [Profile / AssetType / EffectType / Constraint](references/profile-format.md)
