"""Build honest, source-linked Mars fan scenes and a COCO training export.

Requires Pillow, numpy and pyproj. Source files are downloaded separately with
scripts/download_sources.py. JPEG2000 crops use OpenJPEG's opj_decompress.
"""

from __future__ import annotations

import csv
import json
import math
import re
import subprocess
import tempfile
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image
from pyproj import Geod, Proj


ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "data" / "planet-four"
OUTPUT = ROOT / "mars-weather" / "public"
PROJ = Proj(proj="stere", lat_0=-90, lon_0=0, lat_ts=-90, R=3396190)
GEOD = Geod(a=3396190, b=3396190)

SCENES = [
    {"id": "cryptic-terrain", "tile": "APF00006mr", "title": "A field of fans", "subtitle": "Dense seasonal deposits", "role": "training"},
    {"id": "southern-sweep", "tile": "APF0000ay0", "title": "Southern sweep", "subtitle": "A second spring observation", "role": "training"},
    {"id": "unseen-orbit", "tile": "APF0000q3x", "title": "Unseen orbit", "subtitle": "Held-out observation", "role": "validation"},
]


def records(filename: str):
    with (SOURCE / filename).open(newline="") as f:
        yield from csv.DictReader(f)


def label_values(obsid: str):
    text = (SOURCE / "images" / f"{obsid}_RED.LBL").read_text()
    def value(key):
        match = re.search(rf"^\s*{key}\s*=\s*([^\s<]+)", text, re.M)
        if not match:
            raise ValueError(f"Missing {key} in {obsid} label")
        return float(match.group(1))
    return {
        "lines": int(value("LINES")),
        "samples": int(value("LINE_SAMPLES")),
        "sample_offset": value("SAMPLE_PROJECTION_OFFSET"),
        "line_offset": value("LINE_PROJECTION_OFFSET"),
    }


@dataclass
class Transform:
    obsid: str
    y_to_sample: float
    y_to_line: float
    sample_intercept: float
    line_intercept: float
    x_to_sample: float
    x_to_line: float
    label: dict
    rms: float

    def point(self, x: float, y: float):
        return (
            self.y_to_sample * y + self.sample_intercept + (x - 420) * self.x_to_sample,
            self.y_to_line * y + self.line_intercept + (x - 420) * self.x_to_line,
        )

    def vector(self, dx: float, dy: float):
        return (
            self.x_to_sample * dx + self.y_to_sample * dy,
            self.x_to_line * dx + self.y_to_line * dy,
        )


def fit_transform(obsid: str, tiles: list[dict]):
    label = label_values(obsid)
    values = []
    for row in tiles:
        x, y = PROJ(float(row["PositiveEast360Longitude"]), float(row["PlanetocentricLatitude"]))
        values.append((float(row["y_hirise"]), x + label["sample_offset"], -y + label["line_offset"]))
    a = np.asarray(values)
    sx, s0 = np.polyfit(a[:, 0], a[:, 1], 1)
    ly, l0 = np.polyfit(a[:, 0], a[:, 2], 1)
    mag = math.hypot(sx, ly)
    rms = math.sqrt(np.mean((a[:, 1] - (sx * a[:, 0] + s0)) ** 2 + (a[:, 2] - (ly * a[:, 0] + l0)) ** 2))
    if rms > 25:
        raise ValueError(f"{obsid}: georegistration residual {rms:.1f}px exceeds tolerance")
    return Transform(obsid, sx, ly, s0, l0, ly / mag, -sx / mag, label, rms)


def fan_geometry(fan: dict, transform: Transform):
    """Planet Four fan marking: base + two arms + rounded downstream edge."""
    x, y = float(fan["image_x"]), float(fan["image_y"])
    base = transform.point(x, y)
    angle = math.radians(float(fan["angle"]))
    spread = math.radians(float(fan["spread"]))
    distance = float(fan["distance"])
    if distance <= 3 or not 0 < spread < math.pi:
        return None
    arm = distance / (math.cos(spread / 2) + math.sin(spread / 2))
    # Planet Four draws a triangle capped by a downstream semicircle. The
    # catalog's distance includes that cap, rather than ending at the arms.
    half = spread / 2
    center = arm * math.cos(half)
    radius = arm * math.sin(half)
    ux, uy = math.cos(angle), math.sin(angle)
    nx, ny = -uy, ux
    local = [(0.0, 0.0)]
    for step in range(13):
        theta = -math.pi / 2 + math.pi * step / 12
        along = center + radius * math.cos(theta)
        across = radius * math.sin(theta)
        local.append((along * ux + across * nx, along * uy + across * ny))
    points = []
    for dx, dy in local:
        vx, vy = transform.vector(dx, dy)
        points.append((base[0] + vx, base[1] + vy))
    dv = transform.vector(math.cos(angle), math.sin(angle))
    return base, points, dv


