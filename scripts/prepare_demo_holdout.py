"""Freeze three crops from a new observation before looking at detector output."""

from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
OBSERVATION = "ESP_092344_0970"
SOURCE = ROOT / "data/planet-four/images" / f"{OBSERVATION}_RED.JP2"
DEST = ROOT / "mars-weather/evaluation/demo-repair/holdout"
# Positions selected from a 1/32-scale overview before any inference on this observation.
PREVIEW_ORIGINS = [(120, 180), (210, 260), (285, 350)]


def main():
    if not SOURCE.exists():
        raise FileNotFoundError(SOURCE)
    executable = shutil.which("opj_decompress") or "/opt/homebrew/Cellar/openjpeg/2.5.4/bin/opj_decompress"
    DEST.mkdir(parents=True, exist_ok=True)
    crops = []
    for index, (px, py) in enumerate(PREVIEW_ORIGINS, 1):
        x0, y0 = px * 32, py * 32
        bounds = [x0, y0, x0 + 2048, y0 + 2048]
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "raw.png"
            subprocess.run([executable, "-i", str(SOURCE), "-o", str(path),
                            "-d", ",".join(map(str, bounds)), "-threads", "4", "-quiet"], check=True)
            pixels = np.asarray(Image.open(path), dtype=np.float32)
            valid = pixels[pixels > 0]
            lo, hi = np.percentile(valid, [1, 99.5])
            normalized = np.uint8(np.clip((pixels - lo) / max(1, hi - lo), 0, 1) ** .92 * 255)
            source = Image.fromarray(normalized, "L")
            name = f"holdout-{index:02d}.jpg"
            source.resize((1024, 1024), Image.Resampling.LANCZOS).save(DEST / name, quality=91, optimize=True)
            if index == 1:
                source.save(DEST / "holdout-01-2x.jpg", quality=91, optimize=True)
        crops.append({"id": f"holdout-{index:02d}", "observation": OBSERVATION,
                      "source_raw_bounds": bounds, "source_scale_m_per_pixel": .5,
                      "working_scale_m_per_pixel": 1, "image": name,
                      "label_status": "unlabeled; detector has not been run"})
    (DEST / "manifest.json").write_text(json.dumps({"format": "mars-fan-holdout-v1",
        "selection": "Selected from reduced source overview before detector output was viewed",
        "crops": crops}, indent=2) + "\n")
    print(f"Wrote {len(crops)} untouched holdout crops to {DEST}")


if __name__ == "__main__":
    main()
