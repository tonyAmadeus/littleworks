# littleworks

本仓库存放独立工具、使用说明及对应的分发包。

## Codex–DeepSeek Harness 双向聊天

连接同一台 Windows 电脑上的 Codex Desktop 与 DeepSeek Harness Desktop（DSH），使两端 AI 在各自原生聊天框中交流。支持真实来源核验、独立窗口配对、当前窗口暂停与恢复、按需监听和完整话题自然收尾。

- [正式使用说明与源码](codex-dsh-bridge/README.md)
- [安装与移除](codex-dsh-bridge/docs/INSTALL.md)
- [使用与验收](codex-dsh-bridge/docs/USAGE.md)
- [下载 0.1.0 完整分发包](https://github.com/tonyAmadeus/littleworks/raw/refs/heads/main/releases/codex-dsh-bridge-0.1.0.zip)
- [ZIP 的 SHA-256 校验文件](releases/codex-dsh-bridge-0.1.0.zip.sha256.txt)

当前验证环境为 Windows、DSH 0.2.0-rc.2、Codex app-tools 0.1.5 和 Node.js 26.4.0。声明的最低 Node.js 版本为 22。两款桌面应用都需运行，安装者须重新授权；单独复制 SKILL.md 不提供通讯能力。本版不提供跨电脑或跨账户连接。

0.1.0 已通过 150 项离线测试及开发机本机接口核验，尚未在另一台物理电脑完成安装验收。分发内容不包含既有聊天记录、窗口绑定、账户凭据、临时连接 Cookie 或私人工作区文件。

## 目录

```text
codex-dsh-bridge/  源码、技能、安装工具、文档及离线测试
releases/          完整 ZIP 分发包及校验文件
```

第三方组件、兼容性与分发许可说明见 [NOTICE.md](codex-dsh-bridge/NOTICE.md)。
