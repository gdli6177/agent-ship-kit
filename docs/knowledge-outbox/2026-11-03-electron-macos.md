---
id: "agent-ship-kit-20261103-electron-macos"
created: "2026-11-03"
project: "agent-ship-kit"
type: "method"
source_paths:
  - "apps/desktop/package.mjs"
  - "scripts/installer-smoke.mjs"
  - ".github/workflows/desktop-release.yml"
  - "docs/releases.md"
suggested_target: "wiki/methods/macos-electron-release-signing-and-verification.md"
---

# Electron macOS 发布必须完整重签名并验证下载隔离安装

## Conclusion

Electron Packager 修改应用内容后会保留 linker ad-hoc 签名但不生成完整 CodeResources；发布前必须使用 osx-sign 从内到外重签 Helper、Framework、原生模块和主应用，并在 ZIP、DMG 与下载隔离属性场景执行严格 codesign 和真实启动验收。无 Developer ID 时使用完整 ad-hoc 签名且不要让 hardened runtime 与环境 Entitlements 造成 Helper 与 Framework 的 Team ID 不一致。

## Evidence

v0.3.0 的 codesign --deep --strict 报 code has no resources but signature indicates they must be present，另一台 Mac 显示已损坏；v0.3.1 的 ZIP 与 DMG 均通过 SHA-256、quarantine 下严格签名、启动、renderer 隔离与 PTY 验收，PR #22 和 tag workflow 均通过。

## Applicability

适用于 Electron macOS 分发打包与发布验收，尤其是没有 Apple Developer ID 的内测或开源构建；正式分发仍应使用 Developer ID、notarization 与 staple。

## Uncertainty

Confirmed：签名与安装验收已实测；Stale Risk：macOS Gatekeeper 和 Electron signing 默认行为可能随版本变化。
