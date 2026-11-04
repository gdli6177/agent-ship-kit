# Crewvane 品牌标识

已确定的品牌角色是 **Crewvane 像素魔法师**。它是用户的全局管家：不必盯着每一个会话，魔法师会把分散的项目与个人事项整理成清晰的下一步。

- `crewvane-mage-source.png`：使用内置图像生成创建的原始像素魔法师，透明背景。
- `crewvane-mage.png`：供 React 界面使用的 512px 版本，使用 nearest-neighbor 缩放。
- `crewvane-macos-source.png`：内置 ImageGen 基于已确定角色编辑的应用图标原稿，帽子与脸部特写，去除星环、光点与飘带；圆角底板外保留透明留白。
- `crewvane-icon.png`：1024px macOS 专用图标。不要用全身角色图直接铺满方形底板，Dock 中会显得过大且难以辨认。
- `crewvane-icon.icns`：从应用图标生成的 macOS 图标包。

品牌采用像素游戏气质，但不让界面成为难用的复古控制台。任务正文使用系统字体；像素角色、点阵和少量光点负责个性。深靛蓝、长春花蓝与薄荷绿是识别色，状态色保持独立可读。

不得将魔法师拉伸、改成平滑矢量、加上文字或替换为其他概念。此方向已经过多轮评审并确定，后续迭代保持同一角色。

在 macOS 上运行 `node apps/desktop/scripts/build-icons.mjs`，从专用原稿生成 PNG 和含 16–1024px 尺寸的 ICNS。打包器使用 ICNS，开发与正式应用的 Dock 使用同源 PNG。

菜单栏也使用 `crewvane-icon.png`，在运行时生成 18pt 和 Retina 36px 表示，保持彩色原图，不再使用独立的单色占位符 `crewvane-trayTemplate.png`。

原稿编辑提示词要点：保留第一版像素魔法师身份与帽子、暗色脸、奶油色双眼；仅保留帽子和少量肩部，减少细节以适应 32–64px；深靛蓝圆角底板，透明外边距，无文字、星形、星环和长飘带。使用内置 ImageGen 编辑，随后仅做格式与尺寸导出。
