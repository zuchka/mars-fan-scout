"""A small, private HTTP wrapper around the pinned Jev-Omni classifier.

The same response contract is used by the local MLX feasibility run and the
CUDA service mounted behind a private Hugging Face Inference Endpoint.
"""

import argparse
import base64
import binascii
import hashlib
import hmac
import importlib.util
import io
import json
import os
import tempfile
import time
from pathlib import Path
from threading import Lock
from uuid import uuid4

from fastapi import FastAPI, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from PIL import Image

MODEL_REPO = "akhilaaa3/Jev-Omni"
CUDA_REVISION = "5addda86ddee081a68fb067477ea100c221b8917"
MLX_SOURCE_REVISION = "c050d51354147985d13286cf4acf90f562f2c631"
OPTIONS = ("Fan", "Not a fan", "Unsure")
MAX_BODY = 4 * 1024 * 1024
MAX_IMAGE = 2 * 1024 * 1024
MAX_PIXELS = 1024 * 1024
PINNED_CUDA_HASHES = {
    "config.json": "346145528d5ee228965be07212dc3ef1bc442629b12ba71b92528ea57540faa5",
    "decision_config.json": "2cf5e5781871ed86be130abe0fccda8dbad35f32c6deebe08cd8f92f5f452200",
    "head.pt": "8c81edecd733f7db327604803c14cf9ecbee53d2af055eeb09f78b64bcbf2638",
    "jev_omni.py": "11d761b0b6cefc8aac29757f43af4b2b02af8f9b6c6dad19834c0b14538180f0",
    "model.safetensors": "d78782f3b9c3302353a7d1a1b6277fa5e05d692f4a0cb2b862797026c65eabe6",
}


def _sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for block in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


