# 覆盖层接口 v2

`overlays.json` 保存普通字幕轨道和结构化定时覆盖层

- `captions` 保存普通字幕开关、矩形区域和基础样式
- `timed_overlays` 保存由逐字稿范围驱动的结构化覆盖层
- 当前结构化类型为 `progressive_list`，用于按口播进度逐条累积显示清单
- 字幕局部“大字号、亮颜色”仍保存在 `effects.json` v3，通过 `target: overlay.captions` 引用普通字幕轨道

## 标准文件

```json
{
  "version": 2,
  "captions": {
    "enabled": false,
    "coordinate_space": "screen",
    "box": {
      "x": 0.06,
      "y": 0.7,
      "width": 0.88,
      "height": 0.2,
      "unit": "ratio"
    },
    "style": {
      "font_family": "Noto Sans SC",
      "font_size_ratio": 0.06,
      "color": "#FFFFFF",
      "stroke_color": "#000000",
      "stroke_width_ratio": 0.0055,
      "align": "center"
    }
  },
  "timed_overlays": [
    {
      "id": "overlay-list-001",
      "type": "progressive_list",
      "enabled": true,
      "coordinate_space": "screen",
      "box": {
        "x": 0.08,
        "y": 0.12,
        "width": 0.84,
        "height": 0.3,
        "unit": "ratio"
      },
      "style": {
        "font_family": "Noto Sans SC",
        "font_size_ratio": 0.045,
        "color": "#FFFFFF",
        "stroke_color": "#000000",
        "stroke_width_ratio": 0.004,
        "item_gap_ratio": 0.014,
        "align": "left"
      },
      "items": [
        {
          "start_word_index": 120,
          "end_word_index": 138,
          "display_text": "一、第一条屏幕文案"
        },
        {
          "start_word_index": 160,
          "end_word_index": 181,
          "display_text": "二、第二条屏幕文案"
        }
      ],
      "source": "ai",
      "human_modified": false
    }
  ]
}
```

## 逐字稿与派生字段

- 每个清单条目提交 `start_word_index`、`end_word_index` 和可选的 `display_text`
- 脚本根据必需的扁平逐字稿重新计算 `start`、`end` 和 `source_text`
- 没有 `display_text` 时使用派生的 `source_text`
- `display_text` 适合去掉“第一个是”“第二个问题就是”等口语连接词
- 审查台同时保留原话和屏幕文案，人工修改后写入 `human_modified: true`
- 清单条目必须按词序排列，同一清单内不能重叠
- 单个清单最多支持 8 个条目
- 启用的两个清单组时间不能重叠

## 清单时间行为

1. 第一条开始时显示第一条

2. 第一条结束后继续保留第一条

3. 第二条开始时在下方增加第二条，后续条目依次累积

4. 播放清单条目本身时，普通底部字幕隐藏

5. 两个条目之间有补充说明时，上方清单继续保留，底部普通字幕恢复

6. 最后一条结束时整组清单立即消失，普通字幕恢复

第一版使用直接出现和直接消失，不提供淡入、弹跳或任意动画参数

## 字幕来源与避让

- `project.json` 有 `subtitlePath` 时读取对应 UTF-8 SRT
- 没有 `subtitlePath` 时从扁平字级 JSON 自动生成普通字幕
- 结构化覆盖层的时间始终来自字级 JSON
- 服务端会按清单条目的字级范围切分普通字幕，只移除重叠文字
- 浏览器预览和最终 ASS 使用同一组 `playbackCaptions` 与 `playbackOverlays`

## 坐标与尺寸

- 所有 `box` 使用相对视频宽高的比例坐标
- 清单中的 `x`、`y`、`width`、`height` 仍然表示完整可用区域
- 普通字幕使用 `x` 和 `width` 表示最大横向区域，使用 `y + height` 表示字幕底部锚点
- 普通字幕的可见高度由当前一行或两行文字自动计算，审查页不再把 `height` 画成固定高度区域
- 保留字幕 `height` 字段是为了让已有 v1、v2 工程继续使用原来的底部位置
- 四个数都在 `0` 到 `1` 之间，区域不能超出画面
- `coordinate_space` 固定为 `screen`，覆盖层绘制在画面缩放之后
- 内容高度超过清单区域时拒绝保存，避免浏览器预览和成片静默溢出

## 普通字幕排版

- 服务端按照汉字、英文字母、数字、空格和标点的显示宽度计算换行
- 英文单词作为完整排版单元，不从单词中间断开
- 优先保留一行，超过最大宽度时从所有断点中选择更均衡的两行方案
- 单独留下一个短英文词的方案会受到额外惩罚
- 大字号亮颜色效果参与宽度计算，必要时整条字幕等比缩小以保持最多两行
- `playbackCaptions` 返回最终 `lines`、`styledLines` 和 `layout_font_scale`
- 浏览器预览只显示服务端排好的结果，最终 ASS 使用同一组换行和字号比例

## 审查网页操作

- 字幕开关保持原有行为，字幕可拖动位置，右下角圆形按钮只调整最大宽度
- 选择连续逐字稿后可以新建清单或追加条目
- 点击条目编号会跳到对应时间并选中原始逐字范围
- 条目支持修改屏幕文案、用当前选择替换范围和删除
- 清单组支持启用、撤下和删除
- 视频中的清单区块支持独立拖动和缩放
- 所有修改立即写入 `overlays.json` 并热重载

## 接口与命令

```powershell
node scripts/wanggan.mjs import-overlays --project "<任务目录>" --input "<覆盖层 JSON>"
```

- `PUT /api/overlays` 原子式替换并校验完整覆盖层文件
- `PATCH /api/overlays/captions` 继续负责普通字幕开关和字幕区域
- `GET /api/state` 返回 `structuredOverlayTrack`、`playbackOverlays` 和避让后的 `playbackCaptions`

## v1 工程迁移

- 读取 `overlays.json` v1 时自动补成 `version: 2` 和空的 `timed_overlays`
- 当前字幕启用状态、位置和样式保持不变
- 下次保存覆盖层时写成 v2
