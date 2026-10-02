@echo off
setlocal
if defined CODEX_MCP_NODE_PATH (
  "%CODEX_MCP_NODE_PATH%" "%~dp0channel.cjs" %*
) else (
  node "%~dp0channel.cjs" %*
)
exit /b %errorlevel%
