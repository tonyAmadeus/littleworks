@echo off
setlocal
if defined CODEX_MCP_NODE_PATH (
  "%CODEX_MCP_NODE_PATH%" "%~dp0run-channel.cjs" %*
) else (
  node "%~dp0run-channel.cjs" %*
)
exit /b %errorlevel%
