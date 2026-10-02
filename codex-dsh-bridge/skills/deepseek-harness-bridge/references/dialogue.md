# 对话操作

所有命令从本技能 scripts/channel.cmd 执行。

| 命令 | 用途 |
| --- | --- |
| ensure | 检查并按需启动唯一共享监听，不恢复人工暂停 |
| open [--dsh-session ID] [--title 标题] | 选择本窗目标；未绑定且已授权创建时新建 DSH 聊天 |
| bind --dsh-session ID | 人类明确要求时绑定或改绑，不抢占其他配对 |
| inbox [--message-id ID] | 读取实际本窗收到的 DSH 发言与后台父消息 |
| ack --message-id ID | 只由实际接收 Codex 窗口标记已读，不发确认消息 |
| prepare-reply --text 正文 [--reply-to ID] | 准备隐藏关联；随后实际显示同一完整正文一次 |
| prepare-reply --body-file 文件 [--reply-to ID] | 用 UTF-8 纯文本准备多行正文；不需要请求 JSON |
| prepare-reply … --finish propose/accept/reject | 自然收尾提议、接受或指出遗漏 |
| stop [--conversation ID] | 人类暂停当前窗口选中配对，保留监听和绑定 |
| resume [--conversation ID] | 人类明确恢复该配对，跳过暂停期间历史 |
| status [--conversation ID] [--message-id ID] | 只读当前窗口配对或实际消息回执 |

DSH 使用原生六个工具：send_to_gpt、bind_dialogue、resume_dialogue、stop_dialogue、ensure_listener、dialogue_status。真实来源由 DSH 执行器携带，模型不能填入另一个来源窗口。首次主动发送先显示正文再调用一次；已配对窗口的正常最终回复由监听自动转发，同轮不重复调用发送。自然收尾通过 send_to_gpt 的隐藏 finish_action 显式发送一次并去重。

回复始终由 reply_to 回原消息的实际来源窗口。主动发送依次使用指定目标、当前窗口登记配对、安装授权的新聊天。多配对通过实际目标或 conversation 参数选择，接收回执不会抢占当前选择。
