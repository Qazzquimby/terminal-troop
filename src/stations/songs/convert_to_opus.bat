```bat
@echo off
setlocal

REM Folder to process (defaults to the folder containing this BAT file)
set "INPUT=%~1"
if "%INPUT%"=="" set "INPUT=%~dp0"

REM Output folder
set "OUTPUT=%INPUT%\Opus_32k"
if not exist "%OUTPUT%" mkdir "%OUTPUT%"

echo.
echo Converting audio files to 32 kbps Opus...
echo Input:  %INPUT%
echo Output: %OUTPUT%
echo.

for %%F in ("%INPUT%\*") do (
    if exist "%%~fF" (
        if /I not "%%~xF"==".opus" (
            if /I not "%%~xF"==".bat" (
                echo Processing: %%~nxF

                ffmpeg -hide_banner -loglevel error -n -i "%%~fF" -vn -c:a libopus -b:a 32k -vbr on "%OUTPUT%\%%~nF.opus"

                if errorlevel 1 (
                    echo FAILED: %%~nxF
                )
            )
        )
    )
)

echo.
echo Conversion complete!
pause
```