@echo off
setlocal
if not defined PROOF_READER_PORT set "PROOF_READER_PORT=8794"
start "" "%~dp0desktop\Naoma.exe"
