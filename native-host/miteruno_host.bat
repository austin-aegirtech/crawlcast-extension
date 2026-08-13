@echo off
REM Windows launcher for the native messaging host.
REM Chrome cannot execute .py directly, so it runs this wrapper instead.
REM Adjust the path below if your host script lives elsewhere.
python "%~dp0miteruno_host.py"
