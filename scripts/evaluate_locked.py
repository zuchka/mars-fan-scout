"""Run the frozen model once on the preregistered, hand-marked 2024 crops."""
from __future__ import annotations

import base64
import json
import math
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[2]
EVAL = ROOT / "mars-weather/evaluation/locked"
ANNOTATIONS = json.loads((EVAL / "review-points.json").read_text())
MANIFEST = {item["id"]: item for item in json.loads((EVAL / "manifest.json").read_text())}
ENV = dict(line.split("=", 1) for line in (ROOT / "mars-weather/.env.local").read_text().splitlines() if "=" in line)
MODEL = ENV["ROBOFLOW_MODEL_ID"]
THRESHOLD = ANNOTATIONS["confidence_threshold_frozen_before_review"]
TOLERANCE = ANNOTATIONS["matching_tolerance_px"]


def center(prediction):
    points = prediction.get("points") or prediction.get("polygon") or []
    if not points:
        return None
    xy = [(float(point["x"]), float(point["y"])) if isinstance(point, dict) else
          (float(point[0]), float(point[1])) for point in points]
    return [(min(x for x, _ in xy) + max(x for x, _ in xy)) / 2,
            (min(y for _, y in xy) + max(y for _, y in xy)) / 2]


def infer(path):
    url = "https://serverless.roboflow.com/" + MODEL + "?" + urlencode(
        {"api_key": ENV["ROBOFLOW_API_KEY"], "confidence": 0.2}
    )
    body = base64.b64encode(path.read_bytes())
    with urlopen(Request(url, data=body, headers={"content-type": "application/x-www-form-urlencoded"}), timeout=50) as response:
        return json.load(response)


def main():
    if MODEL != ANNOTATIONS["model_id_frozen_before_review"]:
        raise ValueError("The configured model differs from the frozen evaluation model")
    output = EVAL / "predictions"
    output.mkdir(exist_ok=True)
    rows = []
    for crop in ANNOTATIONS["crops"]:
        id_ = crop["id"]
        response = infer(EVAL / MANIFEST[id_]["image"])
        (output / f"{id_}.json").write_text(json.dumps(response))
        gt = crop["points_px"]
        considered = []
        ignored = []
        for prediction in response.get("predictions", []):
            if prediction.get("confidence", 0) < THRESHOLD:
                continue
            point = center(prediction)
            if point is None:
                continue
            item = {"confidence": round(prediction["confidence"], 4),
                    "center_px": [round(value, 1) for value in point]}
            if any(math.dist(point, region[:2]) <= region[2] for region in crop["uncertain_regions_px"]):
                ignored.append(item)
            else:
                considered.append(item)
        pairs = sorted(
            (math.dist(pred["center_px"], truth), pi, gi)
            for pi, pred in enumerate(considered)
            for gi, truth in enumerate(gt)
            if math.dist(pred["center_px"], truth) <= TOLERANCE
        )
        matched_predictions, matched_gt = set(), set()
        for distance, pi, gi in pairs:
            if pi in matched_predictions or gi in matched_gt:
                continue
            matched_predictions.add(pi)
            matched_gt.add(gi)
            considered[pi]["matched_gt_index"] = gi
            considered[pi]["match_distance_px"] = round(distance, 1)
        rows.append({
            "id": id_, "visible_clear_deposits": len(gt), "predictions_considered": len(considered),
            "matched": len(matched_gt), "unmatched_predictions": len(considered)-len(matched_predictions),
            "missed_deposits": len(gt)-len(matched_gt), "predictions_excluded_as_ambiguous_or_edge": len(ignored),
            "candidate_details": considered, "excluded_candidate_details": ignored,
        })
        print(f"{id_}: {len(matched_gt)} matched / {len(gt)} visible; {len(considered)-len(matched_predictions)} unmatched predictions; {len(ignored)} excluded")
    matched = sum(row["matched"] for row in rows)
    false_positive = sum(row["unmatched_predictions"] for row in rows)
    visible = sum(row["visible_clear_deposits"] for row in rows)
    result = {
        "model_id": MODEL, "evaluated_at": datetime.now(timezone.utc).isoformat(),
        "observation": ANNOTATIONS["observation"], "threshold": THRESHOLD,
        "method": "Non-expert pre-model point marks, one-to-one center matching within 75 pixels, preregistered ambiguous/edge exclusions. No catalog lookup.",
        "sample_crops": len(rows), "visible_clear_deposits": visible, "matched_deposits": matched,
        "unmatched_predictions": false_positive, "ignored_predictions": sum(row["predictions_excluded_as_ambiguous_or_edge"] for row in rows),
        "candidate_precision": matched / (matched + false_positive) if matched + false_positive else None,
        "deposit_recall": matched / visible if visible else None, "crops": rows,
    }
    (EVAL / "score.json").write_text(json.dumps(result, indent=2) + "\n")
    print("Precision", result["candidate_precision"], "Recall", result["deposit_recall"], "on", visible, "marked deposits")


if __name__ == "__main__":
    main()
