# MediScan 💊

**Medicine Info & Anti-Counterfeit Verification Platform**

A full-stack web application that lets consumers look up medicine safety data and verify drug authenticity through cryptographically signed QR codes — while giving pharmaceutical companies a portal to register their products on the network.

🔗 **Live Demo:** [mediscan-prga.onrender.com](https://mediscan-prga.onrender.com)
🏢 **Company Portal:** [mediscan-prga.onrender.com/company](https://mediscan-prga.onrender.com/company)

> ⏳ **Note:** The demo runs on Render's free tier. First load may take ~30 seconds if the server has been sleeping.

---

## What It Does

### For Consumers (User App)
- **Medicine Lookup** — Search 100+ medicines by name, brand, or Hindi/regional keywords. Returns dosage, side effects, warnings, and safety level.
- **QR/Barcode Scanning** — Scan a MediScan QR code (via camera or image upload) to verify if a medicine is genuine or potentially counterfeit.
- **Anti-Counterfeit Verification** — HMAC-SHA256 cryptographic signatures are embedded in each QR code. On scan, the signature is verified against the server-side secret. Mismatches trigger a counterfeit warning.
- **Drug Interaction Checker** — Automatically checks if your current scan conflicts with your previous scan against a database of 20+ known dangerous drug pairs.
- **AI Pharmacist (Dr. Medi)** — Powered by Google Gemini 2.5 Pro. Ask follow-up questions about any scanned medicine in 9 Indian languages.
- **Pill Reminders** — Set local push notification reminders for medication schedules.
- **Offline Fallback** — If the server is unreachable, a bundled local database of 10 common medicines provides basic lookup.

### For Pharmaceutical Companies (Company Portal)
- **Medicine Registration** — Upload medicine data (name, dosage, side effects, warnings, disposal instructions, manufacturing/expiry dates).
- **Cryptographic Code Generation** — Each registered medicine gets a unique QR code (with HMAC signature + serial number) and a 1D barcode (short code like `MED-A1B2C3`) for printing on packaging.
- **Dashboard** — View all uploaded medicines, regenerate codes, delete entries.

---

## Architecture

```
┌─────────────────┐         ┌──────────────────┐
│   Browser (PWA) │◄───────►│   Flask Backend   │
│                 │  REST   │                   │
│  - script.js    │  JSON   │  - app.py         │
│  - company.js   │         │  - medicines_data │
│  - Service Worker│        │                   │
└────────┬────────┘         └───────┬───────────┘
         │                          │
         │                          ├── PostgreSQL (Neon)
         │                          │   └── users, medicines, scan_history
         │                          │
         │                          ├── Google Gemini 2.5 Pro
         │                          │   └── AI chat (Dr. Medi)
         │                          │
         │                          └── Google OAuth 2.0
         │                              └── SSO authentication
         │
         └── jsQR (client-side QR decode)
             └── Barcode Detection API (hardware-accelerated)
```

### Key Technical Decisions

| Decision | Rationale |
|----------|-----------|
| **HMAC-SHA256 over asymmetric crypto** | Symmetric signing is simpler and sufficient for a prototype where the server both signs and verifies. In production, you'd use ECDSA with the company holding the private key. |
| **No scan-count clone detection** | Initially implemented a "first scan = genuine, subsequent scans = possible clone" system. Removed it because it penalizes legitimate users who scan the same medicine multiple times. This was a deliberate product decision to prioritize user access to safety information over theoretical anti-cloning. |
| **CursorWrapper DB abstraction** | SQLite for local development, PostgreSQL (Neon) for production — the same queries work on both because CursorWrapper translates `?` → `%s` and `AUTOINCREMENT` → `SERIAL` at execution time. |
| **Fuzzy matching with SequenceMatcher** | Users often misspell medicine names or use colloquial abbreviations. The search first tries SQL `LIKE`, then falls back to fuzzy string matching (threshold ≥ 0.55) against all medicines including Hindi keywords. |
| **Client-side QR decoding** | jsQR runs entirely in the browser. The camera feed is decoded frame-by-frame in JavaScript without sending video to the server — keeping scan latency under 200ms and avoiding bandwidth costs. |

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Backend** | Python 3.11, Flask 3.0, Gunicorn (gthread) |
| **Database** | PostgreSQL via Neon (prod), SQLite (dev) |
| **AI** | Google Gemini 2.5 Pro via `google-genai` SDK |
| **Auth** | Google OAuth 2.0 + session-based email/password |
| **Frontend** | Vanilla HTML/CSS/JS (no framework), PWA with Service Worker |
| **QR/Barcode** | `qrcode` + `python-barcode` (generation), jsQR (client-side decode) |
| **Hosting** | Render (Docker) |
| **Security** | HMAC-SHA256 signing, CSP headers, HSTS, ProxyFix |

---

## Database Schema

```sql
-- Users: Both consumers and pharmaceutical companies
users (id, name, email, password, role, profile_data)
       -- role: 'user' | 'company'
       -- profile_data: JSON blob (age, blood group, allergies, etc.)

-- Medicine registry: Seeded with 100+ common drugs, companies can add more
medicines (id, name, strength, brands, category, safety, uses, dosage,
           sideEffects, warnings, disposal, mfg_date, exp_date, keywords, company_id)

-- Anti-counterfeit ledger: Tracks every QR code ever generated
scan_history (serial_no, short_code, med_id, first_scanned_at, scan_count)
              -- serial_no: UUID (embedded in QR's HMAC payload)
              -- short_code: Human-readable barcode like "MED-K9B3A1"
```

---

## Security Model

### What's Implemented
- **HMAC-SHA256 signed QR codes** — Server-side secret signs `{med_id}:{med_name}:{serial_no}`. Tampering with any field invalidates the signature.
- **Company invite code** — Server-side environment variable (`COMPANY_INVITE_CODE`). Required to register as a pharmaceutical company. **Not exposed in frontend JavaScript** — the code is submitted in the request body and validated entirely on the backend.
- **Session security** — `HttpOnly`, `SameSite=Lax`, `Secure` (in production). 24-hour expiry.
- **CSP, HSTS, X-Frame-Options** — Standard security headers on all responses.
- **Rate limiting** — AI chat endpoint limited to 10 requests/minute per IP.

### Known Limitations (By Design)
- **Company identity is not verified** — In this prototype, anyone with the invite code can register as a pharmaceutical company and sign medicines. In production, this would require GSTIN/CIN verification against a government registry.
- **Symmetric HMAC** — The signing secret lives on the server. A compromised server means all signatures can be forged. Production would use per-company asymmetric key pairs.
- **No revocation** — Once a QR code is generated, it can't be invalidated short of deleting the medicine from the database.

---

## Running Locally

```bash
# 1. Clone the repository
git clone https://github.com/pranav742007-ux/MediScan.git
cd MediScan

# 2. Create virtual environment
python -m venv .venv
.venv\Scripts\activate        # Windows
# source .venv/bin/activate   # macOS/Linux

# 3. Install dependencies
pip install -r requirements.txt

# 4. Set up environment variables
cp .env.example .env
# Edit .env with your API keys (see .env.example for documentation)

# 5. Run the development server
python app.py
# Opens at http://localhost:5000
```

### Required Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `FLASK_SECRET_KEY` | ✅ | Session encryption key. Generate with `python -c "import secrets; print(secrets.token_hex(32))"` |
| `GEMINI_API_KEY` | ✅ | Google Gemini API key from [AI Studio](https://aistudio.google.com/app/apikey) |
| `GOOGLE_CLIENT_ID` | ✅ | OAuth client ID from [Google Cloud Console](https://console.cloud.google.com) |
| `SIGNING_SECRET` | ✅ | HMAC key for QR code signing. Changing this invalidates all existing QR codes. |
| `DATABASE_URL` | ❌ | PostgreSQL connection string. Omit to use local SQLite. |
| `COMPANY_INVITE_CODE` | ❌ | Secret code required to register as a pharma company. |
| `FLASK_ENV` | ❌ | Set to `production` on deployed environments. |

---

## Deploying to Render

This project includes a `render.yaml` blueprint and a production `Dockerfile`.

1. Push to GitHub
2. Go to [render.com](https://render.com) → New → Web Service → Connect repo
3. Select **Docker** as the environment
4. Set environment variables in the Render dashboard (see table above)
5. Add your Render URL to Google OAuth's authorized origins

See [render.yaml](render.yaml) for the full infrastructure-as-code configuration.

---

## Project Structure

```
MediScan/
├── app.py              # Flask backend (all API routes, DB logic, QR generation)
├── medicines_data.py   # Extended medicine database (90+ additional drugs)
├── requirements.txt    # Python dependencies
├── Dockerfile          # Production container (Python 3.11-slim + system deps)
├── Procfile            # Gunicorn process definition
├── render.yaml         # Render deployment blueprint
├── .env.example        # Environment variable template
├── runtime.txt         # Python version pin
├── templates/
│   ├── mediscan.html   # Main consumer-facing app (SPA-style)
│   └── company.html    # Pharmaceutical company portal
├── static/
│   ├── script.js       # Consumer app logic (search, scan, reminders, AI chat)
│   ├── company.js      # Company portal logic (upload, QR generation, dashboard)
│   ├── styles.css      # Full design system (glassmorphism, animations, responsive)
│   ├── sw.js           # Service Worker (offline caching)
│   ├── manifest.json   # PWA manifest
│   ├── icon-192.png    # PWA icon
│   └── icon-512.png    # PWA icon (large)
└── instance/
    └── mediscan.db     # Local SQLite database (auto-created, gitignored)
```

---

## API Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/api/search` | — | Search medicine by name/brand/keyword |
| `POST` | `/api/chat` | — | AI pharmacist query (rate-limited) |
| `POST` | `/api/scan-qr` | — | Upload QR image for decoding + verification |
| `POST` | `/api/verify-direct` | — | Verify Base64 QR payload (Google Lens deep link) |
| `POST` | `/api/check-interaction` | — | Check drug interaction between two medicines |
| `GET`  | `/api/stats` | — | Global medicine count + scan count |
| `GET`  | `/health` | — | Health check for load balancers |
| `POST` | `/api/register` | — | Create account |
| `POST` | `/api/login` | — | Email/password login |
| `POST` | `/api/google-login` | — | Google OAuth login |
| `POST` | `/api/logout` | ✅ | End session |
| `GET`  | `/api/profile` | ✅ | Get user health profile |
| `POST` | `/api/profile` | ✅ | Save user health profile |
| `POST` | `/api/medicine` | 🏢 | Upload new medicine (company only) |
| `POST` | `/api/generate-qr` | 🏢 | Generate signed QR + barcode (company only) |
| `GET`  | `/api/company/medicines` | 🏢 | List company's uploaded medicines |
| `DELETE`| `/api/company/medicines/:id` | 🏢 | Delete a medicine |

---

## License

This project was built as a student engineering prototype for educational purposes. The medical information is sourced from publicly available pharmacological references and should not be used as a substitute for professional medical advice.
