"""Save verified Roboflow API responses for an explicitly labeled offline replay."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
BASE = "http://127.0.0.1:4173"
SCENES = json.loads((ROOT / "public" / "scenes.json").read_text())


def get_json(request: Request) -> dict:
    with urlopen(request, timeout=90) as response:
        return json.load(response)


def main() -> None:
    status = get_json(Request(BASE + "/api/status"))
    if not status.get("ready") or status.get("mode") != "live" or not status.get("model_id"):
        raise SystemExit("Start the server with a ready live Roboflow model before recording")
    destination = ROOT / "recorded"
    destination.mkdir(exist_ok=True)
    for scene in SCENES:
        request = Request(
            BASE + "/api/infer",
            data=json.dumps({"sceneId": scene["id"]}).encode(),
            headers={"content-type": "application/json"},
        )
        result = get_json(request)
        if not isinstance(result.get("predictions"), list):
            raise SystemExit("Roboflow returned an unexpected response for " + scene["id"])
        payload = {
            "model_id": status["model_id"],
            "recorded_at": datetime.now(timezone.utc).isoformat(),
            "scene_id": scene["id"],
            "response": result,
        }
        target = destination / (scene["id"] + ".json")
        target.write_text(json.dumps(payload, separators=(",", ":")))
        print(scene["id"], len(result["predictions"]), "masks", target)


if __name__ == "__main__":
    main()
