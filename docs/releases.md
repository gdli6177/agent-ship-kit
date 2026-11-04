# 安装与 GitHub Releases 交付

版本发布后，从 [GitHub Releases](https://github.com/gdli6177/crewvane/releases) 进入对应版本，在 **Assets** 下载。当前只支持 Apple Silicon Mac（arm64），不提供 Intel Mac、Windows 或 Linux 安装包。

| 附件 | 使用方法 |
| --- | --- |
| `Crewvane-<version>-macOS-arm64.dmg` | 打开磁盘映像，将 Crewvane.app 拖入 Applications，然后从“应用程序”打开 |
| `Crewvane-<version>-macOS-arm64.zip` | 解压后将 Crewvane.app 移入“应用程序” |
| `SHA256SUMS.txt` | 执行 `shasum -a 256 -c SHA256SUMS.txt` 核对安装附件 |

GitHub 自动生成的 **Source code** 是源码，不是可安装应用。安装包自带 Electron、CLI runtime 和经 SHA-256 校验的 Herdr TUI CLI，无需安装 Node、pnpm 或 Homebrew。Agent CLI 仍由用户自行安装和登录。

当前包没有 Apple Developer ID 签名与公证，首次打开可能出现“无法验证开发者”。核对发布来源与 SHA-256 后，可在“系统设置 → 隐私与安全性”选择“仍要打开”。如果出现“已损坏，无法打开”，不要清除隔离属性绕过；重新下载当前版本并联系维护者。`v0.3.0` 的签名不完整，不应继续使用。

安装替换应用后，打开设置重新安装 Crewvane CLI，确保 `~/.local/bin/crewvane` 指向当前应用。工作区位于用户选择的目录，不会被覆盖。

## 本地制作与验收

在 macOS arm64 上执行：

```sh
pnpm install --frozen-lockfile
pnpm desktop:dist
pnpm test:installers
```

附件输出到 `apps/desktop/release/installers/`。验收会核对 SHA-256、磁盘映像、ZIP 解压、DMG 复制、完整代码签名和下载隔离属性，然后启动两种安装结果，确认新界面、renderer 隔离、图标元数据，并安装包内 CLI 实际创建目标。它不需要模型账号；Herdr 闭环另由桌面 E2E 与真实隔离 Session 试用覆盖。

## 维护者发布步骤

1. PR 的 **Desktop installers** 工作流执行类型检查、测试、打包与安装验收。
2. 合并前确认真实试用记录和所有未解决风险。
3. 根目录和桌面包版本一致后，创建并推送完全匹配的标签，例如 `v0.5.0`。
4. 标签工作流重跑验收，再创建包含 DMG、ZIP、SHA256SUMS 和说明的 prerelease 草稿。
5. 检查附件与说明后发布。发布后真实下载所有附件，核对 SHA-256，并在一台独立 Mac 上启动应用和安装 CLI。

标签工作流不合并 PR，也不自动公开 Release。
