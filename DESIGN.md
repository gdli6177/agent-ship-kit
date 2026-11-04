---
version: alpha
name: Crewvane
description: 注意力中心桌面应用的设计语言：深靛蓝工作台、长春花蓝主动作、薄荷绿完成反馈与克制的像素魔法师气质。
colors:
  bg: "#111520"
  sidebar: "#151a26"
  surface: "#1b2130"
  surface-soft: "#222a3a"
  surface-hover: "#252f40"
  surface-raised: "#1b2130"
  text: "#ecf0f8"
  secondary: "#b2bdcf"
  muted: "#8b98ae"
  line: "#2b3546"
  accent: "#a9b8ff"
  accent-strong: "#8398fc"
  accent-soft: "#29324f"
  on-accent: "#182039"
  mint: "#83e4c2"
  mint-soft: "#1f3938"
  warm: "#ebc894"
  warm-soft: "#3d342a"
  danger: "#eda5ad"
typography:
  sans:
    fontFamily: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", sans-serif
spacing:
  xxs: 4px
  xs: 8px
  sm: 12px
  md: 16px
  lg: 20px
  xl: 32px
  xxl: 48px
rounded:
  sm: 6px
  md: 10px
  lg: 14px
  full: 999px
---

## Overview

Crewvane 是 macOS 桌面上运行的注意力中心。用户把事项交给唯一的全局管家，界面只把真正需要人的决定、验收、到期跟进和现场介入抬到前排；其余推进留在后台，不打扰用户。工作台以深靛蓝为底、长春花蓝作主动作与"需要你"的信号、薄荷绿回报完成，配一枚像素魔法师形象，形成克制的像素游戏气质。阅读以单列为主，桌面优先，不做手机布局。

## Colors

颜色是语义，不是装饰：同一个色相永远指向同一类事情。

- `bg` 是窗口与输入区底色，`sidebar` 是左侧导航，`surface` 是卡片与弹窗，`surface-soft` 与 `surface-hover` 承担次级容器和悬停态。层级由这四个明度台阶表达，不靠新颜色。
- `text` 只用于标题、选中项和被强调的值；`secondary` 是正文，`muted` 是时间、计数、说明等元信息。正文不要降到 `muted`。
- `accent` 是唯一的主动作色，同时表示"需要你决定/回复"；`accent-strong` 用于需要更强一档的文字或进度；`accent-soft` 是其可点区域的柔底。
- `mint` 表示完成、已验收、可继续，`mint-soft` 是它的柔底；`warm` 表示等待外部、到点提醒与克制的警示；`danger` 只用于阻塞与破坏性操作。
- `line` 承担全部边框、分隔线与网格纹理；需要强调时改边框色相到 `accent`，而不是另造一个边框色。

## Themes

深色是默认主题，浅色是同位替代而非简单反转：底色抬到近白，`accent`、`mint`、`warm`、`danger` 同步加深以保住对比，柔底改为浅色填充。

| Token | Dark | Light |
| --- | --- | --- |
| bg | #111520 | #f7f8fb |
| sidebar | #151a26 | #f0f2f7 |
| surface | #1b2130 | #ffffff |
| surface-soft | #222a3a | #eef1f7 |
| surface-hover | #252f40 | #eaedf5 |
| text | #ecf0f8 | #252e42 |
| secondary | #b2bdcf | #4a5568 |
| muted | #8b98ae | #626b79 |
| line | #2b3546 | #ccd4e0 |
| accent | #a9b8ff | #4d61bb |
| accent-strong | #8398fc | #435abb |
| accent-soft | #29324f | #e8ecfb |
| on-accent | #182039 | #ffffff |
| mint | #83e4c2 | #24725e |
| mint-soft | #1f3938 | #e2f2eb |
| warm | #ebc894 | #8d5e27 |
| warm-soft | #3d342a | #f7eddf |
| danger | #eda5ad | #a94f5c |

实底按钮统一读取 `on-accent` token：深色下取深靛蓝，浅色下取白色。切主题只改 token 值，组件不需要单独判断主题。

## Typography

