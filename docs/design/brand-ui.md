# 品牌 UI 原则与原语入口

状态：0.6 桌面 UI 专业化的落地说明。视觉基线仍是 `DESIGN.md`，本文只解释
这次为什么这样收敛，以及后续 agent 从哪里改。

## 方向

Crewvane 的品牌不是“更花”，而是“更少打扰、更可核对”。界面只抬升真正需要人的
决定、验收、到期跟进和现场介入；其余推进留在后台。对应的 UI 判断：

1. **先回答状态，再给动作**：页面标题/首句说明“现在需不需要你”，需要时只留一个主 CTA。
2. **层级来自 token**：标题、正文、元信息严格落在 `--fs-title` / `--fs-body` /
   `--fs-caption` 等语义档；正文不用 `--muted`，减少“灰一片”。
3. **状态是第二信号**：`accent`、`mint`、`warm`、`danger` 必须和文字标签同时出现。
4. **4pt 呼吸**：卡片内 16/20，区块间 24/32；设置项不再用密集表单堆叠。
5. **像素只留给品牌图形**：界面控件保持平滑圆角与线性图标，像素画按最近邻渲染。

## 原语入口

`apps/desktop/src/ui/index.ts`：

- `Button` / `IconButton`：primary / secondary / danger / ghost，高度 32 / 36。
- `Badge` / `StatusPill`：neutral / accent / mint / warm / danger，始终带文字。
- `Card` / `SettingsSection` / `SectionHeading`：分组、标题、说明与右侧动作。
- `EmptyState` / `LoadingState`：空态与加载态的统一语气和布局。
- `Modal`：Radix Dialog 的统一壳，含标题、说明、错误位与关闭按钮。
- `Field` + `TextInput` / `TextArea` / `Select` / `Toggle` / `Checkbox`：标签、说明、
  错误态与控件对齐统一；不引入独立表单组件库。

## 本次落地

- 注意力首页：标题层级与注意力卡片间距收紧；空态改为品牌语气的一句话 + 状态汇总。
- 目标列表：空态提供“记录第一个目标”的次按钮，避免和顶栏 primary 重复。
- 设置页：从扁平 `.setting` 行改为 `SettingsSection` 卡片分组；Herdr、CLI、Skills、
  工作区、通知、外观各自有标题、说明和左对齐动作。
- 表单：新建目标、编辑目标、提交成果、项目、Webhook 全部改用 `Field` 与输入原语；
  Webhook 启用改为 `Toggle`，状态订阅改为 `Checkbox`。
- 目标操作：底部操作条与详情管理动作改用 `Button`，状态药丸改用 `StatusPill`。

## 验收

```sh
pnpm typecheck
pnpm test
pnpm --dir apps/desktop exec vite build
```

视觉检查见 `skills/crewvane-ui/references/checklist.md`：深/浅主题、单一主 CTA、
单焦点环、4pt 间距、窄窗口单列。macOS 上补 `pnpm test:desktop`；Linux 环境跳过并注明。
