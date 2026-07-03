@echo off
cd /d "%~dp0"
echo Creating virtual environment...
python -m venv .venv || exit /b 1
echo Installing dependencies...
".venv\Scripts\python.exe" -m pip install --upgrade pip
".venv\Scripts\python.exe" -m pip install -r requirements.txt || exit /b 1
echo.
echo Done. Run run.bat to start dictating.
