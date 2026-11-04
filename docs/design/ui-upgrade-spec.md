# UI 升级方案（0.5.0 已落地）

状态：**已落地并完成打包验收**。A 批缺陷全部修复；B 批完成字号 scale、浅色主题层级与键盘焦点收敛。生产界面继续使用同一套视觉语言，没有引入第二套设计系统。
依据：`DESIGN.md`（基线）、`docs/design/ui-audit.md`（问题台账）、`/tmp/crewvane-ui-audit/after/`（运行时注入得到的 after 对照图）。

## 一、A 批：纯缺陷修复（不改视觉语言，先做）

| # | 位置 | 现状 | 改法 |
| --- | --- | --- | --- |
| A1 | `apps/desktop/src/style.css:56` | `.collapsed .concierge button span` 与 `button > svg` 一起被隐藏，折叠后只剩空白圆角块 | 折叠态保留 svg：只隐藏 `span`，按钮固定 40×40、`padding:0`，补 `aria-label="找管家"` + title |
| A2 | `apps/desktop/src/main.tsx:768` | `需要你处理 <span>{attention.length \|\| ""}</span>` 在 0 时渲染空 span，被 `style.css:160` 的 `min-width:19px` 撑成灰胶囊 | 改成条件渲染 `{attention.length > 0 && <span>…</span>}` |
| A3 | `apps/desktop/src/style.css:41-42`、`:359-360` | 全局 `focus-visible` 用 `outline:2px solid; outline-offset:4px`，与输入框自身 `border`、容器 `:focus-within` 环叠加成双层框 | 统一为单环：控件 `border-color: var(--accent)` + `box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 25%, transparent)`；删掉容器级 `:focus-within` 环，只保留一个焦点来源 |
| A4 | `apps/desktop/src/main.tsx:678-685` / `:888-891` | 顶栏「+ 新目标」与 hero「记录新目标」同权重并存 | 删 hero 那个，保留顶栏；hero 只留标题与计数 |
| A5 | `goalPresentation.ts:87` 与 `GoalActionDock.tsx:138` | hero 副标题与底部操作条都把「成果和检查记录（已经）就绪」写一遍 | 状态文案只由 hero 说一次；操作条只留按钮与「待办/检查项」摘要 |
| A6 | `style.css` 浅色 `--muted #7c879a` | 白底 3.63:1、原 `#f6f7fa` 上 3.39:1，不达 AA，而这类字大量是 10–12px | 改为 `#626b79`；在 surface/fg/hover 三种浅色容器上均 ≥4.5:1 |

验收：折叠态按钮有图标；0 计数不再出现灰块；任一控件获得焦点时只有一圈；目标页只剩一个主 CTA；验收弹窗不重复同一句话。

## 二、B 批：字号与浅色主题（换视觉，A 批验收后单独做）

### 2.1 字号：7 级，消灭 ≤10px

现状是 13 种字号、128 处声明：8px×5、9px×18、10px×35、11px×25、12px×25、13px×12、14px×6、15px×2、19px×2、21px×1、28px×2、31px×1、48px×1。中文在 9–10px 下笔画糊成一团。

新增语义 token（`style.css:1-2` 与 `[data-theme="light"]` 并列）：

```css
--fs-caption: 11px;  --lh-caption: 16px;   /* 极少量元数据、快捷键 */
--fs-meta:    12px;  --lh-meta:    18px;   /* 时间、项目名、状态说明 */
--fs-body:    13px;  --lh-body:    20px;   /* 正文默认 */
--fs-subtitle:15px;  --lh-subtitle:22px;   /* 卡片标题、区块小标题 */
--fs-title:   20px;  --lh-title:   28px;   /* 页面区块标题 */
--fs-display: 30px;  --lh-display: 38px;   /* 页面主标题 */
--fs-hero:    48px;  --lh-hero:    56px;   /* 首页宣言，唯一一处 */
```

迁移映射（按现有值 → 新值，逐条替换，不重排布局）：

| 现有 | 新 | 说明 |
| --- | --- | --- |
| 8 / 9 / 10 | 11 | 元数据统一提到 caption，中文可读下限 |
| 11 | 12 | meta |
| 12 | 13 | body |
| 13 | 14 | 正文偏强调（含列表标题） |
| 14 | 15 | subtitle |
| 15 | 15 | 保持 |
| 19 / 21 | 20 | 区块标题 |
| 28 / 31 | 30 | 页面主标题 |
| 48 | 48 | hero 保持 |

