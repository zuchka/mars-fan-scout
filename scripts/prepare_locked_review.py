"""Reproduce six fixed, never-trained review crops from a 2024 HiRISE observation.

Coordinates were chosen from a reduced source overview before viewing any model
predictions. The source JP2 is outside this project and must be downloaded first.
"""
from __future__ import annotations

import json
import subprocess
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "data/planet-four/images/ESP_082241_0950_RED.JP2"
OUTPUT = ROOT / "mars-weather/evaluation/locked"
OBSERVATION = "ESP_082241_0950"
PREVIEW_ORIGINS = [(352, 192), (352, 256), (96, 448), (224, 560), (448, 128), (608, 192)]


def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    images = OUTPUT / "images"
    images.mkdir(exist_ok=True)
    manifest = []
    for index, (preview_x, preview_y) in enumerate(PREVIEW_ORIGINS, 1):
        x0, y0 = preview_x * 32, preview_y * 32
        bounds = [x0, y0, x0 + 2048, y0 + 2048]
        with tempfile.TemporaryDirectory() as temp:
            png = Path(temp) / "crop.png"
            subprocess.run(
                ["opj_decompress", "-i", str(SOURCE), "-o", str(png),
                 "-d", ",".join(map(str, bounds)), "-threads", "4", "-quiet"],
                check=True, stdout=subprocess.DEVNULL,
            )
            pixels = np.asarray(Image.open(png), dtype=np.float32)
            valid = pixels[pixels > 0]
            low, high = np.percentile(valid, [1, 99.5])
            normalized = np.uint8(np.clip((pixels - low) / max(1, high - low), 0, 1) ** 0.92 * 255)
            name = f"locked-{index:02d}.jpg"
            Image.fromarray(normalized, "L").resize((1024, 1024), Image.Resampling.LANCZOS).save(
                images / name, format="JPEG", quality=91, optimize=True
            )
        manifest.append({
            "id": f"locked-{index:02d}", "observation": OBSERVATION,
            "source_raw_bounds": bounds, "source_scale_m_per_pixel": 0.5,
            "working_scale_m_per_pixel": 1, "image": f"images/{name}",
            "width": 1024, "height": 1024,
        })
    (OUTPUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"Wrote {len(manifest)} locked crops to {OUTPUT}")


if __name__ == "__main__":
    main()
