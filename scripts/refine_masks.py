"""Create catalog-guided dark-fan masks for a second Roboflow experiment.

The source catalog supplies candidate fan locations. Local image contrast
snaps those approximate wedges to dark deposits; a candidate with no nearby
deposit is dropped. This is deliberately a weak-label refinement, not a claim
of hand-verified pixel ground truth.
"""

from __future__ import annotations

import json
import shutil
import zipfile
from pathlib import Path

import cv2
import numpy as np

from export_coco import OUT as SOURCE_DATASET

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / "training" / "refined-coco"
ARCHIVE = ROOT / "training" / "mars-weather-refined-coco.zip"


def dark_components(image: np.ndarray):
    background = cv2.GaussianBlur(image, (0, 0), sigmaX=22)
    contrast = background.astype(np.int16) - image.astype(np.int16)
    threshold = max(27, float(np.quantile(contrast, .86)))
    mask = np.uint8(contrast >= threshold)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask)
    eligible = {i for i in range(1, count) if 75 <= stats[i, cv2.CC_STAT_AREA] <= 12000}
    return labels, stats, eligible


def refine_image(image: np.ndarray, annotations: list[dict]):
    labels, stats, eligible = dark_components(image)
    candidates = []
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (31, 31))
    for annotation in annotations:
        points = np.asarray(annotation["segmentation"][0], dtype=np.float32).reshape(-1, 2)
        if len(points) < 3:
            continue
        approximate = np.zeros_like(image, dtype=np.uint8)
        cv2.fillPoly(approximate, [np.rint(points).astype(np.int32)], 1)
        nearby = cv2.dilate(approximate, kernel)
        ids, counts = np.unique(labels[nearby > 0], return_counts=True)
        for component, intersection in zip(ids, counts):
            if component not in eligible:
                continue
            area = int(stats[component, cv2.CC_STAT_AREA])
            if intersection < 10:
                continue
            exact = int(np.count_nonzero((labels == component) & (approximate > 0)))
            score = exact / area + .5 * intersection / area
            candidates.append((score, int(component), annotation))
    matched = {}
    for score, component, annotation in sorted(candidates, key=lambda item: item[0], reverse=True):
        if component in matched or score < .10:
            continue
        matched[component] = annotation
    refined = []
    for component, annotation in matched.items():
        binary = np.uint8(labels == component)
        contours, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not contours:
            continue
        contour = max(contours, key=cv2.contourArea)
        simplified = cv2.approxPolyDP(contour, 1.4, True).reshape(-1, 2)
        if len(simplified) < 3:
            continue
        x, y, width, height = cv2.boundingRect(contour)
        if max(width, height) / max(1, min(width, height)) > 10:
            continue
        copy = dict(annotation)
        copy["segmentation"] = [simplified.astype(float).ravel().tolist()]
        copy["area"] = int(stats[component, cv2.CC_STAT_AREA])
        copy["bbox"] = [int(x), int(y), int(width), int(height)]
        refined.append(copy)
    return refined


def main():
    totals = {}
    for split in ("train", "valid", "test"):
        source_split = "train" if split == "train" else "valid"
        source_dir = SOURCE_DATASET / source_split
        source = json.loads((source_dir / "_annotations.coco.json").read_text())
        images = sorted(source["images"], key=lambda record: record["file_name"])
        if split != "train":
            midpoint = len(images) // 2
            images = images[:midpoint] if split == "valid" else images[midpoint:]
        destination = DEST / split
        destination.mkdir(parents=True, exist_ok=True)
        annotations_by_image = {}
        for annotation in source["annotations"]:
            annotations_by_image.setdefault(annotation["image_id"], []).append(annotation)
        out = {key: source[key] for key in ("info", "licenses", "categories")}
        out["images"] = images
        out["annotations"] = []
        for record in images:
            filename = record["file_name"]
            shutil.copy2(source_dir / filename, destination / filename)
            pixels = cv2.imread(str(destination / filename), cv2.IMREAD_GRAYSCALE)
            refined = refine_image(pixels, annotations_by_image.get(record["id"], []))
            for annotation in refined:
                annotation["id"] = len(out["annotations"]) + 1
                out["annotations"].append(annotation)
        (destination / "_annotations.coco.json").write_text(json.dumps(out, separators=(",", ":")))
        totals[split] = {"images": len(images), "original_labels": sum(len(annotations_by_image.get(record["id"], [])) for record in images), "refined_labels": len(out["annotations"])}
    with zipfile.ZipFile(ARCHIVE, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for path in DEST.rglob("*"):
            if path.is_file():
                archive.write(path, path.relative_to(DEST))
    (DEST / "manifest.json").write_text(json.dumps({"source": "Planet Four v3.1 catalog + HiRISE", "label_type": "catalog-guided adaptive dark-mask weak labels", "splits": totals}, indent=2))
    print(json.dumps(totals, indent=2))
    print(ARCHIVE)


if __name__ == "__main__":
    main()
