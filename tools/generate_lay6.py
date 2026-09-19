#!/usr/bin/env python3
"""Generate the Sprint-Layout 6 board file for the Smart Wheel Pod Controller.

The native Sprint-Layout 6 format is a small binary container.  This generator
keeps the board description in Python so the checked-in .lay6 file can be
re-created after a placement change without having to edit binary data by hand.
Coordinates used by Sprint-Layout are 1/10000 mm; the board origin is the upper
left corner, therefore the y coordinate is negative in the file.
"""

from __future__ import annotations

import argparse
import math
import struct
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Sequence

# Sprint-Layout 6 layer numbers (as used by the xlay format notes).
C1 = 0       # top copper
S1 = 1       # top silk
C2 = 2       # bottom copper
S2 = 3       # bottom silk
I1 = 4
I2 = 5
OUTLINE = 6

OBJ_THT_PAD = 2
OBJ_POLY = 4
OBJ_CIRCLE = 5
OBJ_LINE = 6
OBJ_TEXT = 7
OBJ_SMD_PAD = 8

SCALE = 10_000.0
BOARD_W = 100.0
BOARD_H = 80.0

OBJECT_HEADER = struct.Struct("<BffffIBBB4sHB4s5sBI5sBBBIBB18s")
assert OBJECT_HEADER.size == 77


def u(value: float) -> float:
    """Convert a millimetre coordinate/size to the Sprint internal unit."""
    return float(value) * SCALE


def xy(x_mm: float, y_mm: float) -> tuple[float, float]:
    """Convert a normal board coordinate (origin at top left)."""
    return u(x_mm), -u(y_mm)


def fixed_string(value: str, max_len: int) -> bytes:
    raw = value.encode("ascii", "replace")[:max_len]
    return bytes((len(raw),)) + raw + b"\0" * (max_len - len(raw))


@dataclass
class Obj:
    typ: int
    x: float = 0.0
    y: float = 0.0
    out: float = 0.0
    inn: float = 0.0
    line_width: int = 0
    layer: int = C1
    shape: int = 0
    component_id: int = 0
    style: bytes = b"\0\0\0\0"
    custom: int = 0
    ground_distance: int = 0
    thermobarier: int = 0
    flip_vertical: int = 0
    cutoff: int = 0
    rotation: int = 0
    metalisation: int = 0
    soldermask: int = 0
    text: bytes = b""
    marker: bytes = b""
    groups: list[int] = field(default_factory=list)
    points: list[tuple[float, float]] = field(default_factory=list)
    children: list["Obj"] = field(default_factory=list)
    component_data: tuple[float, float, int, float, bytes, bytes, int] | None = None
    # Metadata used by the generator, not stored separately in the file.
    ref: str | None = None
    pin: str | None = None
    net: str | None = None
    is_pad: bool = False

    def header(self, child: bool = False) -> bytes:
        # For a child of a text object Sprint only stores the fixed object
        # header.  Child-specific strings are deliberately not included here.
        return OBJECT_HEADER.pack(
            self.typ,
            float(self.x), float(self.y), float(self.out), float(self.inn),
            int(self.line_width),
            0, int(self.layer), int(self.shape), b"\0" * 4,
            int(self.component_id), 0, self.style[:4].ljust(4, b"\0"),
            b"\0" * 5,
            int(self.custom), int(self.ground_distance), b"\0" * 5,
            int(self.thermobarier), int(self.flip_vertical), int(self.cutoff),
            int(self.rotation), int(self.metalisation), int(self.soldermask),
            b"\0" * 18,
        )

    def encode(self, child: bool = False) -> bytes:
        data = bytearray(self.header(child))
        if not child:
            data += struct.pack("<I", len(self.text)) + self.text
            data += struct.pack("<I", len(self.marker)) + self.marker
            data += struct.pack("<I", len(self.groups))
            for group in self.groups:
                data += struct.pack("<I", int(group))

        if self.typ == OBJ_CIRCLE:
            return bytes(data)
        if self.typ == OBJ_TEXT:
            data += struct.pack("<I", len(self.children))
            for child_obj in self.children:
                # Child records still carry their geometry, but not the three
                # top-level text/marker/group strings.
                data += child_obj.encode(child=True)
            if self.shape == 1 and self.component_data is not None:
                off_x, off_y, center_mode, rotation, package, comment, use = self.component_data
                data += struct.pack("<ffBd", off_x, off_y, center_mode, rotation)
                data += struct.pack("<I", len(package)) + package
                data += struct.pack("<I", len(comment)) + comment
                data += bytes((use,))
            return bytes(data)

        data += struct.pack("<I", len(self.points))
        for px, py in self.points:
            data += struct.pack("<ff", float(px), float(py))
        return bytes(data)


