# Jev-Omni inference for Mars Fan Scout

Roboflow remains the detector. This service scores one orange-outlined candidate image against the fixed options `Fan`, `Not a fan`, and `Unsure`. It uses Jev-Omni's trained decision head, so it returns option probabilities and no generated explanation. The Sprite applies a separately recorded review rule and retains every candidate for a human.

## Local feasibility run

The Apple Silicon path uses the independent [4-bit MLX conversion](https://huggingface.co/Ruiruiz30/Jev-Omni-MLX-4bit) pinned to revision `3ec255958b8b650e8d01be10af7e11741867ce3f`. That conversion identifies upstream Jev source revision `c050d51354147985d13286cf4acf90f562f2c631`. It is only a feasibility backend; its scores must not be passed off as identical to the CUDA build.

```sh
python3.13 -m venv .jev-venv
.jev-venv/bin/pip install -r jev-runtime/requirements-mlx.txt
.jev-venv/bin/hf download Ruiruiz30/Jev-Omni-MLX-4bit \
  --revision 3ec255958b8b650e8d01be10af7e11741867ce3f \
  --local-dir .models/Jev-Omni-MLX-4bit
.jev-venv/bin/python jev-runtime/service.py --backend mlx \
  --model-path .models/Jev-Omni-MLX-4bit
```

In a separate terminal, set `REVIEW_AGENT_ENABLED=1`, `REVIEW_AGENT_DAILY_CALL_LIMIT=10`, `JEV_BACKEND=mlx-4bit`, `JEV_SERVICE_URL=http://127.0.0.1:8765`, and `JEV_IMAGE_TOKENS=70` in the private `.env.local`, then start the Node app. The Python process loads the model once. On this M3/16 GB Mac, one real Mars candidate completed two successive classifications with a verified wider crop; the first call took 25 seconds and the second 7 seconds. Those are local observations, not promised latency.

## Live Sprite via a private GPU endpoint

The live CUDA service is packaged by [the GitHub Actions workflow](../.github/workflows/jev-service.yml) as `ghcr.io/zuchka/mars-fan-scout-jev:<commit-sha>`. Its container expects the **original** `akhilaaa3/Jev-Omni` model, pinned to revision `5addda86ddee081a68fb067477ea100c221b8917`, mounted at `/repository`. It verifies the pinned config, head, loader, and model weight hashes at startup. The service returns `backend=cuda-bf16` and that revision in `/health` and every classification response. It never generates scientific directions.

For a [Hugging Face Inference Endpoint](https://huggingface.co/docs/inference-endpoints/engines/custom_container), select the pinned model revision, a custom container with the immutable image tag, port `8000`, health route `/health`, and **Private** authentication. Set the endpoint environment variable `JEV_GATEWAY_AUTH=1` only after selecting Private, so the service accepts traffic through that authenticated gateway. Start with one NVIDIA L40S (48 GB) and verify startup memory and latency before relying on it for the interview. The [listed rate](https://huggingface.co/docs/inference-endpoints/pricing) is $1.80 per running hour at the time this was written; actual billing, quotas, and availability depend on the account. Wake the endpoint before a live demo, then let it scale to zero after idle time. The user account needs a Hugging Face subscription/payment method and an endpoint access token. No OpenAI API key is used.

Place the private endpoint URL and token only in the Sprite's permission-restricted `.env.local`:

```ini
REVIEW_AGENT_ENABLED=1
REVIEW_AGENT_DAILY_CALL_LIMIT=20
JEV_BACKEND=cuda-bf16
JEV_SERVICE_URL=https://your-private-endpoint.endpoints.huggingface.cloud
JEV_SERVICE_TOKEN=your-private-endpoint-access-token
JEV_MIN_PROBABILITY=0.8
JEV_MIN_MARGIN=0.25
JEV_COMPUTE_USD_PER_HOUR=1.8
```

The Sprite requires HTTPS and a bearer token for a remote service. It probes the pinned model and backend at startup; if a Hugging Face endpoint is still cold, review stays available and each response is checked against the pinned identity. Requests can wait up to ten minutes for a scaled-to-zero endpoint to wake. The daily limit caps calls from this app, **not** GPU hosting time. In the export, `cost_usd` estimates request wall time at the configured hourly rate, not the provider bill; the endpoint bill also includes initialization and idle running minutes.

The example limit of 20 is for a small live demonstration. A full 44-candidate pilot can make two calls per candidate, so raise the daily limit to at least 88 for that run and check the endpoint's actual billing controls. This is a call allowance, not a spending ceiling.

After deployment, review one development candidate end to end and inspect both the trace and human queue. Before reporting any pilot result, label the frozen 44-candidate set blind, verify that it includes obvious false positives and ambiguous shapes, freeze the thresholds and input format, and run the complete set with the live CUDA backend. The local MLX scores are separate development evidence.
