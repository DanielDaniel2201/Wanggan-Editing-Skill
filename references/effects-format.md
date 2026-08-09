# 效果接口

## 逐字稿输入

逐字稿根节点必须是数组，数组顺序就是稳定的 `wordIndex`

```json
[
  { "text": "安", "start": 0.16, "end": 0.28 },
  { "text": "全", "start": 0.28, "end": 0.4 }
]
```

要求如下

- `text` 必须是非空字符串
- `start` 和 `end` 必须是秒数
- 必须满足 `0 <= start < end`
- 数组必须按 `start` 递增
- 相邻词语本身不能重叠

## AI 批量输入

根节点使用版本号和 `effects` 数组

```json
{
  "version": 3,
  "effects": [
    {
      "target": "video.main",
      "effect_type": "short_emphasis",
      "start_word_index": 30,
      "end_word_index": 35
    },
    {
      "target": "video.main",
      "effect_type": "long_negative",
      "start_word_index": 60,
      "end_word_index": 82
    }
  ]
}
```

每条效果提交 `target`、`effect_type`、`start_word_index`、`end_word_index`

当前版本不接受 `params`，缩放程度和播放方式由 `effect_type` 固定

`target` 表示效果作用在哪个图层

- `video.main` 是底层主视频
- `overlay.captions` 是 `overlays.json` 定义的普通字幕轨道

## 五种固定效果

| `target` | `effect_type` | 效果 |
|---|---|---|
| `video.main` | `short_emphasis` | 整段无过渡放大到 `120%`，结束时硬切回 `100%` |
| `video.main` | `short_negative` | 整段无过渡缩小到 `75%`，结束时硬切回 `100%` |
| `video.main` | `long_emphasis` | 从 `100%` 按整段字幕时长逐渐放大到 `120%`，结束时硬切回 `100%` |
| `video.main` | `long_negative` | 从 `100%` 按整段字幕时长逐渐缩小到 `75%`，结束时硬切回 `100%` |
| `overlay.captions` | `large_bright` | 所选字幕文字直接变为 `125%` 字号和浅黄色 `#FFF08A`，进入和退出都无过渡 |

长效果在当前时间 `t` 的缩放比例按下面公式计算

```text
progress = (t - start) / (end - start)
scale = 100 + (target_scale - 100) × progress
```

## 标准效果文件

脚本会重新计算 `start`、`end` 和 `text`，不信任模型提交的派生字段

```json
{
  "version": 3,
  "effects": [
    {
      "id": "effect-001",
      "target": "video.main",
      "effect_type": "long_emphasis",
      "start_word_index": 81,
      "end_word_index": 86,
      "start": 12.467,
      "end": 13.967,
      "source": "ai",
      "text": "对应的连续词语",
      "human_modified": false
    }
  ]
}
```

## 兼容旧文件

- 读取 `effects.json` v2 时会根据 `effect_type` 自动补成 `target: video.main`
- 每次重新保存都会写成 v3
- v3 中 `effect_type` 和 `target` 必须匹配

## 校验规则

- `effect_type` 必须是五种固定类型之一
- `start_word_index` 和 `end_word_index` 必须存在并形成连续词语范围
- 提交 `params` 时整批拒绝
- 相邻效果允许首尾相接
- 同一个 `target` 上的两个效果不能重叠
- 不同 `target` 可以使用同一段词语，因此同一段可以同时缩近画面并放大变亮字幕
- 批量导入时只要有一条失败，原 `effects.json` 保持不变
- `start`、`end` 和 `text` 由脚本重新计算

## 本地 HTTP 接口

- `GET /api/state` 获取项目、逐字稿、效果和渲染状态
- `GET /api/events` 接收效果文件热重载事件
- `GET /media` 读取支持 Range 的预览视频
- `POST /api/effects` 增加单条效果
- `PUT /api/effects` 替换全部效果
- `PATCH /api/selection-effects` 一次启用或取消同一选择范围内的一个或多个图层效果
- `PATCH /api/effects/:id` 修改一条效果
- `DELETE /api/effects/:id` 删除一条效果
- `POST /api/render` 在确认后生成最终视频
- `GET /api/render-status` 获取出片状态

`PATCH /api/selection-effects` 示例

```json
{
  "start_word_index": 30,
  "end_word_index": 35,
  "changes": [
    {
      "target": "video.main",
      "effect_type": "short_emphasis",
      "enabled": true
    },
    {
      "target": "overlay.captions",
      "effect_type": "large_bright",
      "enabled": true
    }
  ]
}
```

服务端会在一次写入中完成所有变化，取消字幕效果不会删除同范围的画面效果
