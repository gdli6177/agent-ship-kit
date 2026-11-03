# Crewvane 桌面设计验收

## 范围与结论

本次验收覆盖已实现的 Electron 应用，不是静态概念稿。界面采用所选方案 3 的
深蓝灰工作台、蓝色主动作、绿色完成反馈，并补齐浅色主题。主视口为 1485×1058，
窄窗口为 1050×760；Playwright 截图的 device scale factor 为 1，保存像素与视口一致。

当前截图和交互检查未发现剩余 P0/P1/P2 视觉问题。截图验收不等于完整的 WCAG
或辅助技术认证；完整键盘路径、屏幕阅读器和系统级高对比度仍需单独验收。

## 验收步骤

1. **空状态：通过。** 双主题的 `empty-*.png` 显示清晰的首次进入引导；无授权项目时
   新建目标不可提交，空队列与主区域说明保持一致。
2. **新目标：通过。** `new-goal-*.png` 检查项目、目标与验收、工序、执行配置和
   “先沟通方案”选项；主按钮高度至少 40px，复选框可见，遮罩与弹窗在稳定后不透明。
3. **执行中：通过。** `running-*.png` 检查当前工序、独立验证状态、运行时和停止入口；
   状态不仅依靠颜色，还有文字和图标。
4. **等待决定：通过。** `waiting-*.png` 检查船长升级、建议和决定入口；警示使用克制的
   琥珀色，不与完成状态混淆。
5. **已交付：通过。** `completed-*.png` 检查工序结果、独立验证、证据与 PR 操作。
   信息层级、留白、卡片边界和状态色与概念方向一致。
6. **运行时与工序：通过。** `runtimes-*.png` 区分可调度、仅发现、未发现；
   `workflow-*.png` 检查可编辑工序、角色、输入输出和完成标准。
7. **设置与终端：通过。** `settings-herdr-dark.png` 展示 Herdr 检测、可选安装和通信边界；
   `herdr-terminal-*.png` 是真实 Herdr 会话，`shell-terminal-*.png` 包含真实命令输出。
8. **窄窗口：通过。** `narrow-dark.png`、`new-goal-narrow-dark.png` 和
   `settings-narrow-dark.png` 检查 1050×760；文档宽度为 1050px，主内容
   `scrollWidth=700`、`clientWidth=700`，没有横向溢出。

## 本轮修正

- 统一 Radix 与自定义按钮的表面、圆角、hover/active、禁用态和指针。
- 修复新建目标主按钮被压到 20px、复选框布局继承错误的问题。
- 提高浅色辅助文字对比度，调整队列选中态、空态居中和目标控制区；两档次级
  文字与页面背景均按至少 4.5:1 检查。
- 修复终端“后端”标签被挤成竖排；终端外框跟随主题，说明文字不再抢占布局。
- 明确 Shell、runtime CLI 和 Herdr 是观察与接管入口，Agent 协作仍由 Crewvane 协议完成。

## 证据

- [概念稿与实现同尺寸对比](docs/qa/design-qa/reference-comparison.png)
- [Herdr 深浅主题对比](docs/qa/design-qa/terminal-themes.png)
- [全部验收截图](docs/qa/design-qa/)
- [运行记录](docs/qa/design-qa/run.json)

概念稿来源为会话中已选定的方案 3。截图中的任务和项目是本地临时 fixture，不代表
真实交付或已创建的 PR；真实运行时验收另行记录于 PR。

复现需要先构建桌面，并提供本地设计 fixture 路径：

```sh
pnpm desktop:build
CREWVANE_DESIGN_FIXTURE=/path/to/local-fixture pnpm test:design
```

脚本只复制 fixture 到临时目录，不修改源 fixture，不提交截图中的示例目标。

final result: passed
