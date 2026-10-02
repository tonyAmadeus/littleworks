# 安装、配置与移除

## 安装授权

安装者须在真实 Codex Desktop 聊天明确授权启用，安装命令只接受该环境提供的实际 CODEX_THREAD_ID。安装程序通过原生 app-tools 读取该聊天核对身份。分发包不携带开发者的授权、控制窗口或配对。安装并不创建聊天；对方窗口只在后续主动联络且获得创建授权时按需建立。

`setup.cmd install --authorize-dialogue` 启用本机双向聊天，`--allow-create` 额外允许无绑定时新建对方聊天。两端已有及新开窗口在首次明确联络后使用相同规则。没有创建授权时必须指定已存在的目标。

## 配置路径

默认路径由当前用户环境推导。安装时可传以下绝对路径，Windows 路径包含空格时使用引号。

若 node.exe 未加入 PATH 且当前环境未提供 CODEX_MCP_NODE_PATH，可用其完整路径直接执行 `node.exe <分发目录>\setup.cjs doctor`；安装时同样直接执行 setup.cjs，再通过 --node-path 指定后续运行路径。

| 参数 | 用途 |
| --- | --- |
| --state-root | 新安装的私有状态目录 |
| --codex-home | Codex 用户目录，默认 CODEX_HOME 或用户的 .codex |
| --dsh-home | DSH 用户目录，默认 DSH_HOME 或用户的 .dsh |
| --dsh-exe | DeepSeek Harness.exe 的实际安装位置 |
| --node-path | 已有 node.exe 路径 |
| --app-tools-server | 已安装 Codex app-tools 的 server.mjs 路径，默认自动发现 |
| --profile | DSH 当前桌面配置的 cordis.patch.yml，默认 desktop 配置 |

例如，自定义状态目录：

```powershell
& 'D:\Tools\codex-dsh-bridge\setup.cmd' install --authorize-dialogue --allow-create --state-root 'D:\Bridge Data\state'
```

`config.example.json` 仅展示字段，null 表示使用默认值，不包含授权。安装后生成的 bridge.config.json 应留在安装机器。不要将生成的配置、状态或身份复制给别人。

## 安装改动

安装程序新增 Codex 的 `skills/deepseek-harness-bridge`，在两端 AGENTS.md 增加 BEGIN/END CODEX-DSH-BRIDGE 受管段，并在 DSH 配置中增加一个 `mcp-gpt-dialogue` 项。既有文件先备份到状态目录 installation-backups；其他配置原样保留。

已有同名技能、未受管的 GPT 适配器或包含历史绑定的状态目录会阻止安装，避免覆盖其他安装。应保留原组件，先核对其用途；需要全新安装时选择新的状态目录，并按原组件自身入口移除冲突。不要删除锁或改状态来绕过检查。

安装后重启 DSH，新开 Codex 聊天。默认按需启动监听：两端实际发起联系或调用 ensure 时复用或启动共享服务。应用重启会重新核对连接；本版不注册系统开机任务。人类暂停不会因为监听恢复而解除。

## 移除与升级

在分发目录执行 `setup.cmd uninstall`，程序先停止本安装的共享监听和服务，禁用本安装策略，移除自己的受管配置段及技能。状态、备份和桌面聊天保留。停止进程前核对命令行归属；归属不明或监听未确认停止时保留安装并报告错误。重启两款应用后生效。

0.1.0 不提供历史状态跨版本迁移。升级前暂停相关对话并核对待交付结果，移除旧适配后，用新分发目录及新状态目录安装。旧状态留作核验资料，不自动重放。若仍有未知投递，先核对实际接收端，再决定是否发起新的任务。

安装路径应固定，移动后技能链接和 DSH 配置仍指向原位置。优先在原路径移除，再于新路径安装；不要只搬动一个 SKILL.md。
