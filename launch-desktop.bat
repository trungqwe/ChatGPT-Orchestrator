@echo off
title Pipeline Observer & Orchestrator (Desktop App)
echo ======================================================================
echo   Khoi dong Pipeline Observer ^& Orchestrator Desktop Application
echo   (ChatGPT Web 0 Dong Code ^<-^> Antigravity IDE Worker)
echo ======================================================================
echo.

cd /d "%~dp0pipeline-ui"
npm run desktop

if %ERRORLEVEL% neq 0 (
  echo.
  echo [Loi] Khong the khoi dong Desktop App. Ma loi: %ERRORLEVEL%
  pause
)
