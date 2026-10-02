# 安装与诊断

使用完整 codex-dsh-bridge 分发包，单独复制 SKILL.md 不提供通信能力。安装用户须在同一 Windows 账户下打开 Codex Desktop 和 DSH Desktop。当前经过验证的 DSH 为 0.2.0-rc.2；需要 Codex app-tools 插件和 Node.js 22 以上。

在分发包目录执行 `setup.cmd plan` 或 `setup.cmd doctor` 只做本机检查。用户明确要求安装启用后，必须在真实 Codex 聊天里运行 `setup.cmd install --authorize-dialogue`；用户同时授权无绑定自动新建窗口时加 `--allow-create`。安装将增加 Codex 技能、两端 AGENTS 的受管段和 DSH 的单个 MCP 适配项，不覆盖模型及人格设置。

重启 DSH，并新开 Codex 聊天载入技能。两款应用运行后，可从任一端明确联络来按需检查启动监听。重启后不需要复制会话 ID；人工暂停仍须人类恢复。完整安装、升级、移除与兼容边界见分发包 README.md 和 docs/INSTALL.md。

默认状态目录为 `%LOCALAPPDATA%\CodexDshBridge\state`。路径自定义使用安装参数；不把其他用户的状态目录、credentials、日志或注册会话复制过来。未知投递需先核对实际对端记录；不要删除回执、锁或改状态来重试。