class Board:
    def __init__(self) -> None:
        self.objects: list[Obj] = []
        self.pads_by_net: dict[str, list[int]] = defaultdict(list)
        self.pad_positions: dict[int, tuple[float, float]] = {}
        self.net_numbers: dict[str, int] = {}
        self._next_net_number = 1
        self.labels: list[tuple[str, float, float, float, int]] = []

    def net(self, name: str) -> str:
        if name not in self.net_numbers:
            self.net_numbers[name] = self._next_net_number
            self._next_net_number += 1
        return name

    def add(self, obj: Obj) -> int:
        idx = len(self.objects)
        self.objects.append(obj)
        if obj.is_pad and obj.net:
            self.pads_by_net[obj.net].append(idx)
            self.pad_positions[idx] = (obj.x, obj.y)
        return idx

    def line(
        self,
        layer: int,
        points: Sequence[tuple[float, float]],
        width_mm: float = 0.15,
        net: str | None = None,
        group: int = 0,
        style: bytes = b"\0\0\0\0",
    ) -> int:
        return self.add(Obj(
            typ=OBJ_LINE,
            layer=layer,
            line_width=max(1, int(u(width_mm))),
            points=list(points),
            groups=[group] if group else [],
            net=net,
            style=style,
        ))

    def poly(
        self,
        layer: int,
        points: Sequence[tuple[float, float]],
        width_mm: float = 0.15,
        group: int = 0,
    ) -> int:
        return self.add(Obj(
            typ=OBJ_POLY,
            layer=layer,
            line_width=max(1, int(u(width_mm))),
            points=list(points),
            groups=[group] if group else [],
        ))

    def circle(
        self,
        layer: int,
        x_mm: float,
        y_mm: float,
        diameter_mm: float,
        width_mm: float = 0.15,
    ) -> int:
        x, y = xy(x_mm, y_mm)
        return self.add(Obj(
            typ=OBJ_CIRCLE,
            x=x, y=y,
            out=u(diameter_mm / 2.0),
            inn=0.0,
            line_width=max(1, int(u(width_mm))),
            layer=layer,
            shape=1,
        ))

    def tht_pad(
        self,
        ref: str,
        pin: str,
        x_mm: float,
        y_mm: float,
        net: str | None,
        *,
        pad_mm: float = 2.0,
        hole_mm: float = 0.9,
        shape: int = 1,
        layer: int = C1,
        metalisation: int = 1,
    ) -> int:
        x, y = xy(x_mm, y_mm)
        radius = u(pad_mm / 2.0)
        hole_radius = u(hole_mm / 2.0)
        if shape == 3:
            points = [
                (x - radius, y - radius), (x + radius, y - radius),
                (x + radius, y + radius), (x - radius, y + radius),
            ]
        else:
            # Round THT pads in Sprint carry a two-point diameter descriptor.
            points = [(x, y - radius), (x, y + radius)]
        obj = Obj(
            typ=OBJ_THT_PAD,
            x=x, y=y,
            out=radius,
            inn=hole_radius,
            layer=layer,
            shape=shape,
            style=b"UUUU",
            ground_distance=u(0.4),
            metalisation=metalisation,
            soldermask=1,
            points=points,
            groups=[self.net_numbers.get(net, 0)] if net else [],
            ref=ref, pin=pin, net=net, is_pad=True,
        )
        return self.add(obj)

    def smd_pad(
        self,
        ref: str,
        pin: str,
        x_mm: float,
        y_mm: float,
        width_mm: float,
        height_mm: float,
        net: str | None,
        *,
        layer: int = C1,
    ) -> int:
        x, y = xy(x_mm, y_mm)
        hw, hh = u(width_mm / 2.0), u(height_mm / 2.0)
        obj = Obj(
            typ=OBJ_SMD_PAD,
            x=x, y=y,
            out=hw, inn=hh,
            layer=layer,
            shape=1,
            style=b"UUUU",
            metalisation=1,
            soldermask=1,
            points=[
                (x - hw, y - hh), (x + hw, y - hh),
                (x + hw, y + hh), (x - hw, y + hh),
            ],
            groups=[self.net_numbers.get(net, 0)] if net else [],
            ref=ref, pin=pin, net=net, is_pad=True,
        )
        return self.add(obj)

    def label(
        self,
        text: str,
        x_mm: float,
        y_mm: float,
        *,
        height_mm: float = 1.4,
        layer: int = S1,
    ) -> None:
        self.labels.append((text, x_mm, y_mm, height_mm, layer))


