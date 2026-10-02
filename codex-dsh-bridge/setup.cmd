@echo off
setlocal
if defined CODEX_MCP_NODE_PATH (
  "%CODEX_MCP_NODE_PATH%" "%~dp0setup.cjs" %*
) else (
  node "%~dp0setup.cjs" %*
)
exit /b %errorlevel%
