# 覆盖层接口 v2

`overlays.json` 保存普通字幕轨道和结构化定时覆盖层

- `captions` 保存普通字幕开关、矩形区域和基础样式
- `timed_overlays` 保存由逐字稿范围驱动的结构化覆盖层
- `progressive_list` 用于按口播进度纵向累积显示清单
- `progressive_keywords` 用于把开头 Hook 或正文中值得强调的内容压缩成一至四个 2–3 字块并依次展示
- `image` 用于在连续逐字稿范围内把本地图片完整放入画面区块
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
      "font_family": "Microsoft YaHei",
      "font_size_ratio": 0.06,
      "color": "#FFFFFF",
      "stroke_color": "#000000",
      "stroke_width_ratio": 0.0055,
      "align": "center"
    },
    "cue_fonts": {
      "caption-001": "华文中宋"
    },
    "cue_font_size_ratios": {
      "caption-001": 0.075
    }
  },
  "timed_overlays": [
    {
      "id": "overlay-list-001",
      "type": "progressive_list",
      "enabled": true,
      "enter_animation": "none",
      "coordinate_space": "screen",
      "box": {
        "x": 0.08,
        "y": 0.12,
        "width": 0.84,
        "height": 0.3,
        "unit": "ratio"
      },
      "style": {
        "font_family": "华文中宋",
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
    },
    {
      "id": "overlay-keywords-001",
      "type": "progressive_keywords",
      "enabled": true,
      "layout": "auto",
      "enter_animation": "pop",
      "items": [
        {
          "start_word_index": 220,
          "end_word_index": 223,
          "display_text": "普通人"
        },
        {
          "start_word_index": 224,
          "end_word_index": 226,
          "display_text": "也能"
        },
        {
          "start_word_index": 227,
          "end_word_index": 230,
          "display_text": "做网站"
        }
      ],
      "source": "ai",
      "human_modified": false
    },
    {
      "id": "overlay-image-001",
      "type": "image",
      "enabled": true,
      "image_path": "D:\\素材\\产品截图.png",
      "fit": "contain",
      "coordinate_space": "screen",
      "box": {
        "x": 0.58,
        "y": 0.08,
        "width": 0.34,
        "height": 0.28,
        "unit": "ratio"
      },
      "start_word_index": 260,
      "end_word_index": 282,
      "source": "ai",
      "human_modified": false
    }
  ]
}
```

## 逐字稿与派生字段

- 每个结构化文字条目提交 `start_word_index`、`end_word_index` 和可选的 `display_text`
- 脚本根据必需的扁平逐字稿重新计算 `start`、`end` 和 `source_text`
- 没有 `display_text` 时使用派生的 `source_text`
- `display_text` 适合去掉“第一个是”“第二个问题就是”等口语连接词
- 审查台同时保留原话和屏幕文案，人工修改后写入 `human_modified: true`
- 清单条目必须按词序排列，同一清单内不能重叠
- 单个清单最多支持 8 个条目
- 单个关键词组最多支持 4 个条目
- 启用的清单、关键词和图片定时覆盖层时间不能重叠

## 清单时间行为

1. 第一条开始时显示第一条

2. 第一条结束后继续保留第一条

3. 第二条开始时在下方增加第二条，后续条目依次累积

4. 播放清单条目本身时，普通底部字幕隐藏

5. 两个条目之间有补充说明时，上方清单继续保留，底部普通字幕恢复

6. 最后一条结束时整组清单立即消失，普通字幕恢复

## 关键词时间与布局行为

1. 每个词组在对应逐字稿范围开始时出现

2. 已经出现的词组持续保留，最后一个词组结束时整组消失

3. 每个屏幕文案必须是 2–3 个字符，时间范围仍可覆盖对应的完整原话

4. 一个词块位于屏幕高度上方 `1/3`、水平 `1/2`

5. 两个词块位于同一高度的水平 `1/3` 和 `2/3`

6. 三个词块位于同一高度的水平 `1/4`、`2/4` 和 `3/4`

7. 四个词块使用两行两列，第一行复用两个词块的位置，第二行与第一行之间空出一个字高

8. 自动布局默认使用普通字幕 `large_bright` 的 `125%` 字号和浅黄色 `#FFF08A`，审查台允许按整组调整字号

9. 人工拖动某个词组后整组变为 `layout: custom`，每个条目的独立 `box` 参与保存和校验

## 图片贴图时间与布局行为

1. 直接提交 `start_word_index`、`end_word_index` 和 `image_path`

2. 第一个词开始时显示图片，最后一个词结束时立即消失

3. 服务端重新计算 `start`、`end` 和 `source_text`，不接受手写秒数替代词索引

4. `fit` 固定为 `contain`，横图、竖图和透明图都保持原始宽高比，完整放进 `box`，多余区域透明

5. 支持 PNG、JPG、JPEG、WebP、BMP，图片路径必须指向本地存在的文件

6. 图片位于画面缩放层上方、字幕和结构化文字下方，不参与字幕避让

7. 审查页和最终 FFmpeg 都使用同一组 `box`、`start`、`end` 和 `contain` 规则

## 固定入场动画

- `enter_animation: none` 直接出现
- `enter_animation: pop` 最长在 180 毫秒内从透明变为不透明，同时从 `85%` 线性缩放到 `100%`，条目间隔更短时按间隔收紧
- 动画只作用于当前新增条目，已经保留的条目不能重复播放动画
- 不接受动画时长、缩放幅度、缓动曲线等任意参数
- 浏览器预览和最终 ASS 使用同一个条目开始时间、动画时长和线性进度

## 字幕来源与避让

