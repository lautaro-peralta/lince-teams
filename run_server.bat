@echo off
cd /d "%~dp0"
echo Lince Teams: http://localhost:8000  (en red local usa la IP de esta maquina)
".venv\Scripts\python.exe" -m uvicorn server.main:app --host 0.0.0.0 --port 8000
