"""Verify all issues from both audit rounds are fixed."""
import sys

with open('app.py', 'r', encoding='utf-8') as f:
    lines = f.readlines()
    content = ''.join(lines)

passed = 0
failed = 0

def check(name, condition):
    global passed, failed
    if condition:
        print(f"  [OK] {name}")
        passed += 1
    else:
        print(f"  [FAIL] {name}")
        failed += 1

print("=== ROUND 1: Previous Audit Issues ===")
check("CSP has no unsafe-eval", 'unsafe-eval' not in content)

with open('render.yaml') as f:
    ry = f.read()
check("Invite code not in render.yaml", 'MEDISCAN2026' not in ry)

pil_in_func = False
for i, line in enumerate(lines, 1):
    if 'from PIL import Image' in line and len(line) - len(line.lstrip()) > 8:
        pil_in_func = True
check("PIL import at module level only", not pil_in_func)

idx = content.index('def api_search')
chunk = content[idx:idx+500]
check("api_search uses get_db()", 'get_db_connection()' not in chunk and 'get_db()' in chunk)

login_start = content.index('def api_login')
check("Rate limiting on login", '_check_rate_limit' in content[login_start:login_start+500])

reg_start = content.index('def api_register')
check("Rate limiting on register", '_check_rate_limit' in content[reg_start:reg_start+500])

print("\n=== ROUND 2: Full Code Audit Issues ===")
check("init_db() called at startup", 'with app.app_context()' in content and 'init_db()' in content)

reg_fn = content[content.index('def api_register'):content.index('def api_login')]
check("register uses module-level COMPANY_INVITE_CODE", 
      'os.environ.get("COMPANY_INVITE_CODE"' not in reg_fn)

login_fn = content[content.index('def api_login'):content.index('def api_logout')]
check("login returns upgraded role (not stale)", 
      '"role": role,' in login_fn and '"role": user["role"]' not in login_fn)

chat_fn = content[content.index('def api_chat'):content.index('def api_upload_medicine')]
check("GENAI_API_KEY dead code removed", 'GENAI_API_KEY' not in chat_fn)

check("scan_count is incremented on verify", 'scan_count = scan_count + 1' in content)
check("FLASK_DEBUG defaults to false", '"FLASK_DEBUG", "false"' in content)
check("Image = None fallback in except", 'Image = None' in content)

print(f"\n=== {passed} passed, {failed} failed ===")
if failed > 0:
    sys.exit(1)
