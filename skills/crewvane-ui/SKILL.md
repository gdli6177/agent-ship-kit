---
name: crewvane-ui
description: Use when changing Crewvane desktop UI: layout, styles, buttons, cards, empty or loading states, settings, attention cards, goal detail surfaces, dialogs, or form fields. Enforces DESIGN.md tokens, shared React primitives, one primary CTA, single focus rings, and light/dark parity.
---

# Crewvane UI

桌面界面只有一套设计语言：`DESIGN.md` 定义 token 与语义，`apps/desktop/src/ui/`
提供绑定 token 的 React 原语。改 UI 前先读这两处，再读
`docs/design/brand-ui.md`；不要凭截图或记忆另起一套样式。

## 强制流程

1. 读 `DESIGN.md` 的 Colors / Typography / Components / Do's and Don'ts。
2. 打开 `apps/desktop/src/ui/index.ts`，优先复用已有原语；缺能力时扩展原语，
   不在页面里写一次性按钮、输入框或卡片。
3. 只使用 token（`--bg`、`--text`、`--accent`、`--fs-body`、`--space-4`、
   `--r-md` 等）或语义 class；颜色、字号、圆角、间距不得出现字面值。
4. 改完跑 `pnpm typecheck`、`pnpm test`；能跑桌面时再跑视觉清单
   （见下方与 `references/checklist.md`）。

## 可用原语

从 `apps/desktop/src/ui/index.ts` 导入：

| 原语 | 用途 | 约束 |
| --- | --- | --- |
| `Button` | 所有动作 | `variant`: `primary` / `secondary` / `danger` / `ghost`；`size`: `sm`(32) / `md`(36)。表单提交显式 `type="submit"`。 |
| `IconButton` | 关闭、工具图标 | 必须有 `label`；用于 32px 图标动作。 |
| `Badge` / `StatusPill` | 状态、计数、标签 | `tone`: `neutral` / `accent` / `mint` / `warm` / `danger`；必须带文字，不能只靠颜色。 |
| `Card` | 分组容器 | `tone`: `surface` / `soft` / `accent` / `mint` / `warm`；`as` 可选 div/section/article。 |
| `SectionHeading` | 区块标题 | 标题 + 可选计数 + 一句说明 + 可选右侧动作；不要重复说明。 |
| `EmptyState` | 空态 | 图标 + 标题 + 一句说明 + 可选动作；`inline` 用于页内清空态。 |
| `LoadingState` | 加载态 | 短句说明正在做什么，不用无限旋转大图标。 |
| `SettingsSection` | 设置页区块 | 图标 + 标题 + 说明 + 内容/动作；宽区块用 `wide`。 |
| `Modal` | 通用弹窗壳 | 已包 Radix Dialog；标题、说明、错误位、关闭按钮统一。 |
| `Field` | 表单字段 | label + hint/error + control；`connect={false}` 用于自定义组合控件。 |
| `TextInput` / `TextArea` / `Select` | 单行、多行、下拉 | 只用这些，不手写 input/select 样式。 |
| `Toggle` | 开关 | 用于单个布尔设置；带标签与说明。 |
| `Checkbox` | 复选 | 用于列表多选或确认；带文字标签。 |

## 允许的 token

- 颜色：`--bg` `--sidebar` `--surface` `--surface-soft` `--surface-hover`
  `--surface-raised` `--text` `--secondary` `--muted` `--line` `--accent`
  `--accent-strong` `--accent-soft` `--on-accent` `--mint` `--mint-soft`
  `--warm` `--warm-soft` `--danger` `--shadow` `--shadow-card`
- 字号/行高：`--fs-caption` `--fs-meta` `--fs-body` `--fs-body-strong`
  `--fs-subtitle` `--fs-title` `--fs-display` `--fs-hero`，以及对应 `--lh-*`
- 间距：`--space-1`(4) `--space-2`(8) `--space-3`(12) `--space-4`(16)
  `--space-5`(20) `--space-6`(24) `--space-8`(32)
- 圆角：`--r-sm`(6) `--r-md`(10) `--r-lg`(14) `--r-xl`(20)，药丸用 `999px`
- 颜色混合只允许 `color-mix(in srgb, var(--token) N%, var(--token))`；
  不要混入字面 hex。

## 禁止

- 引入 Ant Design、MUI、Chakra、Tailwind 或第二套表单/组件库。
- 新增硬编码色值、`font-size: 13px`、`padding: 17px`、一次性阴影或新字体。
- 用 `style={{ color: ... }}` 绕过 token；布局内联样式也应优先换成 class。
- 页面级重复主按钮：同一视区只允许一个 `primary`，其余用 secondary/ghost。
- 双层焦点环：控件自身 `border + box-shadow` 已是单环，不要再给容器加 outline。
- 用 `--muted` 写正文；正文用 `--secondary`，`--muted` 只给时间、计数、说明。
- 用状态色当唯一信号；状态必须同时有文字标签。
- 为单个页面新建 `.foo-bar` 样式；先扩展原语或加语义 class。
- 大重写已落地的 0.5 字号/对比度/焦点环修复。

## 视觉验收

按 `references/checklist.md` 逐项过：

- 深色 + 浅色都看过；标题、正文、元信息分别落在 `--fs-*` 三档。
- 每个页面/弹窗只有一个主 CTA；空态也有明确下一步或明确“无需处理”。
- 键盘 Tab 一圈焦点；输入框、按钮、卡片内动作不叠加双环。
- 4pt 间距节奏；卡片内 16/20，区块间 24/32。
- 状态色与 `DESIGN.md` 语义一致，且始终有文字。
- 窄窗口（≤980px）下设置卡片单列、表单单列、空态动作换行。
- 无新增 hex / px 字号；`git diff` 中样式改动可指到 token 或原语。

## 验证命令

```sh
pnpm typecheck
pnpm test
pnpm --dir apps/desktop exec vite build   # 渲染层打包烟测
```

macOS 上再加 `pnpm test:desktop`；Linux 上该命令不适用，需在报告中注明跳过。
