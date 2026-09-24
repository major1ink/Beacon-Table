#!/usr/bin/env python3
"""Значок трея для строки меню macOS: cmd/beacon-table/desktop_tray_mac.png.

Строка меню macOS красит значки сама под светлую и тёмную тему — значок
должен быть шаблоном: чёрный силуэт на прозрачном, значима только
прозрачность. Цветная иконка там выглядит чужой. Силуэт — маяк из
web/public/favicon.svg (сетка 64×64), без мелочей, которые в 22 пунктах
превращаются в пятна: нижних бледных лучей и заливок.

Запуск: python3 packaging/macos/tray-icon.py (нужен Pillow).
"""
from pathlib import Path

from PIL import Image, ImageDraw

SIZE = 64   # итог; Wails растягивает под высоту строки меню
SS = 8      # сглаживание: рисуем крупно, потом уменьшаем


def s(*pts):
    return [(x * SS, y * SS) for x, y in pts]


img = Image.new("L", (SIZE * SS, SIZE * SS), 0)  # альфа-канал
d = ImageDraw.Draw(img)

# лучи — полупрозрачные, чтобы маяк не спорил с ними за вес
for a, b in [((13, 7), (26, 18)), ((51, 7), (38, 18))]:
    d.line(s(a, b), fill=170, width=int(3.6 * SS))
    for p in (a, b):
        r = 1.8 * SS
        d.ellipse((p[0] * SS - r, p[1] * SS - r, p[0] * SS + r, p[1] * SS + r), fill=170)

d.polygon(s((32, 7), (25, 15), (39, 15)), fill=255)                                    # крыша
d.polygon(s((42, 25), (32, 30.5), (22, 25), (22, 17.5), (32, 12), (42, 17.5)), fill=255)  # фонарь
# окно фонаря — вырезом: без него в 22 пунктах крыша с фонарём сливаются
# в ком, и маяк читается как шахматная пешка
d.rectangle((26.5 * SS, 18.5 * SS, 37.5 * SS, 24.5 * SS), fill=0)
d.rounded_rectangle((19.5 * SS, 29.5 * SS, 44.5 * SS, 33.5 * SS), radius=1.4 * SS, fill=255)  # галерея
d.polygon(s((24, 33.5), (40, 33.5), (46.5, 54), (17.5, 54)), fill=255)                 # башня
for y, x0, x1 in [(41, 25.5, 38.5), (48, 23, 41)]:                                     # полосы — вырезом
    d.line(s((x0, y), (x1, y)), fill=0, width=int(2.2 * SS))
d.rounded_rectangle((14 * SS, 53.5 * SS, 50 * SS, 57.5 * SS), radius=2 * SS, fill=255)  # основание

alpha = img.resize((SIZE, SIZE), Image.LANCZOS)
out = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
out.putalpha(alpha)
dst = Path(__file__).resolve().parents[2] / "cmd/beacon-table/desktop_tray_mac.png"
out.save(dst, optimize=True)
print(dst)
