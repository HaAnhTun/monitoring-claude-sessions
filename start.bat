@echo off
rem start.bat: start the Claude Agent Workspace app (a hidden background server) and open it in the browser.
rem Extra arguments go to `caw start` (--no-open, --window, --tab, --print, --port N). CAW_NO_PROMPT=1 never pauses.
setlocal
cd /d "%~dp0"
rem ---- find node (identical in start.bat, stop.bat, install-skill.bat)
set "CAW_NODE="
if defined CAW_NODE_PATH if exist "%CAW_NODE_PATH%" set "CAW_NODE=%CAW_NODE_PATH%"
if not defined CAW_NODE for /f "delims=" %%N in ('where node.exe 2^>nul') do if not defined CAW_NODE set "CAW_NODE=%%N"
if not defined CAW_NODE if exist "%ProgramFiles%\nodejs\node.exe" set "CAW_NODE=%ProgramFiles%\nodejs\node.exe"
if not defined CAW_NODE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "CAW_NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined CAW_NODE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "CAW_NODE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined CAW_NODE goto :no_node
rem ---- find the launcher (identical in start.bat and stop.bat)
set "CAW_LAUNCHER="
for /d %%D in ("%~dp0skills\*") do if exist "%%~fD\scripts\caw.mjs" if not defined CAW_LAUNCHER set "CAW_LAUNCHER=%%~fD\scripts\caw.mjs"
if not defined CAW_LAUNCHER goto :no_launcher
"%CAW_NODE%" "%CAW_LAUNCHER%" start %*
if errorlevel 1 goto :failed
exit /b 0
:failed
if not defined CAW_NO_PROMPT pause
exit /b 1
:no_node
echo Node.js 22.22 or newer was not found. Install the Node 24 LTS from https://nodejs.org/ and run this file again.
if not defined CAW_NO_PROMPT pause
exit /b 1
:no_launcher
echo The caw launcher was not found under "%~dp0skills".
if not defined CAW_NO_PROMPT pause
exit /b 1