`display` 与 `hero` 加 `letter-spacing: -0.01em`。元信息行（「待分配负责人 · 第 1 轮审查 · 11/4 22:43 更新」）用 `--fs-meta` + `--muted`，不要靠缩到 9px 来表达次要。

### 2.2 浅色主题：补深度与对比度

| token | 现值 | 新值 | 理由 |
| --- | --- | --- | --- |
| `--muted` | `#7c879a` | `#626b79` | 白底 3.63 → **5.39**，`#f7f8fb` 上 5.07，`#eef1f7` 上 4.76 |
| `--line` | `#e2e6ef` | `#ccd4e0` | 边界 1.25 → 1.49，卡片能看见轮廓 |
| `--secondary` | `#54617a` | `#4a5568` | 白底 7.53，正文次级色更稳 |
| `--bg` | `#f6f7fa` | `#f7f8fb` | 与纯白卡片拉开一点 |
| `--surface-soft` | `#f1f3f8` | `#eef1f7` | 与 `--surface-hover` 错开一档 |

浅色语义色同时加深：`accent #4d61bb`、`mint #24725e`、`warm #8d5e27`、`danger #a94f5c`，保证 11px 状态文字在对应柔底上达到 AA。深色 `muted` 提到 `#8b98ae`，在 `surface-soft` 与悬停底色上仍达到 4.5:1。

补两个此前没有的 token，并清掉硬编码：

```css
--shadow-card: 0 1px 2px rgba(24,32,57,.05), 0 10px 28px rgba(24,32,57,.06); /* 浅色用 */
--on-accent: #ffffff;   /* 替代 .primary 在浅色下的 color:#fff 覆盖（style.css:119） */
```

深色主题不加大阴影（会发灰），继续靠 `--line` 与 `--surface-soft` 分层；`--shadow-card` 在深色下设为 `none`。顺带修 C7：`--surface-raised` 被 `.goal-feedback` 引用却从未定义；`.attention-card:hover` 的 `#6474a5`、`electron/main.ts` 的窗口底色 `#10131e` 都应收进 token。

### 2.3 形状与密度

- 圆角三档：`--r-sm: 6px`（输入、小按钮）、`--r-md: 10px`（卡片、弹窗内区块）、`--r-lg: 14px`（模态）；胶囊保留 999。现在 5–22px 混用。
- 间距走 4pt：卡片内边距 16/20，元素 gap 8/12/16，区块之间 32。
- 按钮两档高度：`32px`（行内、工具条）、`36px`（表单提交、弹窗主按钮）；主按钮 `background: var(--accent-strong)` + `color: var(--on-accent)`。
- 次级按钮不再用「描边 + 半透明底」两种叠加，只留描边。

## 三、运行时原型与生产落地

用 CDP 连到打包后的 Electron 渲染层，在页面注入覆盖样式 + 最小 DOM 调整，验证方案效果，产物在 `/tmp/crewvane-ui-audit/after/`：

- `home-light.png`：浅色首页。卡片有柔和投影、次级文字变深、边框可见 —— 从「一张白纸」变成有层级。
- `goals-light.png`：目标列表，主 CTA 只留顶栏一个。
- `goal-review-light.png`：验收弹窗，删掉底部重复状态句。
- `intake-dark.png`：收件弹窗，去掉外层容器环后只剩单层边框。
- `collapsed-dark.png`：折叠侧栏，管家按钮恢复图标。

复跑：`pnpm exec tsx /tmp/crewvane-ui-audit/capture-after.mjs`（脚本内含种子数据、主题切换、注入覆盖；after 图与 `/tmp/crewvane-ui-audit/shots/` 的 before 图同尺寸同页面，可直接对比）。

## 四、落地结果与验收

1. A 批的折叠按钮、空计数、焦点环、重复主 CTA 和重复状态文案均已修复。
2. 字号收敛为 11 / 12 / 13 / 14 / 15 / 20 / 30 / 48 的语义 scale，生产样式不再出现 8–10px 中文。
3. 浅色主题的 `muted`、`line`、`secondary` 与页面底色已调整，主流程辅助文字达到 AA；卡片使用克制投影建立层级。
4. 在打包后的 Electron 应用中重跑 3 种窗口尺寸 × 深浅主题 × 5 个核心界面，共 30 次页面审计组合：对比度、裁切、无名称按钮和小点击目标均为 0；截图保存在桌面试用产物中。
5. `DESIGN.md` 的 token 表已与生产 CSS 同步。完整性由类型检查、桌面 E2E、真实 Herdr、首次安装、真实双目标委派和 DMG/ZIP 安装门禁共同验证。