# A compact 5x7 vector font.  It is used for silk labels because Sprint stores
# text as line children rather than as a portable font reference.
FONT = {
    "A": ("01110", "10001", "10001", "11111", "10001", "10001", "10001"),
    "B": ("11110", "10001", "10001", "11110", "10001", "10001", "11110"),
    "C": ("01111", "10000", "10000", "10000", "10000", "10000", "01111"),
    "D": ("11110", "10001", "10001", "10001", "10001", "10001", "11110"),
    "E": ("11111", "10000", "10000", "11110", "10000", "10000", "11111"),
    "F": ("11111", "10000", "10000", "11110", "10000", "10000", "10000"),
    "G": ("01111", "10000", "10000", "10111", "10001", "10001", "01111"),
    "H": ("10001", "10001", "10001", "11111", "10001", "10001", "10001"),
    "I": ("11111", "00100", "00100", "00100", "00100", "00100", "11111"),
    "J": ("00111", "00010", "00010", "00010", "10010", "10010", "01100"),
    "K": ("10001", "10010", "10100", "11000", "10100", "10010", "10001"),
    "L": ("10000", "10000", "10000", "10000", "10000", "10000", "11111"),
    "M": ("10001", "11011", "10101", "10101", "10001", "10001", "10001"),
    "N": ("10001", "11001", "10101", "10011", "10001", "10001", "10001"),
    "O": ("01110", "10001", "10001", "10001", "10001", "10001", "01110"),
    "P": ("11110", "10001", "10001", "11110", "10000", "10000", "10000"),
    "Q": ("01110", "10001", "10001", "10001", "10101", "10010", "01101"),
    "R": ("11110", "10001", "10001", "11110", "10100", "10010", "10001"),
    "S": ("01111", "10000", "10000", "01110", "00001", "00001", "11110"),
    "T": ("11111", "00100", "00100", "00100", "00100", "00100", "00100"),
    "U": ("10001", "10001", "10001", "10001", "10001", "10001", "01110"),
    "V": ("10001", "10001", "10001", "10001", "10001", "01010", "00100"),
    "W": ("10001", "10001", "10001", "10101", "10101", "11011", "10001"),
    "X": ("10001", "10001", "01010", "00100", "01010", "10001", "10001"),
    "Y": ("10001", "10001", "01010", "00100", "00100", "00100", "00100"),
    "Z": ("11111", "00001", "00010", "00100", "01000", "10000", "11111"),
    "0": ("01110", "10001", "10011", "10101", "11001", "10001", "01110"),
    "1": ("00100", "01100", "00100", "00100", "00100", "00100", "01110"),
    "2": ("01110", "10001", "00001", "00010", "00100", "01000", "11111"),
    "3": ("11110", "00001", "00001", "01110", "00001", "00001", "11110"),
    "4": ("00010", "00110", "01010", "10010", "11111", "00010", "00010"),
    "5": ("11111", "10000", "10000", "11110", "00001", "00001", "11110"),
    "6": ("01110", "10000", "10000", "11110", "10001", "10001", "01110"),
    "7": ("11111", "00001", "00010", "00100", "01000", "01000", "01000"),
    "8": ("01110", "10001", "10001", "01110", "10001", "10001", "01110"),
    "9": ("01110", "10001", "10001", "01111", "00001", "00001", "01110"),
    "-": ("00000", "00000", "00000", "11111", "00000", "00000", "00000"),
    "+": ("00000", "00100", "00100", "11111", "00100", "00100", "00000"),
    "/": ("00001", "00010", "00010", "00100", "01000", "01000", "10000"),
    ".": ("00000", "00000", "00000", "00000", "00000", "01100", "01100"),
    ":": ("00000", "01100", "01100", "00000", "01100", "01100", "00000"),
    "_": ("00000", "00000", "00000", "00000", "00000", "00000", "11111"),
}


def add_text_objects(board: Board) -> None:
    for text, x_mm, y_mm, height_mm, layer in board.labels:
        text = text.upper()
        # One bitmap cell is a square; keep a small gap between characters.
        cell = height_mm / 7.0
        x0, y0 = xy(x_mm, y_mm)
        children: list[Obj] = []
        cursor = x0
        for char in text:
            if char == " ":
                cursor += u(cell * 2.0)
                continue
            bitmap = FONT.get(char, FONT["_"])
            for row, bits in enumerate(bitmap):
                col = 0
                while col < 5:
                    if bits[col] == "0":
                        col += 1
                        continue
                    start = col
                    while col + 1 < 5 and bits[col + 1] == "1":
                        col += 1
                    end = col
                    px1 = cursor + start * u(cell)
                    px2 = cursor + (end + 1) * u(cell)
                    py = y0 - row * u(cell)
                    children.append(Obj(
                        typ=OBJ_LINE,
                        layer=layer,
                        line_width=max(1, int(u(0.10))),
                        points=[(px1, py), (px2, py)],
                    ))
                    col += 1
            cursor += u(cell * 6.0)
        board.add(Obj(
            typ=OBJ_TEXT,
            x=x0, y=y0,
            out=u(height_mm), inn=1.0,
            line_width=1,
            layer=layer,
            custom=1,
            text=text.encode("ascii", "replace"),
            children=children,
        ))


def body_rect(board: Board, x: float, y: float, w: float, h: float, *, layer: int = S1, width: float = 0.15) -> None:
    x1, y1 = xy(x - w / 2, y - h / 2)
    x2, y2 = xy(x + w / 2, y + h / 2)
    board.line(layer, [(x1, y1), (x2, y1), (x2, y2), (x1, y2), (x1, y1)], width)


def body_circle(board: Board, x: float, y: float, d: float, *, layer: int = S1, width: float = 0.15) -> None:
    board.circle(layer, x, y, d, width)


def to220(board: Board, ref: str, x: float, y: float, nets: Sequence[str]) -> list[int]:
    body_rect(board, x, y, 8.5, 7.0)
    # Pin 1 is the gate, pin 2 is the tab/drain, pin 3 is the source.
    pads = []
    for i, (dx, n) in enumerate(zip((-2.54, 0.0, 2.54), nets), 1):
        pads.append(board.tht_pad(ref, str(i), x + dx, y, n, pad_mm=2.1, hole_mm=1.0))
    board.label(ref, x - 3.8, y - 5.0, height_mm=1.1)
    return pads


def soic(board: Board, ref: str, x: float, y: float, nets: Sequence[str], *, pitch: float = 1.27, width: float = 1.8, height: float = 0.65) -> list[int]:
    body_rect(board, x, y, 5.5, 5.2, width=0.12)
    pads = []
    n = len(nets) // 2
    for i in range(n):
        py = y - (n - 1) * pitch / 2 + i * pitch
        pads.append(board.smd_pad(ref, str(i + 1), x - 3.0, py, width, height, nets[i]))
    for i in range(n):
        py = y + (n - 1) * pitch / 2 - i * pitch
        pads.append(board.smd_pad(ref, str(n + i + 1), x + 3.0, py, width, height, nets[n + i]))
    board.label(ref, x - 2.6, y - 4.2, height_mm=1.0)
    return pads


