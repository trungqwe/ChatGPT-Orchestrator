@echo off
setlocal enabledelayedexpansion
title Push to GitHub - ChatGPT-Orchestrator
echo ======================================================================
echo   Day ma nguon len GitHub: https://github.com/trungqwe/ChatGPT-Orchestrator
echo ======================================================================
echo.

cd /d "%~dp0"

REM Kiem tra git da khoi tao chua
if not exist ".git" (
  echo [Info] Khoi tao Git repository...
  git init
  git remote add origin https://github.com/trungqwe/ChatGPT-Orchestrator.git
  git branch -M main
)

REM Kiem tra remote origin
git remote get-url origin >nul 2>&1
if %ERRORLEVEL% neq 0 (
  echo [Info] Them remote origin...
  git remote add origin https://github.com/trungqwe/ChatGPT-Orchestrator.git
)

REM Lay commit message tu tham so hoac dung mac dinh
set "COMMIT_MSG=%*"
if "%COMMIT_MSG%"=="" (
  for /f "tokens=1-3 delims=/ " %%a in ("%date%") do set "D=%%a-%%b-%%c"
  for /f "tokens=1-2 delims=: " %%a in ("%time%") do set "T=%%a:%%b"
  set "COMMIT_MSG=chore: cap nhat ma nguon phien lam viec (!D! !T!)"
)

echo [1/3] Adding files to git stage...
git add -A

echo [2/3] Checking status & committing...
git status --short

git diff --cached --quiet
if %ERRORLEVEL% equ 0 (
  echo.
  echo [Notice] Khong co thay doi moi can commit.
) else (
  git commit -m "%COMMIT_MSG%"
)

echo.
echo [3/3] Pushing to origin main...
git push -u origin main

if %ERRORLEVEL% equ 0 (
  echo.
  echo ======================================================================
  echo   [SUCCESS] Da day thanh cong ma nguon len GitHub!
  echo   URL: https://github.com/trungqwe/ChatGPT-Orchestrator
  echo ======================================================================
) else (
  echo.
  echo [ERROR] Day len GitHub that bai. Ma loi: %ERRORLEVEL%
)

echo.
pause
