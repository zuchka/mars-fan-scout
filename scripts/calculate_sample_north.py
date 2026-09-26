"""Calculate local geographic north in the bundled south-polar HiRISE crop.

For a south-polar stereographic map, moving toward geographic north is radially
away from the south pole. The PDS projection offsets place the pole at map x=y=0.
The resulting angle is clockwise from image up at the crop center.
"""
from __future__ import annotations

import math
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LABEL = ROOT / "data/planet-four/images/ESP_082142_0935_RED.LBL"
CROP_RAW_BOUNDS = (2304, 6976, 4352, 9024)


def label_number(text: str, key: str) -> float:
    match = re.search(rf"^\s*{key}\s*=\s*([-+\d.]+)", text, re.MULTILINE)
    if not match:
        raise ValueError(f"Missing {key} in {LABEL}")
    return float(match.group(1))


def main() -> None:
    label = LABEL.read_text()
    if 'MAP_PROJECTION_TYPE          = "POLAR STEREOGRAPHIC"' not in label:
        raise ValueError("Expected the map-projected polar stereographic product")
    if label_number(label, "CENTER_LATITUDE") != -90:
        raise ValueError("Expected a south-polar projection")
    scale = label_number(label, "MAP_SCALE")
    sample_offset = label_number(label, "SAMPLE_PROJECTION_OFFSET")
    line_offset = label_number(label, "LINE_PROJECTION_OFFSET")
    x0, y0, x1, y1 = CROP_RAW_BOUNDS
    sample = (x0 + x1) / 2 + 1  # PDS samples are one-based.
    line = (y0 + y1) / 2 + 1
    map_x = (sample - sample_offset) * scale
    map_y = -(line - line_offset) * scale  # Image lines increase downward.
    north_angle = math.degrees(math.atan2(map_x, map_y)) % 360
    print(f"North at bundled crop center: {north_angle:.1f}° clockwise from image up")


if __name__ == "__main__":
    main()
