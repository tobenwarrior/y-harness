@echo off
setlocal DisableDelayedExpansion
set "ELECTRON_RUN_AS_NODE=1"
set "entry=%~dp0..\..\..\app.asar\dsh\node_modules\@yharness\desktop-host\lib\cli.js"
if not exist "%entry%" set "entry=%~dp0..\..\..\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js"
"%~dp0..\..\..\..\Y harness.exe" --expose-internals "%entry%" %*
exit /b %errorlevel%
