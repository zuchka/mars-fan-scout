import base64
import importlib.util
import io
import unittest
from pathlib import Path

from fastapi.testclient import TestClient
from PIL import Image

spec = importlib.util.spec_from_file_location("jev_service", Path(__file__).with_name("service.py"))
service = importlib.util.module_from_spec(spec)
spec.loader.exec_module(service)


class FakeBackend:
    name = "cuda-bf16"
    revision = service.CUDA_REVISION

    def predict(self, image, state, question, image_tokens):
        assert image.size == (64, 64)
        assert "Mars" in state
        assert question
        return {"Fan": 0.92, "Not a fan": 0.04, "Unsure": 0.04}, {"generated_tokens": 0}


class JevServiceTest(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(service.create_app(FakeBackend(), token="private-test-token"))
        image = Image.new("RGB", (64, 64), "#664433")
        buffer = io.BytesIO()
        image.save(buffer, format="JPEG")
        self.body = {"image_base64": base64.b64encode(buffer.getvalue()).decode(),
                     "state": "Mars south-polar crop", "question": "Is this a fan?",
                     "options": list(service.OPTIONS), "image_tokens": None}
        self.headers = {"Authorization": "Bearer private-test-token"}

    def test_authenticated_health_and_three_way_classification(self):
        self.assertEqual(self.client.get("/health").status_code, 401)
        health = self.client.get("/health", headers=self.headers).json()
        self.assertTrue(health["ready"])
        self.assertEqual(health["model_revision"], service.CUDA_REVISION)
        response = self.client.post("/classify", headers=self.headers, json=self.body)
        self.assertEqual(response.status_code, 200)
        result = response.json()
        self.assertEqual(result["prediction"], "Fan")
        self.assertEqual(set(result["probabilities"]), set(service.OPTIONS))
        self.assertEqual(result["backend"], "cuda-bf16")

    def test_invalid_image_and_changed_options_are_rejected(self):
        changed = {**self.body, "options": ["Yes", "No"]}
        self.assertEqual(self.client.post("/classify", headers=self.headers, json=changed).status_code, 400)
        corrupt = {**self.body, "image_base64": "broken!!"}
        self.assertEqual(self.client.post("/classify", headers=self.headers, json=corrupt).status_code, 400)


if __name__ == "__main__":
    unittest.main()
