"""Convert the frozen weak segmentation dataset to a box-proposal comparator.

This preserves source images and observation splits; it does not improve labels.
The ZIP is written outside the repository for a separate Roboflow project.
"""

from __future__ import annotations

import json
import zipfile
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[1] / "training/refined-coco"
DEST = Path("/tmp/mars-fan-box-proposals-coco.zip")


def main():
    with zipfile.ZipFile(DEST, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for split in ("train", "valid", "test"):
            directory = SOURCE / split
            record = json.loads((directory / "_annotations.coco.json").read_text())
            for annotation in record["annotations"]:
                annotation.pop("segmentation", None)
                annotation["area"] = annotation["bbox"][2] * annotation["bbox"][3]
            archive.writestr(f"{split}/_annotations.coco.json", json.dumps(record, separators=(",", ":")))
            for image in record["images"]:
                path = directory / image["file_name"]
                archive.write(path, f"{split}/{path.name}")
    print(f"Wrote {DEST} ({DEST.stat().st_size / 1024 / 1024:.1f} MiB)")


if __name__ == "__main__":
    main()
