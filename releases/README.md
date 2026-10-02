# 分发包

| 版本 | 下载 | 校验 |
| --- | --- | --- |
| 0.1.0 | [codex-dsh-bridge-0.1.0.zip](https://github.com/tonyAmadeus/littleworks/raw/refs/heads/main/releases/codex-dsh-bridge-0.1.0.zip) | [SHA-256](codex-dsh-bridge-0.1.0.zip.sha256.txt) |

ZIP 包含完整目录结构，解压后先阅读 README.md。安装条件、授权入口与实际通讯验收见 [正式使用说明](../codex-dsh-bridge/README.md)。无需 npm install。

Windows 可用 `Get-FileHash -Algorithm SHA256 -LiteralPath .\codex-dsh-bridge-0.1.0.zip` 计算下载文件校验值，再与对应校验文件比较。包内 MANIFEST.json 列出各发布文件的 SHA-256。校验值用于内容一致性检查，不是数字签名。
