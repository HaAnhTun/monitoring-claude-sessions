@echo off
rem stop.bat: stop the Claude Agent Workspace app. With live terminal sessions it asks before it ends them.
rem Extra arguments go to `caw stop` (--timeout-ms MS). CAW_NO_PROMPT=1 never pauses or asks: live terminals then exit 3.
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
"%CAW_NODE%" "%CAW_LAUNCHER%" stop %*
set "CAW_RC=%ERRORLEVEL%"
if "%CAW_RC%"=="0" exit /b 0
if "%CAW_RC%"=="3" goto :live
goto :failed
:live
if defined CAW_NO_PROMPT exit /b 3
choice /c YN /n /m "Terminal sessions are live. Stop anyway and end them? [Y/N] "
if errorlevel 2 exit /b 3
"%CAW_NODE%" "%CAW_LAUNCHER%" stop --force %*
set "CAW_RC=%ERRORLEVEL%"
if "%CAW_RC%"=="0" exit /b 0
goto :failed
:failed
if not defined CAW_NO_PROMPT pause
exit /b %CAW_RC%
:no_node
echo Node.js 22.22 or newer was not found. Install the Node 24 LTS from https://nodejs.org/ and run this file again.
if not defined CAW_NO_PROMPT pause
exit /b 1
:no_launcher
echo The caw launcher was not found under "%~dp0skills".
if not defined CAW_NO_PROMPT pause
exit /b 1
