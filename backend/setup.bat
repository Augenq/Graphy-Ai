@echo off
setlocal
cd /d "%~dp0"
if errorlevel 1 goto :error

set "PYTHON="
py -3.12 -c "import sys; sys.exit(sys.version_info < (3, 12))" >nul 2>&1
if not errorlevel 1 set "PYTHON=py -3.12"
if defined PYTHON goto :python_ready
py -3 -c "import sys; sys.exit(sys.version_info < (3, 12))" >nul 2>&1
if not errorlevel 1 set "PYTHON=py -3"
if defined PYTHON goto :python_ready
python -c "import sys; sys.exit(sys.version_info < (3, 12))" >nul 2>&1
if not errorlevel 1 set "PYTHON=python"
if defined PYTHON goto :python_ready
echo Install Python 3.12 or newer with the Python launcher or Add Python to PATH.
goto :error

:python_ready
if not exist ".venv" goto :create_venv
".venv\Scripts\python.exe" -c "import sys; sys.exit(sys.version_info < (3, 12) or sys.prefix == sys.base_prefix)" >nul 2>&1
if not errorlevel 1 goto :install
set "BACKUP=.venv-backup-%RANDOM%-%RANDOM%"
move ".venv" "%BACKUP%" >nul
if errorlevel 1 goto :error
echo Previous environment saved in %BACKUP%.

:create_venv
echo Creating virtual environment...
%PYTHON% -m venv .venv
if errorlevel 1 goto :error

:install
".venv\Scripts\python.exe" -m pip --version >nul 2>&1
if not errorlevel 1 goto :dependencies
".venv\Scripts\python.exe" -m ensurepip --upgrade
if errorlevel 1 goto :error

:dependencies
echo Installing dependencies...
".venv\Scripts\python.exe" -m pip install -e . -c requirements.lock
if errorlevel 1 goto :error
echo.
echo Setup complete. The app normally starts the agent itself (npm run dev / npm run web in the project root).
echo Server only, without an interface:
echo.
echo   .venv\Scripts\python.exe -m graphy serve
exit /b 0

:error
echo.
echo Setup failed. Check the error above and run setup.bat again.
exit /b 1
