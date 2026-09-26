"""Export Planet Four fan wedges as a COCO instance-segmentation starter set.

The polygons approximate citizen fan markings and should be spot-checked in
Roboflow Annotate before training. Split is by HiRISE observation.
"""

from __future__ import annotations

import json
import math
import zipfile
from collections import Counter, defaultdict
from pathlib import Path

from prepare_data import ROOT, SOURCE, records, fit_transform, fan_geometry, image_chip

OUT = ROOT / "mars-weather" / "training" / "roboflow-coco"
TRAIN_OBS = ["ESP_011296_0975", "ESP_011404_0945", "ESP_011351_0945"]
VALID_OBS = ["ESP_020146_0950"]
CHIP = 768


def clip_polygon(points, size=CHIP):
    def clip(edge, inside, intersection):
        result = []
        for a, b in zip(edge, edge[1:] + edge[:1]):
            ai, bi = inside(a), inside(b)
            if ai and bi:
                result.append(b)
            elif ai and not bi:
                result.append(intersection(a, b))
            elif not ai and bi:
                result.extend((intersection(a, b), b))
        return result
    clipped = list(points)
    for axis, boundary, greater in ((0, 0, True), (0, size-1, False), (1, 0, True), (1, size-1, False)):
        if not clipped:
            break
        inside = lambda p, ax=axis, bound=boundary, gt=greater: p[ax] >= bound if gt else p[ax] <= bound
        def crossing(a, b, ax=axis, bound=boundary):
            denom = b[ax] - a[ax]
            t = (bound - a[ax]) / denom if abs(denom) > 1e-9 else 0
            return (a[0] + t * (b[0]-a[0]), a[1] + t * (b[1]-a[1]))
        clipped = clip(clipped, inside, crossing)
    return clipped


def area(points):
    return abs(sum(a[0]*b[1]-b[0]*a[1] for a,b in zip(points,points[1:]+points[:1])) / 2)


def choose_tiles(rows, fans, limit):
    count = Counter(r["y_tile"] for r in fans if int(float(r["n_votes"] or 0)) >= 5)
    ranked = sorted(rows, key=lambda r: count[r["y_tile"]], reverse=True)
    chosen = []
    for row in ranked:
        y = float(row["y_hirise"])
        if any(abs(y - float(existing["y_hirise"])) < 820 for existing in chosen):
            continue
        chosen.append(row)
        if len(chosen) >= limit:
            break
    return sorted(chosen, key=lambda r: float(r["y_hirise"]))


def main():
    tiles = defaultdict(list)
    for row in records("P4_catalog_v3.1_tile_coords_final.csv"):
        if row["obsid"] in TRAIN_OBS + VALID_OBS:
            tiles[row["obsid"]].append(row)
    fans = defaultdict(list)
    for row in records("P4_catalog_v3.1_L1C_cut_0.5_fan.csv"):
        if row["obsid"] in TRAIN_OBS + VALID_OBS:
            if int(float(row["n_votes"] or 0)) >= 5 and 6 <= float(row["distance"]) <= 400:
                fans[row["obsid"]].append(row)
    annotations_by_split = {}
    summary = {}
    for split, observations, per_obs in (("train", TRAIN_OBS, 23), ("valid", VALID_OBS, 18)):
        directory = OUT / split
        directory.mkdir(parents=True, exist_ok=True)
        coco = {"info":{"description":"Mars south polar fan markings from Planet Four v3.1 / HiRISE"},"licenses":[],"categories":[{"id":1,"name":"fan","supercategory":"seasonal-deposit"}],"images":[],"annotations":[]}
        annot_id = 1
        for obs in observations:
            transform = fit_transform(obs, tiles[obs])
            for tile in choose_tiles(tiles[obs], fans[obs], per_obs):
                center = transform.point(float(tile["x_hirise"]), float(tile["y_hirise"]))
                x0, y0 = round(center[0] - CHIP/2), round(center[1] - CHIP/2)
                if x0 < 0 or y0 < 0 or x0 + CHIP > transform.label["samples"] or y0 + CHIP > transform.label["lines"]:
                    continue
                filename = obs + "_" + tile["tile_id"] + ".jpg"
                image_id = len(coco["images"]) + 1
                if not (directory / filename).exists():
                    image_chip(obs, (x0,y0,x0+CHIP,y0+CHIP), directory / filename)
                coco["images"].append({"id":image_id,"file_name":filename,"width":CHIP,"height":CHIP,"license":0})
                for fan in fans[obs]:
                    geom = fan_geometry(fan,transform)
                    if geom is None:
                        continue
                    polygon = [(x-x0,y-y0) for x,y in geom[1]]
                    if max(x for x,y in polygon) < 0 or min(x for x,y in polygon) >= CHIP or max(y for x,y in polygon) < 0 or min(y for x,y in polygon) >= CHIP:
                        continue
                    polygon = clip_polygon(polygon)
                    if len(polygon) < 3 or area(polygon) < 25:
                        continue
                    xs=[p[0] for p in polygon]; ys=[p[1] for p in polygon]
                    coco["annotations"].append({
                        "id":annot_id,"image_id":image_id,"category_id":1,
                        "segmentation":[[round(v,2) for point in polygon for v in point]],
                        "area":round(area(polygon),2),
                        "bbox":[round(min(xs),2),round(min(ys),2),round(max(xs)-min(xs),2),round(max(ys)-min(ys),2)],
                        "iscrowd":0,
                    })
                    annot_id += 1
            print(split, obs, "done", flush=True)
        (directory / "_annotations.coco.json").write_text(json.dumps(coco,separators=(",",":")))
        annotations_by_split[split]=coco
        summary[split]={"observations":observations,"images":len(coco["images"]),"fan_polygons":len(coco["annotations"])}
    manifest = {"source_catalog":"https://zenodo.org/records/20054589","label_type":"approximate Planet Four fan wedges","split_policy":"observation-level","splits":summary}
    (OUT / "manifest.json").write_text(json.dumps(manifest,indent=2))
    archive = OUT.parent / "mars-weather-roboflow-coco.zip"
    with zipfile.ZipFile(archive,"w",compression=zipfile.ZIP_DEFLATED,compresslevel=6) as z:
        for path in OUT.rglob("*"):
            if path.is_file():
                z.write(path,path.relative_to(OUT))
    print(json.dumps(summary,indent=2))
    print("archive",archive)


if __name__ == "__main__":
    main()