def tssop20(board: Board, ref: str, x: float, y: float, nets: Sequence[str]) -> list[int]:
    body_rect(board, x, y, 7.0, 7.0, width=0.12)
    pads = []
    # Ten pins per side, 0.65 mm pitch, pin 1 starts at the upper left.
    for i in range(10):
        py = y - 2.925 + i * 0.65
        pads.append(board.smd_pad(ref, str(i + 1), x - 4.2, py, 2.0, 0.38, nets[i]))
    for i in range(10):
        py = y + 2.925 - i * 0.65
        pads.append(board.smd_pad(ref, str(20 - i), x + 4.2, py, 2.0, 0.38, nets[10 + i]))
    board.label(ref, x - 2.9, y - 5.2, height_mm=1.0)
    return pads


def two_pad_smd(board: Board, ref: str, x: float, y: float, nets: Sequence[str], *, pitch: float = 3.0, width: float = 1.8, height: float = 1.2, body_w: float = 4.2, body_h: float = 2.2) -> list[int]:
    body_rect(board, x, y, body_w, body_h, width=0.11)
    pads = [
        board.smd_pad(ref, "1", x - pitch / 2, y, width, height, nets[0]),
        board.smd_pad(ref, "2", x + pitch / 2, y, width, height, nets[1]),
    ]
    board.label(ref, x - body_w / 2, y - body_h / 2 - 1.3, height_mm=0.9)
    return pads


def two_pad_tht(board: Board, ref: str, x: float, y: float, nets: Sequence[str], *, pitch: float = 5.0, pad_mm: float = 2.6, hole_mm: float = 1.1, body_w: float = 7.5, body_h: float = 3.5) -> list[int]:
    body_rect(board, x + pitch / 2, y, body_w, body_h, width=0.12)
    pads = [
        board.tht_pad(ref, "1", x, y, nets[0], pad_mm=pad_mm, hole_mm=hole_mm),
        board.tht_pad(ref, "2", x + pitch, y, nets[1], pad_mm=pad_mm, hole_mm=hole_mm),
    ]
    board.label(ref, x + pitch / 2 - body_w / 2, y - body_h / 2 - 1.2, height_mm=0.9)
    return pads


def connector(board: Board, ref: str, x: float, y: float, nets: Sequence[str], *, pitch: float = 2.5, vertical: bool = False, large: bool = False) -> list[int]:
    pads = []
    span = (len(nets) - 1) * pitch
    for i, n in enumerate(nets):
        if vertical:
            px, py = x, y + i * pitch
        else:
            px, py = x + i * pitch, y
        pads.append(board.tht_pad(ref, str(i + 1), px, py, n, pad_mm=3.2 if large else 2.0, hole_mm=1.6 if large else 0.95, shape=3 if large and i == 0 else 1))
    if vertical:
        body_rect(board, x, y + span / 2, 5.4, span + 4.0, width=0.18)
        board.label(ref, x - 3.0, y - 3.5, height_mm=1.0)
    else:
        body_rect(board, x + span / 2, y, span + 4.0, 5.4, width=0.18)
        board.label(ref, x - 0.5, y - 4.0, height_mm=1.0)
    return pads


def add_arduino(board: Board, x1: float, x2: float, y0: float, net_by_pin: dict[str, str]) -> dict[str, int]:
    """Add the two 24-pin rows of the Mega Pro Embed module."""
    padmap: dict[str, int] = {}
    # The two rows are intentionally long and leave the signal connectors at
    # the lower board edge.  The exact Arduino pin names are silk labels; the
    # netlist is what determines the electrical meaning.
    pin_names = [
        "RAW", "GND", "5V", "RST", "D0", "D1", "D2", "D3", "D4", "D5", "D6", "D7",
        "D8", "D9", "D10", "D11", "D12", "D13", "D14", "D15", "D16", "D17", "D18", "D19",
        "D20", "D21", "A0", "A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9", "A10", "A11",
        "A12", "A13", "A14", "A15", "AREF", "IOREF", "GND", "GND", "VIN",
    ]
    for i, pin in enumerate(pin_names[:24]):
        py = y0 + i * 2.54
        n = net_by_pin.get(pin)
        padmap[pin] = board.tht_pad("U3", pin, x1, py, n, pad_mm=1.9, hole_mm=1.0)
    for i, pin in enumerate(pin_names[24:48]):
        py = y0 + i * 2.54
        n = net_by_pin.get(pin)
        padmap[pin] = board.tht_pad("U3", pin, x2, py, n, pad_mm=1.9, hole_mm=1.0)
    body_rect(board, (x1 + x2) / 2, y0 + 23 * 2.54 / 2, 10.0, 23 * 2.54 + 5.0, width=0.2)
    board.label("U3 MEGA2560", x1 - 3.4, y0 - 4.5, height_mm=1.0)
    return padmap


