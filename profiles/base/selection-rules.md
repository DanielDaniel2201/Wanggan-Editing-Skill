# Base 选择规则

阅读全部逐字稿和分句 SRT 后再创建实例。JSON Schema 与 Constraint 决定能不能保存；本文件只决定该不该创建。

不得只根据“不、没有、失败、重要”等单个词语机械分类。

## 1. 先划分完整语义块

- 按停顿、标点和完整意思切块，不要把半句话拆开做效果
- 一个块只表达一个判断：结论、风险、过程或枚举
- 数字、专名、结论词要连同修饰语一起选

## 2. 何时给 `video.main` 创建 `base.scale`

只根据口播语义给主视频添加缩放。正向信息放大，负面信息缩小。短促块用硬切，长段用线性。

| 语义 | 时长参考 | 字数参考 | config |
|---|---|---|---|
| 数字、结论、反转、核心词组 | 0.3–1.5 秒 | 2–8 个中文字 | `from_scale=1, to_scale=1.2, interpolation=step, underflow_fill=black` |
| 风险、失败、痛点、不良结果 | 0.3–1.5 秒 | 2–8 个中文字 | `from_scale=1, to_scale=0.75, interpolation=step, underflow_fill=black` |
| 完整观点、持续性结论 | 1.5–4 秒 | 一个完整分句 | `from_scale=1, to_scale=1.2, interpolation=linear, underflow_fill=black` |
| 完整问题或负面过程 | 1.5–4 秒 | 一个完整分句 | `from_scale=1, to_scale=0.75, interpolation=linear, underflow_fill=black` |

- 短促块选择最小完整词组
- 长段在语义停顿处结束，负面长段不要跨进后面的解决方案
- 不要给同一段话叠两个缩放；相邻且同配置的块可以连着写，预览会连续播放

## 3. 何时给 `captions.main` 创建 `base.text-style`

观众需要立刻看见的关键词才加文字样式。默认配置：

```json
{ "font_scale": 1.25, "color": "#FFF08A" }
```

- 通常不超过 1.5 秒，只覆盖核心字块
- 可以和主视频缩放使用同一词语范围
- 不要把整句都做成大字

## 4. 何时创建 `base.keywords`

开头 Hook 或正文里值得记住的 1–4 个重点，压缩成 2–3 个字符的独立词块。

每个实例必须同时挂：

- `base.progressive-reveal`，`timing.kind=asset_items`，`retain_until=asset_end`
- 需要弹出时再挂 `base.pop`，`timing.kind=item_enter`；不需要动画就不要创建 pop

`display_text` 为 2–8 个字符：中文 2–4 字词组（如“网感剪辑”“画面缩放”）或 2–8 个英文字母的英文词（如 skill、agent）都可以。时间范围仍可覆盖对应完整原话。不要把整句塞进一个词块；同一 asset 可放多个条目（最多 4 个），条目必须落在 asset 生命周期内。

## 5. 何时创建 `base.list`

同一组有序枚举、步骤或对比项，最多 8 条。条目按口播顺序排列。

每个实例默认同时挂：

- `base.progressive-reveal`：条目按口播进度累积出现
- `base.item-enter`：条目从下方上移并淡入；需要克制或静态风格时可以不创建

`base.item-enter` 的位移、透明度、duration 与 easing 都来自 Effect config，不是 Renderer 硬编码。

`display_text` 去掉“第一个是”“第二个问题就是”等口语连接词，保留观众要读的条目正文。

## 6. 何时创建 `base.image`

口播正在指着、对比或展示某张本地图时才贴图。提交连续 word range 和只读 `image_path`。

- 不要用贴图代替关键词或清单
- 一张图只覆盖它真正被提到的区间

## 7. 密度、边界和过载

- 先问“这段值不值得做效果”，再问做什么
- 相邻效果不要过密；让画面有回到原尺寸的呼吸
- 关键词、清单、贴图的启用区间不要抢同一时间
- 清单或关键词条目正在读的时候不要再叠一层大字字幕
- 效果范围必须落在词语边界上，不要用估计秒数
