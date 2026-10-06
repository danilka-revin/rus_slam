#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
serve.py — совместимый запуск экранов RUS SLAM.

Весь сервер (статика + API + замок + источники данных) живёт в backend.py;
этот файл оставлен, чтобы прежние команды и ярлыки продолжали работать:
    python3 gui/serve.py --kiosk   ==   python3 gui/backend.py --kiosk
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from backend import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())
