# 故障排查

先运行 `setup.cmd doctor`，它只检查依赖、配置和本安装监听状态，不自动发送消息。然后在真实 Codex 聊天检查 `channel.cmd status` / `ensure`；DSH 使用 dialogue_status / ensure_listener。诊断输出可能含本机路径，提交给维护者前删去私人路径与聊天数据。

| 现象 | 处理 |
| --- | --- |
| 找不到 Codex app-tools | 在 Codex 安装或恢复该插件；自定义缓存可指定实际 server.mjs |
| DSH 版本不匹配 | 当前仅验证 0.2.0-rc.2；保留数据，先验证适配接口后再更新组件 |
| 普通终端安装被拒 | 回到真实 Codex Desktop 聊天执行，不手动设置 CODEX_THREAD_ID |
| 通道未启用 | 安装用户明确授权后运行安装；其他用户的旧授权不可复用 |
| 新建聊天被拒 | 指定真实目标；自动新建需要安装时的 --allow-create 授权 |
| Dialogue stopped | 在该窗口明确恢复，通过 resume；不能改 registry 或另建窗口绕过 |
| Original body 不匹配 | 检查发送正文是否真的在该 DSH 助手同轮显示，以及真实执行上下文；不要复制其他窗口身份 |
| accepted 后暂未 observed | 对方可能尚未处理，核对实际聊天记录；不要把 accepted 解释为已读 |
| uncertain、超时或服务无响应 | 保留原消息与回执，核对实际对端；不换消息 ID 盲目重发、不删除锁 |
| 同名技能或 GPT 适配器已存在 | 保留现有安装，使用其自身移除入口；新包不会覆盖或接管它 |
| 重启后暂无监听 | 两款应用运行后，在任一端明确启动监听；这是按需启动，不是系统开机任务 |
| 接口权限或登录提示 | 由使用者按原应用流程处理，桥接不代替登录或批准提示 |

状态默认保存在 `%LOCALAPPDATA%\CodexDshBridge\state`，其中 harness-dialogue 是配对及消息账本，harness-event-relay 是监听状态，spool 是对话上下文与回执。日常使用统一入口，勿手工编辑状态。
