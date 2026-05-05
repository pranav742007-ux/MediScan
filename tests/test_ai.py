import os
from google import genai as genai_sdk
from dotenv import load_dotenv

# 1. Load the environment variables
load_dotenv()
api_key = os.environ.get("GEMINI_API_KEY")

if not api_key:
    api_key = os.environ.get("GENAI_API_KEY")

print(f"Checking Key: {api_key[:5] if api_key else 'None'}... (Length: {len(api_key) if api_key else 0})")


if not api_key:
    print("FAIL: No API key found. Check your .env file name and location.")
else:
    try:
        # 2. Configure and Call the API
        client = genai_sdk.Client(api_key=api_key)
        
        print("Sending request to Google servers...")
        response = client.models.generate_content(
            model="gemini-2.5-flash",
            contents="Say the word 'Success'"
        )
        
        print("\nRESULT: IT WORKS!")
        print("AI Response:", response.text)
        
    except Exception as e:
        print("\nRESULT: API ERROR!")
        print("Exact details:", str(e))