- `project.json` 有 `subtitlePath` 时读取对应 UTF-8 SRT
- 没有 `subtitlePath` 时从扁平字级 JSON 自动生成普通字幕
- 结构化覆盖层的时间始终来自字级 JSON
- 服务端会按清单条目的字级范围切分普通字幕，只移除重叠文字
- 浏览器预览和最终 ASS 使用同一组 `playbackCaptions` 与 `playbackOverlays`

## 坐标与尺寸

- 所有 `box` 使用相对视频宽高的比例坐标
- 清单中的 `x`、`y`、`width` 表示整组位置和可用宽度，编译后的 `height` 按当前字号、换行和间距自动贴合内容
- 关键词自动布局由服务端生成每个条目的独立 `box`
- 关键词人工拖动后保存每个条目的横向范围和中心位置，编译后的 `height` 按当前整组字号和文字行数自动贴合
- 图片的 `x`、`y`、`width`、`height` 表示可用区块，图片按原始宽高比居中放入该区块
- 普通字幕使用 `x` 和 `width` 表示最大横向区域，使用 `y + height` 表示字幕底部锚点
- 普通字幕的可见高度由当前一行或两行文字自动计算，审查页不再把 `height` 画成固定高度区域
- 保留字幕 `height` 字段是为了让已有 v1、v2 工程继续使用原来的底部位置
- 四个数都在 `0` 到 `1` 之间，区域不能超出画面
- `coordinate_space` 固定为 `screen`，覆盖层绘制在画面缩放之后
- 清单和关键词的 `style.font_size_ratio` 只保存组级字号，不保存条目级字号
- `style.font_size_ratio` 接受 `0.015` 到 `0.12`，浏览器预览和最终 ASS 共用该值
- 字号变化后服务端重新计算所有条目高度和换行，固定区域高度不再限制字号调整

## 普通字幕排版

- 服务端按照汉字、英文字母、数字、空格和标点的显示宽度计算换行
- 英文单词作为完整排版单元，不从单词中间断开
- 优先保留一行，超过最大宽度时从所有断点中选择更均衡的两行方案
- 单独留下一个短英文词的方案会受到额外惩罚
- 大字号亮颜色效果参与宽度计算，必要时整条字幕等比缩小以保持最多两行
- `playbackCaptions` 返回最终 `lines`、`styledLines` 和 `layout_font_scale`
- 浏览器预览只显示服务端排好的结果，最终 ASS 使用同一组换行和字号比例

## 字体选择

- 字体只接受 `Microsoft YaHei` 和 `华文中宋`
- 审查网页把两者显示为“默认粗黑体”和“华文中宋”
- `captions.style.font_family` 是没有单独设置时的普通字幕默认字体
- `captions.cue_fonts` 按稳定的 `caption-001` 编号保存单条字幕字体
- `captions.cue_font_size_ratios` 按稳定的 `caption-001` 编号保存单条字幕字号比例，范围为 `0.015` 到 `0.15`
- 每个 `progressive_list` 或 `progressive_keywords` 组使用自己的 `style.font_family`
- 被结构化文字避让而切成多个可见片段的字幕继续继承原字幕编号的字体
- 被结构化文字避让而切成多个可见片段的字幕继续继承原字幕编号的字号
- 浏览器预览和最终 ASS 必须读取同一个字体字段
- 旧工程中的 `Noto Sans SC` 读取时归一化成 `Microsoft YaHei`，避免 FFmpeg 误选极细字重

## 审查网页操作

- 字幕开关保持原有行为，字幕可拖动位置
- 字幕 Box 只显示右下角一个圆形按钮，与关键词一致，只调整当前字幕条目的字号，并按稳定 cue id 保存
- 选择连续逐字稿后可以新建清单、新建关键词组或追加条目
- 点击条目编号会跳到对应时间并选中原始逐字范围
- 条目支持修改屏幕文案、用当前选择替换范围和删除
- 清单组支持启用、撤下和删除
- 视频中的清单点击任意条目都可选中，拖动正文移动整组位置
- 视频中的关键词支持逐项拖动，右侧可以恢复自动布局
- 清单和关键词的每个条目右下角都提供字号手柄，拖动任意一个手柄统一改变当前组所有条目的字号
- 关键词字号变化时，每个词框宽度按字号倍率同步变化，允许词框重叠，用户可以再逐项拖动排布
- 条目框高度始终贴合文字，清单按条目重新排布，关键词保留各自中心位置
- 点击视频中的字幕、关键词或清单后，可以只修改当前字幕块或当前结构化文字组的字体
- 每个结构化文字组可以选择直接出现或轻微弹出
- 选择连续逐字稿后可以新建贴图并粘贴本地图片路径
- 视频中的图片支持整块拖动，右下角白色圆点支持同时修改区块宽高
- 贴图支持定位逐字范围、替换范围、替换路径、启用、撤下和删除
- 所有修改立即写入 `overlays.json` 并热重载

## 接口与命令

```powershell
node scripts/wanggan.mjs import-overlays --project "<任务目录>" --input "<覆盖层 JSON>"
```

- `PUT /api/overlays` 原子式替换并校验完整覆盖层文件
- `PATCH /api/overlays/captions` 负责普通字幕开关、字幕区域和单条字幕字体
- `GET /api/state` 返回 `structuredOverlayTrack`、`playbackOverlays`、`imageOverlayTrack`、`playbackImageOverlays` 和避让后的 `playbackCaptions`
- `GET /overlay-images/<id>` 只读取当前工程已经校验过的图片路径，审查页不能借此读取任意本地文件

## v1 工程迁移

- 读取 `overlays.json` v1 时自动补成 `version: 2` 和空的 `timed_overlays`
- 当前字幕启用状态、位置和样式保持不变
- 下次保存覆盖层时写成 v2
