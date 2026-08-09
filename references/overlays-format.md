# 覆盖层接口 v1

当前版本只实现普通字幕轨道

`overlays.json` 保存整条字幕轨道的开关、矩形区块和基础样式

局部文字的“大字号、亮颜色”保存在 `effects.json` v3 中，并通过 `target: overlay.captions` 引用这条字幕轨道，因此不会复制或覆盖 `overlays.json` 的坐标和基础样式

## 标准文件

```json
{
  "version": 1,
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
  }
}
```

## 字幕来源

- `project.json` 有 `subtitlePath` 时读取该 UTF-8 SRT
- 没有 `subtitlePath` 时从必需的扁平字级 JSON 自动生成字幕
- SRT 只提供普通字幕分句，字级 JSON 的输入合同保持不变

## 坐标

- `box` 使用相对视频宽高的比例坐标
- `x` 和 `y` 是字幕区域左上角
- `width` 和 `height` 是字幕可用区域
- 四个数都必须在 `0` 到 `1` 之间，字幕区域不能超出画面
- `coordinate_space` 固定为 `screen`，字幕绘制在画面缩放之后

## 当前网页操作

- 字幕关闭时，右侧切换按钮显示“启用”，点击后把 `captions.enabled` 保存为 `true`
- 字幕开启时，同一个按钮显示“撤下”，点击后把 `captions.enabled` 保存为 `false`
- 点击视频内的字幕区块后显示白色矩形边框
- 按住字幕区块拖动可以修改 `box.x` 和 `box.y`
- 按住右下角白色圆形按钮拖动可以修改 `box.width` 和 `box.height`
- 拖动和缩放期间实时预览，松开后立即保存并热重载，不需要再点“保存工程”
- 所有字幕条目共享同一个 `box`，一次移动或缩放会应用到整条字幕轨道
- 网页和服务端都会限制字幕矩形完整位于视频画面内，宽高最小为画面的 `5%`
- 修改后服务端发送热重载事件
- 网页预览和最终渲染读取同一个启用状态和同一组编译字幕
- 选中文字后可以通过平级的“大字号、亮颜色”选项启用局部强调，效果直接切换，无进入或退出过渡
- 局部效果只改变所选文字的字号和颜色，仍然使用全局字幕区块、字体、描边和对齐方式
