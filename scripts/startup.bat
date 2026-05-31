@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0.."

if "%1"=="" (
    echo 用法: startup.bat [enable^|disable^|status]
    echo.
    echo   enable  - 启用开机自启动
    echo   disable - 禁用开机自启动
    echo   status  - 查看当前状态
    echo.
    set /p choice="请选择操作 (enable/disable/status): "
) else (
    set choice=%1
)

powershell -ExecutionPolicy Bypass -File "%~dp0startup.ps1" %choice%
pause
