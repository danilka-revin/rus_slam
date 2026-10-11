@echo off
setlocal
cd /d "%~dp0"

where py >nul 2>nul
if errorlevel 1 (
  echo Python Launcher not found. Install Python 3.10+ with Tcl/Tk support.
  exit /b 1
)

if not exist ".build-venv\Scripts\python.exe" (
  py -3 -m venv .build-venv
  if errorlevel 1 exit /b 1
)

call ".build-venv\Scripts\activate.bat"
python -m pip install --upgrade pip
if errorlevel 1 exit /b 1
python -m pip install -r requirements-native-display.txt
if errorlevel 1 exit /b 1

python -m PyInstaller --clean --noconfirm --onefile --windowed ^
  --name RUS-SLAM-Display ^
  --distpath dist --workpath build\native --specpath build\native ^
  native_display.py
if errorlevel 1 exit /b 1

echo.
echo Built: %~dp0dist\RUS-SLAM-Display.exe
echo Run with: RUS-SLAM-Display.exe --url http://ROBOT-IP:8080
endlocal
