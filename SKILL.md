---
name: wanggan-editing
description: 为已经剪掉气口和口癖的口播成片添加网感缩放、烧录字幕、清单、关键词和贴图，也用于创建或修改创作者自己的 IP Profile、selection rules、品牌样式和动画配置。执行具体视频编辑前必须同时具备剪好的 MP4、分句 SRT 和字级时间戳 JSON，缺一不可；纯 Profile Authoring 不要求视频素材。缺件时引导使用 Koubo-Editing-Skill，不要在本 Skill 里生成这三样。触发场景包括网感剪辑、重点放大、负面缩小、字幕烧录、清单枚举、Hook 关键词、图片 overlay、人机协同初剪，以及“定制我的 IP”“以后按这套风格”“不要 Base 规则”“创建 Profile”。
---

# 网感剪辑

语义判断和视频处理分开：

- Agent 阅读当前 Profile 的 Markdown 选择规则，决定创建哪些 Asset 和 Effect
- 脚本用 JSON Schema 与 Constraint 做硬校验，编译同一份 IR 供预览和导出
- 原视频、words、SRT 和外部图片只读
- 用户确认前只提供实时预览，不渲染最终 MP4

## 技术框架（Agent 先读）

先按下面的依赖链理解系统，再决定修改位置：

```text
Core 通用机制
  -> Foundation Primitive + 原子 AssetType/EffectType
  -> Base / 创作者 Profile 自定义类型、组合效果、创作与品牌规则
  -> Composition 当前视频实例
  -> Compiler IR（resolve -> apply -> finalize）
  -> 实时预览 + 最终导出
```

- **Core**：负责注册、Schema/Constraint 校验、时间插值、编译和预览/导出管线；不决定哪里该加效果，也不认识任何博主风格。
- **Foundation**：是无创作立场的正式 Profile 和原子标准库。Primitive 明确注册 transform、visual style、typography、layout、visibility 的 capability、channel 或 Asset prop；原子 AssetType/EffectType 引用这些 Primitive。
- **Base**：是继承 Foundation 的正式示例 Profile，不是 Core 内置预设；它只保留 selection rules、`style_patches` 和由原子 Effect 组成的示例复合效果。
- **创作者 Profile**：可以继承 Foundation 或 Base，新增自己的 AssetType、EffectType、复合 Effect、Constraint 和 selection rules。已有 Primitive 足够时只声明 JSON；缺少底层 Primitive、Operator 或 Renderer 时才使用可信 `runtime_modules`。
- **类型与实例**：Profile 声明 AssetType/EffectType；某条视频实际出现的 Asset/Effect 实例只写入 `composition.json`。不要把当前视频内容写回 Profile。
- **复杂效果**：EffectType 用 `composes` 引用多个原子 EffectType。Composition 保留一个复合 Effect 实例，Compiler 通用展开并写入各原子 channel；例如 Base 的 `item-enter` 由垂直位移入场与透明度入场组成。
- **Compiler IR**：把 Profile 契约与 Composition 实例解析成统一结果。预览和最终导出必须消费同一份 IR，不能各自实现一套效果语义。

按变化性质选择落点：创作判断改 selection rules；品牌与默认参数改 `style_patches` 或 Effect config；新的语义对象声明 AssetType；已有原子的复杂动画声明复合 EffectType；真正缺少原子 channel/绘制能力时才写可信 `runtime_modules`。完整格式见 [Primitive](references/primitive-format.md) 与 [Profile 编写](references/profile-authoring.md)。

## 前置条件（缺一不可）

本 Skill 只做网感特效，不做口播粗剪。进入 Composition/具体视频编辑工作流前，先检查**当前工作目录**是否同时具备下面三样。缺任何一样就停下来：不要跑 `init`，不要补字幕，不要伪造时间戳。纯 Profile Authoring 可以在没有素材时进行，但不得伪称已经验证具体视频的预览或导出。