def bearing(base, vector, label):
    def inverse(pixel):
        easting = pixel[0] - label["sample_offset"]
        northing = label["line_offset"] - pixel[1]
        return PROJ(easting, northing, inverse=True)
    lon1, lat1 = inverse(base)
    lon2, lat2 = inverse((base[0] + vector[0] * 60, base[1] + vector[1] * 60))
    az, _, _ = GEOD.inv(lon1, lat1, lon2, lat2)
    return az % 360


def image_chip(obsid: str, bounds: tuple[int, int, int, int], out: Path):
    out.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as temp:
        png = Path(temp) / "crop.png"
        source = SOURCE / "images" / f"{obsid}_RED.JP2"
        subprocess.run([
            "opj_decompress", "-i", str(source), "-o", str(png),
            "-d", ",".join(str(n) for n in bounds), "-threads", "4", "-quiet",
        ], check=True, stdout=subprocess.DEVNULL)
        pixels = np.asarray(Image.open(png), dtype=np.float32)
        lo, hi = np.percentile(pixels, [1.0, 99.5])
        if hi <= lo:
            hi = lo + 1
        normalized = np.uint8(np.clip((pixels - lo) / (hi - lo), 0, 1) ** 0.92 * 255)
        if out.suffix.lower() in {".jpg", ".jpeg"}:
            Image.fromarray(normalized, "L").save(out, format="JPEG", quality=91, optimize=True)
        else:
            Image.fromarray(normalized, "L").save(out, format="WEBP", quality=88, method=5)


def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    (OUTPUT / "images").mkdir(exist_ok=True)
    all_tiles = defaultdict(list)
    tile_by_id = {}
    for row in records("P4_catalog_v3.1_tile_coords_final.csv"):
        all_tiles[row["obsid"]].append(row)
        tile_by_id[row["tile_id"]] = row
    fans_by_obs = defaultdict(list)
    for row in records("P4_catalog_v3.1_L1C_cut_0.5_fan.csv"):
        fans_by_obs[row["obsid"]].append(row)
    metadata = {row["OBSERVATION_ID"]: row for row in records("P4_catalog_v3.1_metadata.csv")}
    transforms = {obs: fit_transform(obs, all_tiles[obs]) for obs in {tile_by_id[s["tile"]]["obsid"] for s in SCENES}}
    data = []
    for scene in SCENES:
        tile = tile_by_id[scene["tile"]]
        obs = tile["obsid"]
        transform = transforms[obs]
        center = transform.point(float(tile["x_hirise"]), float(tile["y_hirise"]))
        x0, y0 = round(center[0] - 512), round(center[1] - 512)
        bounds = (x0, y0, x0 + 1024, y0 + 1024)
        asset = f"images/{scene['id']}.webp"
        if not (OUTPUT / asset).exists():
            image_chip(obs, bounds, OUTPUT / asset)
        markings = []
        for fan in fans_by_obs[obs]:
            result = fan_geometry(fan, transform)
            if result is None:
                continue
            base, polygon, vector = result
            bx, by = base[0] - x0, base[1] - y0
            if not (24 < bx < 1000 and 24 < by < 1000):
                continue
            if not (5 < float(fan["distance"]) < 400):
                continue
            markings.append({
                "id": fan["marking_id"],
                "base": [round(bx, 1), round(by, 1)],
                "polygon": [[round(px - x0, 1), round(py - y0, 1)] for px, py in polygon],
                "vector": [round(vector[0], 4), round(vector[1], 4)],
                "bearing": round(bearing(base, vector, transform.label), 1),
                "votes": int(float(fan["n_votes"] or 0)),
                "distance": round(float(fan["distance"]), 1),
                "tile_id": fan["tile_id"],
            })
        markings.sort(key=lambda m: m["votes"], reverse=True)
        meta = metadata[obs]
        data.append({
            **scene,
            "obsid": obs,
            "image": asset,
            "width": 1024,
            "height": 1024,
            "location": [round(float(tile["PlanetocentricLatitude"]), 3), round(float(tile["PositiveEast360Longitude"]), 3)],
            "captured": meta["START_TIME"].split(" ")[0],
            "solar_longitude": round(float(meta["SOLAR_LONGITUDE"]), 1),
            "scale_m_per_px": float(meta["map_scale"]),
            "basis_bearings": [
                round(bearing(center, (1, 0), transform.label), 4),
                round(bearing(center, (0, 1), transform.label), 4),
            ],
            "reference_count": len(markings),
            "registration_rms_px": round(transform.rms, 1),
            "markings": markings,
            "source_url": f"https://hirise.lpl.arizona.edu/{obs}",
        })
        print(scene["id"], obs, len(markings), "fan markings", f"RMS {transform.rms:.1f}px")
    (OUTPUT / "scenes.json").write_text(json.dumps(data, separators=(",", ":")))


if __name__ == "__main__":
    main()
