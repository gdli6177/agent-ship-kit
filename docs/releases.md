# 安装与 GitHub Releases 交付

版本发布后，从 [GitHub Releases](https://github.com/gdli6177/crewvane/releases)
进入对应版本，在 **Assets** 下载。首版支持 Apple Silicon Mac（arm64）；
Intel Mac、Windows、Linux 安装包尚未提供。未发布的草稿对普通下载者不可见。

| 附件 | 使用方法 |
| --- | --- |
| `Crewvane-<version>-macOS-arm64.dmg` | 打开磁盘映像，将 Crewvane.app 拖入 Applications，然后从“应用程序”打开 |
| `Crewvane-<version>-macOS-arm64.zip` | 解压后，将 Crewvane.app 移入“应用程序” |
| `SHA256SUMS.txt` | 与两个安装包放在同一目录，执行 `shasum -a 256 -c SHA256SUMS.txt` 校验 |

GitHub 自动生成的 **Source code** 是源码，不能当安装包运行。
应用自带 Electron，使用安装包无需安装 Node 或 pnpm。Git 和要派工的 Agent CLI
仍需在本机安装并完成各自的模型登录；Herdr 可在设置中安装。

`v0.3.0` 的 macOS 应用包签名不完整，在另一台 Mac 上可能显示“已损坏，无法打开”，
请改用 `v0.3.1` 或更新版本，不要继续使用旧安装包。`v0.3.1` 起会对主应用、
Electron Helper、Framework 和原生可执行文件完整重签名，并在 ZIP 解压、DMG 安装和
下载隔离属性三种条件下校验签名，再启动两份安装结果检查界面与终端。当前构建仍未进行 Apple Developer ID
签名与公证，因此首次打开可能出现“无法验证开发者”的提示；可在“系统设置 →
隐私与安全性”中查看该提示并选择“仍要打开”。这只针对已核对发布来源及 SHA-256
的 Crewvane 安装包。正式商业发行前应配置 Developer ID、公证，并在另一台 Mac 上
完成首次安装验收。更新时退出应用，再替换 Applications 中的应用；工作区记录仍保存在
用户选定目录。

## 本地制作与验收

在 macOS arm64 上执行：

```sh
pnpm install --frozen-lockfile
pnpm desktop:dist
pnpm test:installers
```

附件输出到 `apps/desktop/release/installers/`。打包复用 `@electron/packager`、
macOS 的 `hdiutil` 与 `ditto`；只装入构建产物和生产依赖。安装包验收检查
SHA-256、磁盘映像、ZIP 解压、DMG 挂载后复制安装，并分别启动两份安装结果，
核对完整代码签名、下载隔离属性、版本、渲染隔离及真实 Shell/PTY 输出。
它无需模型账号；多运行时开发与独立验证另由 `pnpm test:crewvane` 负责。

## 维护者发布步骤

1. PR 的 **Desktop installers** 工作流运行检查、制作附件并试装，结果可在 Actions 下载。
2. 合并且完成真实运行时验收后，人工确认发布版本。根目录和桌面包的版本必须一致。
3. 人工创建并推送与版本完全一致的标签，如 `v0.3.1`。标签推送触发同一套构建与安装验收。
4. 全部通过后，工作流创建附有 DMG、ZIP 和校验文件的 **prerelease 草稿**。
   检查附件、平台、签名状态和发行说明后，再由维护者点击 **Publish release**。
5. 发布后从 Releases 页面实际下载附件，核对校验值并完成首次安装检查。

手动运行工作流只生成 Actions 附件；它不创建标签或公开 Release。
重复运行标签构建只允许更新同版本草稿的附件，拒绝覆盖已经公开的发行版。
工作流不合并 PR，也不自动公开 Release。
