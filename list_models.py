import os
from dotenv import load_dotenv
from google import genai

load_dotenv()
api_key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GENAI_API_KEY")
print(f"Using key: {api_key[:8]}...")

client = genai.Client(api_key=api_key)

print("\nAvailable models:")
for m in client.models.list():
    print(f"  {m.name}")
