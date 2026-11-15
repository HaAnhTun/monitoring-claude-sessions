@echo off
rem install-skill.bat: install the skill of this checkout into your Claude Code skills folder (node install.mjs --force).
rem Extra arguments go to install.mjs (--project DIR, --dest DIR, --dry-run). CAW_NO_PROMPT=1 never pauses or asks.
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
if not exist "%~dp0install.mjs" goto :no_installer
rem a running app maps its terminal files, so the old skill folder cannot be replaced: say so before the installer runs
set "CAW_HOME_DIR=%MCS_HOME%"
if not defined CAW_HOME_DIR set "CAW_HOME_DIR=%LOCALAPPDATA%\mcs"
if exist "%CAW_HOME_DIR%\instances\user\state.json" echo The app seems to be running: stop the app first (caw stop; terminals end), then run this file again.
"%CAW_NODE%" "%~dp0install.mjs" --force %*
if errorlevel 1 goto :failed
echo.
echo The skill is installed.
rem the offer of caw.cmd (06 A7): only for a plain install, never without a person to ask
if not "%~1"=="" goto :done
if defined CAW_NO_PROMPT goto :done
set "CAW_SKILL_NAME="
for /d %%D in ("%~dp0skills\*") do if exist "%%~fD\scripts\caw.mjs" if not defined CAW_SKILL_NAME set "CAW_SKILL_NAME=%%~nxD"
if not defined CAW_SKILL_NAME goto :done
set "CAW_SKILLS_DIR=%CLAUDE_CONFIG_DIR%"
if not defined CAW_SKILLS_DIR set "CAW_SKILLS_DIR=%USERPROFILE%\.claude"
set "CAW_INSTALLED=%CAW_SKILLS_DIR%\skills\%CAW_SKILL_NAME%\scripts\caw.mjs"
if not exist "%CAW_INSTALLED%" goto :done
set "CAW_APPS_DIR=%LOCALAPPDATA%\Microsoft\WindowsApps"
if not exist "%CAW_APPS_DIR%\" goto :done
choice /c YN /n /m "Write caw.cmd into %CAW_APPS_DIR% so that you can type caw in any terminal? (no PATH change) [Y/N] "
if errorlevel 2 goto :done
>"%CAW_APPS_DIR%\caw.cmd" echo @"%CAW_NODE%" "%CAW_INSTALLED%" %%*
if errorlevel 1 goto :cmd_failed
echo Wrote %CAW_APPS_DIR%\caw.cmd
goto :done
:cmd_failed
echo Could not write %CAW_APPS_DIR%\caw.cmd. Run the skill with: node "%CAW_INSTALLED%" ^<command^>
:done
if not defined CAW_NO_PROMPT pause
exit /b 0
:failed
if not defined CAW_NO_PROMPT pause
exit /b 1
:no_node
echo Node.js 22.22 or newer was not found. Install the Node 24 LTS from https://nodejs.org/ and run this file again.
if not defined CAW_NO_PROMPT pause
exit /b 1
:no_installer
echo install.mjs was not found next to this file.
if not defined CAW_NO_PROMPT pause
exit /b 1
