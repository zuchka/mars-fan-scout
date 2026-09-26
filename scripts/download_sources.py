"""Download the public Planet Four catalog and four source HiRISE observations."""

from __future__ import annotations

from pathlib import Path
from urllib.request import urlretrieve

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / "data" / "planet-four"
CATALOG = "https://zenodo.org/api/records/20054589/files/"
CATALOG_FILES = [
    "P4_catalog_v3.1_L1C_cut_0.5_fan.csv",
    "P4_catalog_v3.1_tile_coords_final.csv",
    "P4_catalog_v3.1_metadata.csv",
]
OBSERVATIONS = ["ESP_011296_0975", "ESP_011404_0945", "ESP_011351_0945", "ESP_020146_0950"]


def download(url: str, path: Path):
    if path.exists() and path.stat().st_size:
        print("cached", path.name)
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    print("downloading", path.name, flush=True)
    urlretrieve(url, path)


def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    for filename in CATALOG_FILES:
        download(CATALOG + filename + "/content", OUTPUT / filename)
    for obs in OBSERVATIONS:
        number = int(obs.split("_")[1])
        folder = f"ORB_{number // 100 * 100:06d}_{number // 100 * 100 + 99:06d}"
        stem = f"PDS/RDR/ESP/{folder}/{obs}/{obs}_RED"
        download("https://hirise-pds.lpl.arizona.edu/" + stem + ".LBL", OUTPUT / "images" / f"{obs}_RED.LBL")
        download("https://hirise-pds.lpl.arizona.edu/download/" + stem + ".JP2", OUTPUT / "images" / f"{obs}_RED.JP2")


if __name__ == "__main__":
    main()
