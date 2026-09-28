"""Pick complete chips across training observations for manual mask correction."""

import json
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TRAIN = ROOT / "training" / "refined-coco" / "train"
OUTPUT = ROOT / "evaluation" / "demo-repair" / "annotation-queue.json"


def main():
    coco = json.loads((TRAIN / "_annotations.coco.json").read_text())
    counts = defaultdict(int)
    for annotation in coco["annotations"]:
        counts[annotation["image_id"]] += 1
    groups = defaultdict(list)
    for image in coco["images"]:
        name = image["file_name"]
        observation = "_".join(name.split("_")[:3])
        groups[observation].append((counts[image["id"]], name))
    queue = []
    for observation, items in sorted(groups.items()):
        items.sort()
        # Cover sparse, typical, and dense chips without taking adjacent ranks only.
        indices = sorted({round(index * (len(items) - 1) / 7) for index in range(8)})
        for index in indices:
            count, name = items[index]
            queue.append({"observation": observation, "image": name,
                          "weak_mask_count": count, "status": "needs_complete_human_annotation",
                          "local_image": f"training/refined-coco/train/{name}"})
    OUTPUT.write_text(json.dumps({"format": "mars-fan-annotation-queue-v1",
                                  "rule_file": "evaluation/demo-repair/ANNOTATION_GUIDE.md",
                                  "chips": queue}, indent=2) + "\n")
    print(json.dumps({"observations": {key: len(value) for key, value in groups.items()},
                      "selected_chips": len(queue)}))


if __name__ == "__main__":
    main()