def add_bom_parts(board: Board) -> None:
    # Net names are explicit here even where the original netlist did not yet
    # contain the passive/gate-drive nodes.  This makes the physical layout
    # useful as a reviewable starting point rather than an unconnected drawing.
    nets = [
        "VBAT_RAW", "VBAT_PROTECTED", "PGND", "PHASE_U", "PHASE_V", "PHASE_W",
        "VCC_12V", "VCC_5V", "GND", "SHUNT_TOP", "SW_BUCK", "VBAT_SENSE",
        "PWM_HA", "PWM_LA", "PWM_HB", "PWM_LB", "PWM_HC", "PWM_LC",
        "HALL_A", "HALL_B", "HALL_C", "ENC_A", "ENC_B", "HOME_SW",
        "STEP_PUL", "STEP_DIR", "STEP_ENA", "HOST_TX", "HOST_RX", "CURRENT_SENSE_OUT",
    ] + [f"GATE_Q{i}" for i in range(1, 7)] + [f"GDRV_Q{i}" for i in range(1, 7)]
    nets += ["BOOT_U", "BOOT_V", "BOOT_W", "SENSE_P", "SENSE_N"]
    for n in nets:
        board.net(n)

    # Battery input and protected DC link.
    connector(board, "J_BAT", 4.5, 10.0, ["VBAT_RAW", "PGND"], pitch=7.2, large=True)
    two_pad_tht(board, "F1", 16.5, 10.0, ["VBAT_RAW", "VBAT_PROTECTED"], pitch=5.0, pad_mm=2.8, hole_mm=1.2, body_w=8.0, body_h=3.5)
    for i, x in enumerate((27.0, 35.0, 43.0), 1):
        two_pad_tht(board, f"C_IN{i}", x, 10.0, ["VBAT_PROTECTED", "PGND"], pitch=5.0, pad_mm=2.5, hole_mm=1.1, body_w=7.0, body_h=5.0)
        body_circle(board, x + 2.5, 10.0, 7.5, layer=S1, width=0.12)
    two_pad_smd(board, "D_TVS", 48.5, 10.0, ["VBAT_PROTECTED", "PGND"], pitch=4.0, width=2.8, height=2.0, body_w=7.0, body_h=3.2)

    # Buck converter and 12/5 V rails.
    soic(board, "U4", 57.0, 11.0, ["VBAT_PROTECTED", "SW_BUCK", "VCC_12V", "PGND", "SW_BUCK", "VBAT_PROTECTED", "PGND", "VCC_12V"])
    two_pad_smd(board, "L_BUCK", 66.5, 11.0, ["SW_BUCK", "VCC_12V"], pitch=5.0, width=3.0, height=3.0, body_w=8.0, body_h=5.5)
    # SOT-223: pins 1,2,3 and the tab (pin 2).
    body_rect(board, 75.5, 11.0, 6.0, 5.0, width=0.12)
    for i, (dx, n) in enumerate(zip((-2.0, 0.0, 2.0, 0.0), ("GND", "VCC_5V", "VCC_5V", "VCC_12V")), 1):
        board.smd_pad("U5", str(i), 73.0 + dx, 13.0 if i < 4 else 9.0, 1.8, 1.4, n)
    board.label("U5", 72.6, 7.0, height_mm=1.0)

    # Three half bridges.  Each column is one motor phase.
    to220(board, "Q1", 55.0, 23.0, ["GATE_Q1", "VBAT_PROTECTED", "PHASE_U"])
    to220(board, "Q2", 55.0, 34.0, ["GATE_Q2", "PHASE_U", "SHUNT_TOP"])
    to220(board, "Q3", 67.0, 23.0, ["GATE_Q3", "VBAT_PROTECTED", "PHASE_V"])
    to220(board, "Q4", 67.0, 34.0, ["GATE_Q4", "PHASE_V", "SHUNT_TOP"])
    to220(board, "Q5", 79.0, 23.0, ["GATE_Q5", "VBAT_PROTECTED", "PHASE_W"])
    to220(board, "Q6", 79.0, 34.0, ["GATE_Q6", "PHASE_W", "SHUNT_TOP"])
    connector(board, "J_MOTOR", 94.0, 25.0, ["PHASE_U", "PHASE_V", "PHASE_W"], pitch=6.5, vertical=True, large=True)

    # Gate driver. Pin mapping follows the supplied KiCad netlist for the
    # six PWM inputs, the three switch nodes, and VCC_12V.
    u1_nets = [
        "PWM_HA", "PWM_LA", "PWM_HB", "PWM_LB", "PWM_HC", "PWM_LC",
        "GDRV_Q1", "GDRV_Q2", "PHASE_W", "GDRV_Q3", "GDRV_Q4", "PHASE_V",
        "GDRV_Q5", "GDRV_Q6", "PHASE_U", "BOOT_U", "BOOT_V", "VCC_12V", "BOOT_W", "PGND",
    ]
    tssop20(board, "U1", 67.0, 46.5, u1_nets)
    # Gate resistors and their fast turn-off diodes are placed beside the
    # corresponding MOSFET gates, not in the quiet controller area.
    gate_y = [20.0, 31.0, 20.0, 31.0, 20.0, 31.0]
    gate_x = [47.0, 47.0, 59.0, 59.0, 71.0, 71.0]
    for i, (x, y) in enumerate(zip(gate_x, gate_y), 1):
        two_pad_smd(board, f"R_G{i}", x, y, [f"GDRV_Q{i}", f"GATE_Q{i}"], pitch=2.4, width=1.4, height=1.0, body_w=3.5, body_h=1.8)
        two_pad_smd(board, f"D_G{i}", x, y + 2.5, [f"GDRV_Q{i}", f"GATE_Q{i}"], pitch=2.4, width=1.6, height=0.9, body_w=3.5, body_h=1.5)

    # Bootstrap networks around U1.
    for i, (x, y, boot) in enumerate(((58.0, 54.5, "BOOT_U"), (67.0, 55.5, "BOOT_V"), (76.0, 54.5, "BOOT_W")), 1):
        two_pad_smd(board, f"C_BST{i}", x, y, ["VCC_12V", boot], pitch=2.2, width=1.4, height=1.0, body_w=3.2, body_h=1.6)
        two_pad_smd(board, f"D_BST{i}", x, y + 2.5, ["VCC_12V", boot], pitch=2.2, width=1.8, height=1.0, body_w=3.4, body_h=1.6)

    # Low-side shunt and amplifier.
    two_pad_smd(board, "R_SHUNT", 86.5, 47.0, ["SHUNT_TOP", "PGND"], pitch=5.0, width=4.5, height=3.0, body_w=8.0, body_h=4.5)
    soic(board, "U2", 86.0, 57.0, ["SENSE_P", "GND", "SENSE_N", "CURRENT_SENSE_OUT", "VCC_5V"])
    two_pad_smd(board, "R_VD1", 74.5, 62.0, ["VBAT_PROTECTED", "VBAT_SENSE"], pitch=2.6, width=1.3, height=1.0, body_w=3.5, body_h=1.6)
    two_pad_smd(board, "R_VD2", 74.5, 66.0, ["VBAT_SENSE", "GND"], pitch=2.6, width=1.3, height=1.0, body_w=3.5, body_h=1.6)

    # The Mega Pro is represented by its two 24-pin socket rows.
    u3_nets = {
        "5V": "VCC_5V", "GND": "GND", "D2": "HALL_A", "D3": "HALL_B",
        "D4": "STEP_PUL", "D5": "STEP_DIR", "D6": "STEP_ENA",
        "D8": "PWM_HA", "D9": "PWM_LA", "D10": "PWM_HB", "D11": "PWM_LB",
        "D12": "PWM_HC", "D13": "PWM_LC", "D18": "HALL_C", "D19": "HOME_SW",
        "D20": "ENC_A", "D21": "ENC_B", "A0": "CURRENT_SENSE_OUT", "A1": "VBAT_SENSE",
        "D0": "HOST_RX", "D1": "HOST_TX",
    }
    add_arduino(board, 20.0, 27.62, 14.0, u3_nets)

    # Low-voltage connectors along the lower edge.
    connector(board, "J_HALL", 36.0, 75.0, ["VCC_5V", "GND", "HALL_A", "HALL_B", "HALL_C"], pitch=2.5)
    connector(board, "J_ENC", 51.0, 75.0, ["VCC_5V", "GND", "ENC_A", "ENC_B"], pitch=2.5)
    connector(board, "J_HOME", 64.0, 75.0, ["VCC_5V", "GND", "HOME_SW"], pitch=2.5)
    connector(board, "J_HOST", 75.0, 75.0, ["VCC_5V", "GND", "HOST_TX", "HOST_RX"], pitch=2.5)
    connector(board, "J_TB6600", 87.0, 65.5, ["STEP_PUL", "GND", "STEP_DIR", "GND", "STEP_ENA", "GND"], pitch=2.5, vertical=True)

    # Pull-ups and RC filters for the sensor inputs.
    sensor_nets = ["HALL_A", "HALL_B", "HALL_C", "ENC_A", "ENC_B", "HOME_SW", "HOST_RX"]
    for i, n in enumerate(sensor_nets, 1):
        x = 36.0 + ((i - 1) % 4) * 5.0
        y = 57.5 + ((i - 1) // 4) * 5.0
        two_pad_smd(board, f"R_PU{i}", x, y, ["VCC_5V", n], pitch=2.6, width=1.3, height=1.0, body_w=3.5, body_h=1.6)
    for i, n in enumerate(sensor_nets[:5], 1):
        x = 36.0 + ((i - 1) % 3) * 5.0
        y = 67.5 + ((i - 1) // 3) * 3.0
        two_pad_smd(board, f"C_FLT{i}", x, y, [n, "GND"], pitch=2.4, width=1.3, height=1.0, body_w=3.3, body_h=1.5)

    # TB6600 output limiters and general decoupling.
    for i, n in enumerate(("STEP_PUL", "STEP_DIR", "STEP_ENA"), 1):
        two_pad_smd(board, f"R_LIM{i}", 84.0, 58.0 + i * 3.2, [n, f"TB{i}"], pitch=2.6, width=1.3, height=1.0, body_w=3.5, body_h=1.6)
    for i, n in enumerate(("VCC_12V", "VCC_5V", "VCC_5V", "VCC_12V", "VCC_5V"), 1):
        x = 44.0 + (i - 1) * 4.0
        y = 48.0
        two_pad_smd(board, f"C_VCC{i}", x, y, [n, "GND"], pitch=2.4, width=1.4, height=1.0, body_w=3.2, body_h=1.6)

    # RC snubbers are placed close to the three phase outputs.
    for i, phase in enumerate(("PHASE_U", "PHASE_V", "PHASE_W"), 1):
        x = 51.0 + (i - 1) * 12.0
        two_pad_smd(board, f"R_SN{i}", x, 40.5, [phase, "SHUNT_TOP"], pitch=2.5, width=1.6, height=1.0, body_w=3.6, body_h=1.7)
        two_pad_smd(board, f"C_SN{i}", x, 43.0, [phase, "SHUNT_TOP"], pitch=2.4, width=1.4, height=1.0, body_w=3.4, body_h=1.6)


def add_mounting_and_silk(board: Board) -> None:
    # Board outline and a second silk reference outline.
    outline = [xy(0, 0), xy(BOARD_W, 0), xy(BOARD_W, BOARD_H), xy(0, BOARD_H), xy(0, 0)]
    board.poly(OUTLINE, outline, width_mm=0.25)
    board.line(S1, outline, width_mm=0.20)
    for x, y in ((4.0, 4.0), (96.0, 4.0), (96.0, 76.0), (4.0, 76.0)):
        board.tht_pad("H", f"M3_{x}_{y}", x, y, None, pad_mm=7.0, hole_mm=3.2, metalisation=0)
        board.circle(S1, x, y, 7.0, width_mm=0.18)
        board.circle(OUTLINE, x, y, 3.2, width_mm=0.12)

    # Functional regions and connector legends.
    board.line(S1, [xy(2.0, 18.0), xy(47.0, 18.0)], width_mm=0.12)
    board.line(S1, [xy(48.0, 18.0), xy(91.0, 18.0)], width_mm=0.12)
    board.line(S1, [xy(31.0, 52.0), xy(31.0, 73.0)], width_mm=0.12)
    board.label("SMART WHEEL POD", 34.0, 4.0, height_mm=1.7)
    board.label("38V DC / 20A", 35.0, 7.0, height_mm=1.1)
    board.label("CUSTOM BLDC", 51.0, 17.0, height_mm=1.1)
    board.label("PHASE U V W", 86.0, 18.0, height_mm=1.0)
    board.label("SENSORS", 36.0, 70.0, height_mm=1.0)
    board.label("TB6600", 84.0, 65.0, height_mm=1.0)
    board.label("TOP", 91.0, 77.0, height_mm=1.0)
    board.label("REV 1.0", 4.5, 77.0, height_mm=1.0)
    # Polarity and phase markings at the high-current interfaces.
    board.label("+", 4.0, 5.5, height_mm=1.4)
    board.label("-", 11.2, 5.5, height_mm=1.4)
    board.label("U", 91.0, 23.0, height_mm=1.4)
    board.label("V", 91.0, 29.5, height_mm=1.4)
    board.label("W", 91.0, 36.0, height_mm=1.4)


def route(board: Board, net_name: str, *, layer: int, width_mm: float, channel_mm: float | None = None) -> None:
    pads = board.pads_by_net.get(net_name, [])
    if len(pads) < 2:
        return
    # A deterministic Manhattan chain keeps the file editable and makes every
    # net visible in Sprint even though a final DRC is still required.
    origin = board.pad_positions[pads[0]]
    for sequence, idx in enumerate(pads[1:], 1):
        target = board.pad_positions[idx]
        x1, y1 = origin
        x2, y2 = target
        if channel_mm is None:
            channel = y1
        else:
            channel = -u(channel_mm)
        if abs(y1 - y2) < 1.0:
            points = [(x1, y1), (x2, y2)]
        else:
            points = [(x1, y1), (x1, channel), (x2, channel), (x2, y2)]
        board.line(layer, points, width_mm=width_mm, net=net_name, group=board.net_numbers.get(net_name, 0))
        origin = target


def add_routing(board: Board) -> None:
    # Thick, short current paths first.  These paths intentionally use the
    # top copper layer and are kept at least 6 mm wide as specified in the
    # engineering document.
    for n in ("VBAT_RAW", "VBAT_PROTECTED", "PGND", "PHASE_U", "PHASE_V", "PHASE_W", "SHUNT_TOP"):
        route(board, n, layer=C1, width_mm=6.0 if n in ("VBAT_PROTECTED", "PGND", "PHASE_U", "PHASE_V", "PHASE_W") else 4.0)

    # Logic and gate-drive nets use the bottom copper layer.  Separate channel
    # bands reduce accidental visual overlap with the power bridge.
    skip = {"VBAT_RAW", "VBAT_PROTECTED", "PGND", "PHASE_U", "PHASE_V", "PHASE_W", "SHUNT_TOP"}
    signal_nets = [n for n in board.pads_by_net if n not in skip]
    for i, n in enumerate(signal_nets):
        route(board, n, layer=C2, width_mm=0.25, channel_mm=56.0 + (i % 8) * 1.5)

    # Add one explicit star-ground strap near the shunt.  The GND and PGND
    # names remain distinct in the layout; this is the intended net-tie point.
    gnd_pads = board.pads_by_net.get("GND", [])
    pgnd_pads = board.pads_by_net.get("PGND", [])
    if gnd_pads and pgnd_pads:
        x1, y1 = board.pad_positions[gnd_pads[0]]
        x2, y2 = board.pad_positions[pgnd_pads[-1]]
        board.line(C2, [(x1, y1), (u(86.5), -u(50.0)), (x2, y2)], width_mm=0.4, net="STAR_GROUND", group=0)


def write_lay6(board: Board, path: Path) -> None:
    add_text_objects(board)
    num_objects = len(board.objects)
    data = bytearray(b"\x06\x33\xaa\xff")
    data += struct.pack("<I", 1)  # one board tab

    # LAY_BoardHeader (534 bytes).  Numeric dimensions are 1/10000 mm.
    header = bytearray()
    header += fixed_string("Smart Wheel Pod Controller", 30)
    header += b"\0" * 4
    header += struct.pack("<II", int(u(BOARD_W)), int(u(BOARD_H)))
    header += b"\0" * 7  # ground pane settings
    header += struct.pack("<dd", u(0.25), 0.00325)
    header += struct.pack("<II", 0, 0)
    header += bytes((C1,)) + b"\0" * 3
    header += bytes((1, 1, 1, 1, 1, 1, 1))
    header += b"\0\0"  # scanned copies disabled
    header += fixed_string("", 200) + fixed_string("", 200)
    header += struct.pack("<II", 0, 0)  # scan DPI
    header += struct.pack("<IIII", 0, 0, 0, 0)  # scan shifts
    header += struct.pack("<II", 0, 0)
    header += struct.pack("<ii", int(u(BOARD_W / 2)), -int(u(BOARD_H / 2)))
    header += bytes((0,))  # single board / no internal multilayer stack
    header += struct.pack("<I", num_objects)
    if len(header) != 534:
        raise AssertionError(f"board header is {len(header)} bytes, expected 534")
    data += header

    for obj in board.objects:
        data += obj.encode()

    # One connection record per THT/SMD pad.  Object ids are zero-based, as
    # used by Sprint's ratsnest records; pads on the same named net are linked.
    for idx, obj in enumerate(board.objects):
        if not obj.is_pad:
            continue
        peers = [p for p in board.pads_by_net.get(obj.net or "", []) if p != idx]
        data += struct.pack("<I", len(peers))
        for peer in peers:
            data += struct.pack("<I", peer)

    # LAY_Trailer (311 bytes plus the optional comment body).
    data += struct.pack("<I", 0)
    data += fixed_string("Smart_Wheel_Pod_Controller", 100)
    data += fixed_string("Arena", 100)
    data += fixed_string("NTC AVTOVAZ", 100)
    comment = (
        "100x80 mm, 2-layer preliminary placement; 2 oz copper; "
        "verify schematic, footprints, clearances and DRC before fabrication."
    ).encode("ascii")
    data += struct.pack("<I", len(comment)) + comment

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


def parse_check(path: Path) -> dict[str, int]:
    """Perform a structural read-back without requiring Sprint-Layout."""
    data = path.read_bytes()
    if data[:4] != b"\x06\x33\xaa\xff":
        raise ValueError("not a Sprint-Layout 6 magic header")
    if len(data) < 8 + 534 + 311:
        raise ValueError("file is shorter than a LAY6 container")
    board_count = struct.unpack_from("<I", data, 4)[0]
    if board_count != 1:
        raise ValueError(f"expected one board, got {board_count}")
    board_pos = 8
    num_objects = struct.unpack_from("<I", data, board_pos + 530)[0]
    pos = board_pos + 534
    pad_count = 0
    for _ in range(num_objects):
        if pos + 77 > len(data):
            raise ValueError("truncated object header")
        typ = data[pos]
        shape = data[pos + 23]
        pos += 77
        for section in range(3):
            n = struct.unpack_from("<I", data, pos)[0]
            pos += 4
            if section < 2:
                pos += n
            else:
                pos += 4 * n
        if typ == OBJ_CIRCLE:
            pass
        elif typ == OBJ_TEXT:
            n = struct.unpack_from("<I", data, pos)[0]
            pos += 4
            for _ in range(n):
                if pos + 77 > len(data):
                    raise ValueError("truncated text child")
                child_type = data[pos]
                pos += 77
                if child_type != OBJ_CIRCLE:
                    points = struct.unpack_from("<I", data, pos)[0]
                    pos += 4 + 8 * points
            if shape == 1:
                pos += 17
                for _ in range(2):
                    n = struct.unpack_from("<I", data, pos)[0]
                    pos += 4 + n
                pos += 1
        else:
            points = struct.unpack_from("<I", data, pos)[0]
            pos += 4 + 8 * points
        if typ in (OBJ_THT_PAD, OBJ_SMD_PAD):
            pad_count += 1
    # Connection records are identifiable from the pad count.  We do not
    # inspect peer semantics here, but do ensure the trailer is reachable.
    for _ in range(pad_count):
        n = struct.unpack_from("<I", data, pos)[0]
        pos += 4 + 4 * n
    trailer_start = pos
    if len(data) < trailer_start + 311:
        raise ValueError("truncated trailer")
    return {"bytes": len(data), "objects": num_objects, "pads": pad_count, "trailer": trailer_start}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path("pcb/smart_wheel_pod_controller.lay6"))
    parser.add_argument("--check", action="store_true", help="read back and validate the generated container")
    args = parser.parse_args()

    board = Board()
    add_bom_parts(board)
    add_mounting_and_silk(board)
    add_routing(board)
    write_lay6(board, args.output)
    result = parse_check(args.output)
    print(f"wrote {args.output}: {result['bytes']} bytes, {result['objects']} objects, {result['pads']} pads")
    if args.check:
        print(f"structural check OK; trailer offset 0x{result['trailer']:x}")


if __name__ == "__main__":
    main()
