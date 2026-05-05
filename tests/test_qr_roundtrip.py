import base64
import io
import sys
import json

import requests

BASE = "http://localhost:5000"

# generate QR
resp = requests.post(
    BASE + "/api/generate-qr", json={"medicine": {"name": "RTTest", "dosage": "10mg"}}
)
print("generate status", resp.status_code)
try:
    j = resp.json()
except Exception as e:
    print("generate json error", e, resp.text)
    sys.exit(1)
if "image" not in j:
    print("no image in response", j)
    sys.exit(1)

b64 = j["image"]
img = base64.b64decode(b64)
# post as file
files = {"file": ("q.png", io.BytesIO(img), "image/png")}
resp2 = requests.post(BASE + "/api/scan-qr", files=files)
print("scan status", resp2.status_code)
try:
    print(json.dumps(resp2.json(), indent=2))
except Exception as e:
    print("scan json error", e, resp2.text)