- 全站只用一套系统无衬线栈 `sans`：macOS 上落到 SF Pro Text 与 PingFang SC，中英文共用同一套字号与行高节奏，不引入 Web Font 或第二套正文字体。
- 正文、按钮、表单使用同一字号档；说明、计数、时间等比正文再降一档并转 `muted`。层级靠字重与颜色拉开，不靠放大字号。
- 只有页面主标题和弹窗标题放大，其余层级靠字重与颜色区分；放大标题同时收紧字距，分组小标签用加大字距的 `muted` 小字。
- 多行正文行高固定为宽松档，长段落（目标原文、消息、说明）不得压到紧凑行高。

## Layout

- 外壳是两列：左侧固定导航，右侧可滚动主列。导航收起后只剩图标列，主列与浮动的终端面板一起左移，内容不重排。
- 主列单列居中并设最大宽度，页面内边距随窗口收窄逐档减小；不用多列仪表盘承载同类条目。
- 窄窗口做三处收紧：减小页面内边距并收起卡片尾部的文字链接，把侧栏压成图标列并隐藏像素场景，让目标详情弹窗接近全宽、表单转单列。
- 目标详情是覆盖在主列上的宽工作台弹窗，内容单列、滚动区独立，底部操作区固定贴在弹窗底边并带渐隐背景。
- 终端面板从右下角浮出、横跨主列宽度，可展开到全高。外框跟随主题，终端画布在深色与浅色主题下都保持深色，以保住 CLI 的 ANSI 配色可读性；不要给它套浅色底。

## Elevation & Depth

- 层级默认由底色台阶与 `line` 边框表达，卡片不用阴影；只有浮层——终端面板、提示条、目标详情弹窗——使用阴影脱离页面。
- 目标详情弹窗在 `surface` 上叠一层右上角衰减的 `accent-soft` 径向光晕和 `line` 网格纹理，这是唯一装饰性深度处理，其余卡片保持平面。
- 可点击卡片在悬停时轻微上移并加一层淡阴影，移开即回落；静态容器不做悬停抬升。

## Shapes

- 圆角分三档用途：按钮、输入、图标按钮用紧凑圆角；卡片用中档圆角；目标详情弹窗用最大圆角。状态药丸与状态圆点用全圆。
- 形状语言是"平滑圆角界面 + 硬边像素图形"的对比：品牌图形与像素插画按最近邻渲染，截图、照片附件保持平滑缩放，避免图像被锯齿化。
- 图标统一使用描边线性图标，全局同一线宽，局部按层级缩到更小一档；图标与文字同行时按基线居中。

## Components

- 按钮只有两种：`primary` 是 `accent` 实底按钮，深色主题用深靛蓝字、浅色主题用白字，悬停转 `mint`；`secondary` 是 `line` 边框配 `surface` 底的按钮，悬停时边框与文字转 `accent`。同一表单的操作行只出现一个 `primary`。
- 状态药丸把四个语义色映射成"文字色 + 柔底 + 边框"的三件套：需要回复用 `accent`，待验收与完成用 `mint`，等待外用 `warm`，阻塞用 `danger`。药丸始终带文字标签，颜色只是第二信号。
- 注意力卡片整卡可点，左侧图标底色跟随状态 tone，点击进入目标详情；卡片内部不再放独立动作按钮。
- 目标详情底部操作区随状态切换：等你回复给自由文本框，等你验收给"验收通过/退回修改"，等待外部显示"现在不用处理"，需要排障给"打开工作现场"；"管家处理中"不给主按钮。
- 单行、多行、下拉共用 `line` 边框与 `bg` 底，聚焦时边框转 `accent`，键盘聚焦保留可见焦点环。

## Do's and Don'ts

- 用 `accent` 表示"需要你"与主动作，用 `mint` 表示完成与可验收；这两个语义不要互换，深色与浅色里保持同一色相。
- 同一状态在注意力列表、目标列表和详情弹窗中使用同一色调与同一文案。
- Don't 用管理后台式密集表格或数据栅格承载目标与注意力条目。
- Don't 把 Agent 的自然语言拆成结构化信息卡，也不要从正文推断状态、批准或下一步。
