@echo off
echo Starting Build at %TIME% > build_full_log.txt
powershell -ExecutionPolicy Bypass -File build_local_release.ps1 >> build_full_log.txt 2>&1
echo Build Finished at %TIME% >> build_full_log.txt
