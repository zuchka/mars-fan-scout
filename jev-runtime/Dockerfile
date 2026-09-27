FROM pytorch/pytorch:2.9.1-cuda12.8-cudnn9-runtime

WORKDIR /app
COPY requirements-cuda.txt /app/requirements-cuda.txt
RUN python -m pip install --no-cache-dir -r /app/requirements-cuda.txt
COPY service.py /app/service.py

ENV JEV_GATEWAY_AUTH=1
EXPOSE 8000
CMD ["python", "/app/service.py", "--backend", "cuda", "--model-path", "/repository", "--host", "0.0.0.0", "--port", "8000"]