class MlxBackend:
    name = "mlx-4bit"
    revision = MLX_SOURCE_REVISION

    def __init__(self, path):
        path = Path(path).resolve()
        conversion = json.loads((path / "conversion.json").read_text())
        if conversion.get("source") != MODEL_REPO or conversion.get("revision") != self.revision or conversion.get("bits") != 4:
            raise RuntimeError("MLX conversion provenance does not match the pinned source")
        spec = importlib.util.spec_from_file_location("omni_mlx.classifier", path / "omni_mlx/classifier.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.classifier = module.Classifier(path)

    def predict(self, image, state, question, image_tokens):
        result = self.classifier.predict(state, question, list(OPTIONS), image, image_tokens or 70)
        return result["probabilities"], result.get("metrics", {})


class CudaBackend:
    name = "cuda-bf16"
    revision = CUDA_REVISION

    def __init__(self, path):
        import torch
        import transformers
        from transformers import AutoConfig, AutoProcessor

        if not torch.cuda.is_available():
            raise RuntimeError("The CUDA Jev service needs a GPU")
        path = Path(path).resolve()
        for name, expected in PINNED_CUDA_HASHES.items():
            if _sha256(path / name) != expected:
                raise RuntimeError(f"Pinned Jev artifact mismatch: {name}")
        spec = importlib.util.spec_from_file_location("jev_omni", path / "jev_omni.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        config = AutoConfig.from_pretrained(path, trust_remote_code=False)
        model = getattr(transformers, config.architectures[0]).from_pretrained(
            path, dtype=torch.bfloat16, device_map="cuda", trust_remote_code=False).eval()
        decision = json.loads((path / "decision_config.json").read_text())
        head = module._Head256(decision["hidden_size"]).to("cuda").eval()
        head.load_state_dict(torch.load(path / "head.pt", map_location="cuda", weights_only=True))
        _, decoder = module._find_backbone(model)
        self.classifier = module.JevOmni(model, head, AutoProcessor.from_pretrained(path), decoder, "cuda")

    def predict(self, image, state, question, _image_tokens):
        with tempfile.NamedTemporaryFile(suffix=".jpg") as temporary:
            image.save(temporary, format="JPEG", quality=95)
            temporary.flush()
            started = time.perf_counter()
            result = self.classifier.predict(state=state, question=question, options=list(OPTIONS),
                                             media=temporary.name, modality="image")
        return result["probabilities"], {"elapsed_ms": round((time.perf_counter() - started) * 1000),
                                          "generated_tokens": 0, "image_token_budget": None}


def create_app(backend, token=""):
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    lock = Lock()

    def authenticate(request):
        if token and not hmac.compare_digest(request.headers.get("authorization", ""), f"Bearer {token}"):
            raise HTTPException(status_code=401, detail="Unauthorized")

    @app.get("/health")
    def health(request: Request):
        authenticate(request)
        return {"ready": True, "model_repo": MODEL_REPO, "model_revision": backend.revision, "backend": backend.name}

    @app.post("/classify")
    async def classify(request: Request):
        authenticate(request)
        try:
            declared_size = int(request.headers.get("content-length", "0") or 0)
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid content length") from None
        if declared_size > MAX_BODY:
            raise HTTPException(status_code=413, detail="Request too large")
        body = await request.body()
        if len(body) > MAX_BODY:
            raise HTTPException(status_code=413, detail="Request too large")
        try:
            data = json.loads(body)
            if data.get("options") != list(OPTIONS):
                raise ValueError("Unexpected options")
            if not isinstance(data.get("state"), str) or not isinstance(data.get("question"), str):
                raise ValueError("Missing question")
            if len(data["state"]) > 2000 or len(data["question"]) > 200:
                raise ValueError("Prompt too large")
            tokens = data.get("image_tokens")
            if tokens is not None and tokens not in (20, 35, 70, 140, 280):
                raise ValueError("Invalid image token budget")
            encoded = data["image_base64"]
            if not isinstance(encoded, str) or len(encoded) > MAX_IMAGE * 4 // 3 + 4:
                raise ValueError("Invalid image")
            pixels = base64.b64decode(encoded, validate=True)
            if len(pixels) > MAX_IMAGE:
                raise ValueError("Image too large")
            with Image.open(io.BytesIO(pixels)) as opened:
                if opened.width * opened.height > MAX_PIXELS or opened.width < 32 or opened.height < 32:
                    raise ValueError("Image dimensions out of range")
                image = opened.convert("RGB")
        except (KeyError, TypeError, ValueError, binascii.Error, OSError, json.JSONDecodeError):
            raise HTTPException(status_code=400, detail="Invalid classification request") from None
        started = time.perf_counter()
        def predict():
            with lock:
                return backend.predict(image, data["state"], data["question"], tokens)

        try:
            probabilities, metrics = await run_in_threadpool(predict)
        except Exception:
            raise HTTPException(status_code=503, detail="Jev inference failed") from None
        if set(probabilities) != set(OPTIONS) or not all(isinstance(probabilities[o], (int, float)) for o in OPTIONS):
            raise HTTPException(status_code=503, detail="Jev returned invalid probabilities")
        prediction = max(OPTIONS, key=lambda option: probabilities[option])
        return {"model_repo": MODEL_REPO, "model_revision": backend.revision, "backend": backend.name,
                "request_id": str(uuid4()), "prediction": prediction, "probabilities": probabilities,
                "metrics": {**metrics, "service_elapsed_ms": round((time.perf_counter() - started) * 1000)}}

    return app


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--backend", choices=("mlx", "cuda"), required=True)
    parser.add_argument("--model-path", required=True)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    token = os.environ.get("JEV_INTERNAL_TOKEN", "")
    if args.host not in ("127.0.0.1", "localhost", "::1") and not token and os.environ.get("JEV_GATEWAY_AUTH") != "1":
        parser.error("Non-loopback binding requires a token or authenticated gateway")
    backend = MlxBackend(args.model_path) if args.backend == "mlx" else CudaBackend(args.model_path)
    import uvicorn
    uvicorn.run(create_app(backend, token), host=args.host, port=args.port, workers=1)


if __name__ == "__main__":
    main()
