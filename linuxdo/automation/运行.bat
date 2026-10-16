@echo off
chcp 936 >nul
setlocal
set "PYTHONIOENCODING=gbk:replace"
cd /d "%~dp0"

:MAIN
echo.
echo ================================================
echo    LINUX DO 自动化
echo ================================================
echo    1. 跑全部环境（有问题的自动再跑一次）
echo    2. 补跑指定环境
echo    3. 打开指定环境（只开浏览器，不自动点）
echo    4. 关闭全部环境
echo    q. 退出
echo ================================================
echo.
set CH=
set /p CH=请选择（直接回车=1）: 
if "%CH%"=="" set CH=1
if "%CH%"=="1" goto RUNALL
if "%CH%"=="2" goto RERUN
if "%CH%"=="3" goto OPENENV
if "%CH%"=="4" goto CLOSEALL
if /i "%CH%"=="q" goto BYE
echo   输入无效，请重新选
goto MAIN

REM ---------- 1 跑全部环境 ----------
:RUNALL
echo.
echo    1. 逐个启动，最多 9 个（默认）
echo    2. 自己输并发数
echo    3. 返回上一层
echo.
set SUB=
set /p SUB=请选择（直接回车=1）: 
if "%SUB%"=="" set SUB=1
if "%SUB%"=="1" goto RUNALL9
if "%SUB%"=="2" goto RUNALLN
if "%SUB%"=="3" goto MAIN
REM 没有这条兜底的话，输 3 或任何乱码都会掉到下面直接开跑（实测踩过）
echo   输入无效，请重新选
goto RUNALL

:RUNALL9
echo.
echo   开始跑全部环境，逐个启动，最多同时 9 个
echo   首轮结束后自动补跑有问题的环境一次，最后合并两轮汇总
echo   按 P 暂停/恢复（暂停补位，当前环境继续完成），Ctrl+C 中断退出
echo.
py autorun.py --all
goto DONE

:RUNALLN
echo.
echo    5 = 最稳    7 = 折中    9 = 默认
set N=
set /p N=请输入并发数 1-9（直接回车=9）: 
if "%N%"=="" set N=9
echo.
echo   开始跑全部环境，逐个启动，最多同时 %N% 个
echo   首轮结束后自动补跑有问题的环境一次，最后合并两轮汇总
echo.
py autorun.py --all --batch %N%
goto DONE

REM ---------- 2 补跑指定环境 ----------
:RERUN
echo.
echo   编号从日志最前面的『要补跑的环境』那一行复制过来
echo   例子  9,51    或者  6-10    或者  109-117
echo.
set IDS=
set /p IDS=输入环境编号（直接回车=返回菜单）: 
if "%IDS%"=="" goto MAIN
py autorun.py --ids %IDS%
goto DONE

REM ---------- 3 打开指定环境（可连续输入） ----------
:OPENENV
echo.
echo   打开论坛后关闭默认标签页，不自动点论坛按钮
echo   打开后你自己去 登录 / 过验证 / 点日常维护
echo   窗口按固定九宫格排列，超过 9 个循环使用位置
echo   例子  51    或  9,51,74    或  109-117
:OPENLOOP
echo.
set IDS=
set /p IDS=输入环境编号（输 q 回车=返回菜单）: 
if /i "%IDS%"=="q" goto MAIN
if "%IDS%"=="" goto OPENLOOP
py autorun.py --open --ids %IDS%
echo.
echo   --- 这批开完了，可以接着输下一批，或输 q 回菜单 ---
goto OPENLOOP

REM ---------- 4 关闭全部环境 ----------
:CLOSEALL
echo.
py autorun.py --close-all
goto DONE

:DONE
echo.
echo ================================================
echo   完成。日志在这个目录下:
echo      %~dp0log
echo      autorun_log_日期.txt（包含续保编号和条件明细）
echo   汇总在文件最前面，第 1 行就是
echo ================================================
echo.
pause
goto MAIN

:BYE
echo.
echo   已退出。若还有浏览器开着，重新进来选 4 可以全关。
endlocal
