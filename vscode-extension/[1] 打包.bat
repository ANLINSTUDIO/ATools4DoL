@echo off
chcp 936 >nul
setlocal
cd /d "%~dp0"

echo.
echo  ==========================================
echo    ATools4DoL 扩展打包（生成 .vsix）
echo  ==========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo  [错误] 没找到 node，请先安装 Node.js 并加入 PATH
  echo.
  pause
  exit /b 1
)

echo  正在打包……（首次运行会自动下载 vsce，需要联网，可能要等一会儿）
echo.

call npx --yes @vscode/vsce package --allow-missing-repository --skip-license
if errorlevel 1 goto fail

echo.
echo  打包完成，生成的安装包：
dir /b atools4dol-*.vsix
echo.
pause
exit /b 0

:fail
echo.
echo  [失败] 打包出错，请查看上面的日志。
echo  - 若因首次运行且无网络：请联网后重试，或先执行  npm i -g @vscode/vsce
echo.
pause
exit /b 1