| 输入 | 是什么 | 常见文件名 |
|---|---|---|
| 剪好的口播视频 | 已剪掉气口、口癖、重复和长停顿，只缺网感特效的 MP4 | `*_cut.mp4` |
| 分句 SRT | 与成片时间线对齐的 UTF-8 字幕 | `*_cut.srt` |
| 字级时间戳 | 扁平数组，每项含 `text`、`start`、`end` | `*_cut.words.json` |

「剪辑好」不是原片，也不是只粗切过的素材。气口、口癖还在的视频不能当输入。

缺件时告诉使用者：先用 Koubo-Editing-Skill (https://github.com/DanielDaniel2201/Koubo-Editing-Skill) 从原始口播导出这三样，再回到本 Skill。反馈中必须保留这个完整 URL，不要只写 Skill 名称或只使用不可见链接。

## 工作流程

1. 运行环境检查

```powershell
node scripts/wanggan.mjs doctor
```

2. 用已经确认存在的三个输入初始化任务目录

```powershell
node scripts/wanggan.mjs init --video "<视频路径>" --words "<逐字稿路径>" --srt "<SRT 路径>" --profile base --project "<任务目录>"
```

- `--profile base` 加载 Skill 内的示例风格 Profile；它继承无创作立场的 `profiles/foundation`
- 也接受显式 Profile 目录路径
- 非 Base Profile 若包含 `runtime_modules`，必须加 `--allow-profile-code`

3. 读取 Profile 选择规则并设计效果

先判断用户是在剪当前视频，还是在定制长期使用的 IP Profile：

- “按当前风格剪这条视频”进入 Composition 工作流
- “定制我的 IP”“以后都按这套风格”“不要 Base 的规则”“List 想换动画”进入 Profile Authoring 工作流，完整阅读 [Profile 编写](references/profile-authoring.md)

剪辑时先加载当前工程的 Profile，再完整阅读它最终生效的全部 selection rule Markdown。Base 是示例风格，规则在 [profiles/base/selection-rules.md](profiles/base/selection-rules.md)；Foundation 不带创作规则。

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

- 缺前置三件套时禁止继续，见上文「前置条件」
- 初始化强制接收这三样；SRT 必须与 words 顺序对齐
- `composition.json` 是 Asset/Effect 唯一真源；不读取、写入或迁移旧工程格式
- Core 不内置 `base.keywords`、`base.scale` 等业务类型；这些稳定 ID 由 Foundation Profile 注册，`base.*` namespace 为兼容已有 v3 Composition 保留
- 四种视频缩放都是 `base.scale` 的不同 config；大字亮色是 `base.text-style` 的 config
- Keyword/List 的累积出现和 pop 是独立 Effect，不是 Asset 内置行为
- List 的背景、边框、圆角和 padding 属于容器样式；上移、透明度、duration、delay 和 easing 属于 `base.item-enter` Effect config
- capability、channel 和 timing model 是强契约；声明兼容的组合必须能真实进入 Compiler IR、预览和导出
- AssetType/EffectType 必须声明 `uses_primitives`；Renderer 只声明实际消费的 `supportedChannels` 与 `supportedAssetProps`，不能硬编码 Primitive ID
- 复杂 Effect 优先用 `composes` 组合原子 Effect；不要为已有原子组合新增写死逻辑的 Core Operator
- 预览和最终 MP4 消费同一个 Compiler IR
- 时间单位是秒；词语范围必须落在 words 边界上
- 人工修改保留原 `created_by`，同时写 `human_modified: true`
- 不覆盖输入文件和已存在的输出文件
- 不自动调用外部模型

## 按需阅读

- [选择规则](profiles/base/selection-rules.md)
- [Composition](references/composition-format.md)
- [Profile 编写](references/profile-authoring.md)
- [Primitive](references/primitive-format.md)
- [Profile / AssetType / EffectType / Constraint](references/profile-format.md)
