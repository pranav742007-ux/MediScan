"""
MediScan backend server
handles medicine lookups, QR code generation/scanning, and user profiles
run with: python app.py
make sure to install: pip install flask qrcode[pil] Pillow opencv-python-headless pyzbar
"""

import os
from dotenv import load_dotenv  
import warnings

# Suppress annoying library warnings for a cleaner demo terminal
warnings.filterwarnings("ignore", category=FutureWarning)
warnings.filterwarnings("ignore", category=DeprecationWarning)

# Load variables from .env cleanly and securely
load_dotenv()

from google import genai as genai_sdk
from google.genai import types
import json
import base64
import io
import sqlite3
import hmac
import hashlib
import uuid
from difflib import SequenceMatcher
import string
import random
import time
from datetime import date

from medicines_data import EXTENDED_MEDS, DRUG_INTERACTIONS

from flask import Flask, request, jsonify, send_from_directory, session, g, render_template
from werkzeug.security import generate_password_hash, check_password_hash

from google.oauth2 import id_token
from google.auth.transport import requests as google_requests


# QR generation dependencies (optional)
try:
    import qrcode
    from PIL import Image

    HAS_QR_GEN = True
except Exception as e:
    HAS_QR_GEN = False
    print(f"[warning] QR generation unavailable: {e}")
    print('  install with: pip install "qrcode[pil]" Pillow')

# Barcode generation dependencies (optional)
try:
    import barcode
    from barcode import Code128
    from barcode.writer import ImageWriter

    HAS_BARCODE_GEN = True
except Exception as e:
    HAS_BARCODE_GEN = False
    print(f"[warning] Barcode generation unavailable: {e}")
    print("  install with: pip install python-barcode")

# QR scanning dependencies (optional — requires system zbar library)
try:
    # try to import OpenCV and numpy first (pure-python QR decode fallback)
    import cv2
    import numpy as np

    HAS_CV_QR = True
except Exception:
    cv2 = None
    np = None
    HAS_CV_QR = False

HAS_PYZBAR = False
try:
    from pyzbar.pyzbar import decode as pyzbar_decode

    HAS_PYZBAR = True
except Exception:
    pyzbar_decode = None

# If either pyzbar (requires system zbar) or OpenCV is available, enable scanning
HAS_QR_SCAN = HAS_PYZBAR or HAS_CV_QR
if not HAS_QR_SCAN:
    print(
        "[warning] QR scanning unavailable: no suitable decoder found.\n  install python deps: pip install opencv-python-headless pyzbar numpy; also install system zbar (apt/brew)"
    )

# Help static analysis tools (pylance/pyright) understand optional deps
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    # These imports are only for type checking / editor hints. They are optional at runtime.
    try:  # pragma: no cover - editor-only
        import qrcode  # type: ignore
        from PIL import Image  # type: ignore
        import cv2  # type: ignore
        import numpy as np  # type: ignore
        from pyzbar.pyzbar import decode as pyzbar_decode  # type: ignore
        from flask import Flask  # type: ignore
        from werkzeug.security import generate_password_hash, check_password_hash  # type: ignore
    except Exception:
        pass

# Enable automatic static folder routing for static/script.js etc
app = Flask(__name__, static_folder="static")

from werkzeug.middleware.proxy_fix import ProxyFix
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1)


# Production Security Constraints
app.config["MAX_CONTENT_LENGTH"] = 5 * 1024 * 1024  # Max 5MB per upload to prevent DoS

# Strict Secure Session Configuration
app.secret_key = os.environ.get("FLASK_SECRET_KEY")
if not app.secret_key:
    raise RuntimeError(
        "CRITICAL: FLASK_SECRET_KEY environment variable is not set. Halting."
    )

# Configure session cookies securely
app.config.update(
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=os.environ.get("FLASK_ENV", "development") == "production",
    SESSION_COOKIE_HTTPONLY=True,
)

# Anti-counterfeit signing secret (HMAC-SHA256)
SIGNING_SECRET = os.environ.get("SIGNING_SECRET", app.secret_key).encode()


def sign_medicine(med_id, med_name, serial_no):
    """Generate HMAC-SHA256 signature for a medicine record."""
    payload = f"{med_id}:{med_name}:{serial_no}".encode()
    return hmac.new(SIGNING_SECRET, payload, hashlib.sha256).hexdigest()


def verify_signature(med_id, med_name, serial_no, signature):
    """Verify a medicine's cryptographic signature."""
    expected = sign_medicine(med_id, med_name, serial_no)
    return hmac.compare_digest(expected, signature)


# Create an instance directory for persistent data safe for deployments
INSTANCE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "instance")
os.makedirs(INSTANCE_DIR, exist_ok=True)

DB_FILE = os.path.join(INSTANCE_DIR, "mediscan.db")
PROFILE_FILE = os.path.join(INSTANCE_DIR, "mediscan_profile.json")


class CursorWrapper:
    def __init__(self, cursor, is_postgres):
        self.cursor = cursor
        self.is_postgres = is_postgres
        self.lastrowid = None

    def execute(self, query, args=()):
        if self.is_postgres:
            q = query.replace("AUTOINCREMENT", "SERIAL").replace("?", "%s")
            is_insert = q.strip().upper().startswith("INSERT")
            needs_ret = is_insert and ("users" in q.lower() or "medicines" in q.lower())
            if needs_ret and "RETURNING" not in q:
                q += " RETURNING id"
            try:
                self.cursor.execute(q, args)
            except Exception as e:
                err = str(e).lower()
                if "already exists" in err or "duplicate column" in err:
                    pass
                else:
                    raise e
            if needs_ret:
                row = self.cursor.fetchone()
                if row:
                    self.lastrowid = row['id'] if 'id' in row else row[0]
        else:
            self.cursor.execute(query, args)
            self.lastrowid = getattr(self.cursor, "lastrowid", None)
        return self

    def fetchone(self): return self.cursor.fetchone()
    def fetchall(self): return self.cursor.fetchall()
    def __iter__(self): return iter(self.cursor)

class DBWrapper:
    def __init__(self, conn, is_postgres):
        self.conn = conn
        self.is_postgres = is_postgres
    def cursor(self):
        return CursorWrapper(self.conn.cursor(), self.is_postgres)
    def commit(self): self.conn.commit()
    def close(self): self.conn.close()
    @property
    def row_factory(self): pass
    @row_factory.setter
    def row_factory(self, val): pass

def get_db_connection():
    db_url = os.environ.get("DATABASE_URL")
    if db_url and db_url.startswith("postgres"):
        import psycopg2
        from psycopg2.extras import RealDictCursor
        conn = psycopg2.connect(db_url, cursor_factory=RealDictCursor)
        return DBWrapper(conn, True)
    else:
        conn = sqlite3.connect(DB_FILE)
        conn.row_factory = sqlite3.Row
        return DBWrapper(conn, False)

def get_db():
    """Provides a single database connection per request lifecycle."""
    if "db" not in g:
        g.db = get_db_connection()
    return g.db


@app.teardown_appcontext
def close_db(error):
    """Closes the database connection when the request finishes."""
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    """Initializes the database schema with production-grade safety."""
    conn = get_db_connection()
    c = conn.cursor()
    # User Table
    c.execute(
        """
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            email TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            role TEXT DEFAULT 'user',
            profile_data TEXT DEFAULT '{}'
        )
    """
    )
    # Medicine Table
    c.execute(
        """
        CREATE TABLE IF NOT EXISTS medicines (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            strength TEXT,
            brands TEXT,
            category TEXT,
            safety TEXT,
            uses TEXT,
            dosage TEXT,
            sideEffects TEXT,
            warnings TEXT,
            disposal TEXT,
            mfg_date TEXT,
            exp_date TEXT,
            keywords TEXT,
            company_id INTEGER
        )
    """
    )
    # Scan History Table for Single-Use Serialization (Anti-cloning)
    c.execute(
        """
        CREATE TABLE IF NOT EXISTS scan_history (
            serial_no TEXT PRIMARY KEY,
            short_code TEXT UNIQUE,
            med_id INTEGER,
            first_scanned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            scan_count INTEGER DEFAULT 1
        )
    """
    )

    # Safely try to alter an old table to add new columns if they don't exist
    try:
        c.execute("ALTER TABLE scan_history ADD COLUMN short_code TEXT UNIQUE")
    except Exception:
        pass
    try:
        c.execute("ALTER TABLE scan_history ADD COLUMN med_id INTEGER")
    except Exception:
        pass

    try:
        c.execute("ALTER TABLE medicines ADD COLUMN disposal TEXT")
    except Exception:
        pass
    try:
        c.execute("ALTER TABLE medicines ADD COLUMN mfg_date TEXT")
    except Exception:
        pass
    try:
        c.execute("ALTER TABLE medicines ADD COLUMN exp_date TEXT")
    except Exception:
        pass

    # Check if medicines table is empty
    c.execute("SELECT COUNT(*) FROM medicines")
    if c.fetchone()[0] == 0:
        # Seed it with the default static list MEDS
        for med in MEDS:
            c.execute(
                """
                INSERT INTO medicines (name, strength, brands, category, safety, uses, dosage, sideEffects, warnings, disposal, keywords, company_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    med.get("name", ""),
                    med.get("strength", ""),
                    json.dumps(med.get("brands", []), ensure_ascii=False),
                    med.get("category", ""),
                    med.get("safety", "safe"),
                    med.get("uses", ""),
                    med.get("dosage", ""),
                    med.get("sideEffects", ""),
                    med.get("warnings", ""),
                    med.get("disposal", ""),
                    json.dumps(med.get("keywords", []), ensure_ascii=False),
                    0,
                ),
            )

    conn.commit()
    conn.close()


# ===== Medicine Database =====
# sourced from standard pharmacological references
# each entry has: id, name, strength, brands, category, safety level,
# uses, dosage, side effects, warnings, and search keywords

MEDS = [
    {
        "id": "paracetamol",
        "name": "Paracetamol",
        "strength": "500mg",
        "brands": ["Crocin", "Dolo", "Calpol", "Tylenol", "Para 500", "Dolo 650"],
        "category": "Analgesic / Antipyretic",
        "safety": "safe",
        "uses": "Relieves mild to moderate pain (headache, toothache, backache) and reduces fever. Safe for most age groups when used correctly.",
        "dosage": "Adults: 500mg-1000mg every 4-6 hours as needed. Maximum 4000mg per day. Take with or without food. Children: as per doctor's advice.",
        "sideEffects": "Generally very well tolerated. Rare side effects include nausea, stomach upset, and skin rash. Liver damage may occur with overdose.",
        "warnings": "Do NOT exceed the recommended dose. Avoid if you have liver disease or consume alcohol regularly. Do not combine with other paracetamol-containing products (e.g. cold medicines).",
        "keywords": [
            "paracetamol",
            "para",
            "crocin",
            "dolo",
            "calpol",
            "tylenol",
            "acetaminophen",
            "p500",
            "dolo650",
            "paracet",
            "पैरासिटामोल", "पॅरासिटामोल", "डोलो", "क्रोसिन"
        ],
    },
    {
        "id": "ibuprofen",
        "name": "Ibuprofen",
        "strength": "400mg",
        "brands": ["Brufen", "Advil", "Nurofen", "Combiflam"],
        "category": "NSAID Anti-inflammatory",
        "safety": "caution",
        "uses": "Relieves pain, inflammation and fever. Used for arthritis, menstrual pain, dental pain, sports injuries, and headaches.",
        "dosage": "400mg every 6-8 hours with food or milk. Maximum 1200mg per day (OTC). Do not use for more than 3 days for fever without medical advice.",
        "sideEffects": "Stomach upset, nausea, heartburn, dizziness. Less common: stomach bleeding, kidney effects with long-term use, fluid retention.",
        "warnings": "Take with food or milk - never on an empty stomach. Avoid if you have stomach ulcers, kidney disease, or heart conditions. Not recommended in pregnancy (3rd trimester). Avoid if taking blood thinners or aspirin.",
        "keywords": [
            "ibuprofen",
            "brufen",
            "advil",
            "nurofen",
            "combiflam",
            "ibupro",
            "ibuf",
            "आइबुप्रोफेन", "आयबुप्रोफेन", "कौम्बीफ्लेम"
        ],
    },
    {
        "id": "amoxicillin",
        "name": "Amoxicillin",
        "strength": "500mg",
        "brands": ["Amoxil", "Trimox", "Moxatag", "Novamox"],
        "category": "Antibiotic (Penicillin)",
        "safety": "caution",
        "uses": "Treats bacterial infections: ear infections, strep throat, pneumonia, urinary tract infections (UTIs), and skin infections.",
        "dosage": "500mg every 8 hours (3 times daily) for 7-14 days, or as prescribed by doctor. Complete the full course even if feeling better.",
        "sideEffects": "Diarrhea, stomach upset, nausea, skin rash. Rare but serious: severe allergic reaction (anaphylaxis) - seek emergency help immediately.",
        "warnings": "PRESCRIPTION REQUIRED. Inform your doctor of any penicillin or drug allergy BEFORE taking. Do not stop the course early. May reduce effectiveness of oral contraceptives. Seek emergency help if rash, difficulty breathing, or facial swelling occurs.",
        "keywords": [
            "amoxicillin",
            "amoxil",
            "trimox",
            "novamox",
            "moxatag",
            "amox",
            "amoxi",
            "एमोक्सिसिलिन", "नोवामॉक्स"
        ],
    },
    {
        "id": "metformin",
        "name": "Metformin",
        "strength": "500mg",
        "brands": ["Glucophage", "Glycomet", "Obimet", "Formet"],
        "category": "Antidiabetic (Biguanide)",
        "safety": "caution",
        "uses": "Controls blood sugar levels in Type 2 diabetes. Also used for polycystic ovary syndrome (PCOS). Helps the body use insulin more effectively.",
        "dosage": "500mg twice daily with meals. Dose may be gradually increased by your doctor up to 2550mg/day in divided doses.",
        "sideEffects": "Nausea, diarrhea, stomach cramps, loss of appetite (especially when starting - usually improves). Rare: lactic acidosis (serious - muscle pain, weakness, difficulty breathing).",
        "warnings": "PRESCRIPTION REQUIRED. Do not take if you have kidney disease or severe liver disease. Stop and inform doctor before contrast dye procedures or surgery. Monitor blood sugar regularly. Avoid excessive alcohol consumption.",
        "keywords": [
            "metformin",
            "glucophage",
            "glycomet",
            "obimet",
            "formet",
            "metfor",
        ],
    },
    {
        "id": "cetirizine",
        "name": "Cetirizine",
        "strength": "10mg",
        "brands": ["Zyrtec", "Cetzine", "Alerid", "Okacet"],
        "category": "Antihistamine (Allergy)",
        "safety": "safe",
        "uses": "Relieves allergy symptoms including runny nose, sneezing, itchy and watery eyes, skin rashes, and hives (urticaria). Less drowsy than older antihistamines.",
        "dosage": "10mg once daily, preferably in the evening. Children 6-12 years: 5mg twice daily or 10mg once daily. Not recommended for children under 6 without medical advice.",
        "sideEffects": "Mild drowsiness, dry mouth, headache, dizziness. Much less sedating than older antihistamines like chlorphenamine.",
        "warnings": "May cause drowsiness in some people - avoid driving or operating heavy machinery if affected. Use caution if you have kidney disease (dose reduction may be needed). Avoid alcohol as it may increase drowsiness.",
        "keywords": [
            "cetirizine",
            "zyrtec",
            "cetzine",
            "alerid",
            "okacet",
            "cetriz",
            "cetz",
        ],
    },
    {
        "id": "omeprazole",
        "name": "Omeprazole",
        "strength": "20mg",
        "brands": ["Prilosec", "Omez", "Protoloc", "Losec"],
        "category": "Proton Pump Inhibitor (PPI)",
        "safety": "safe",
        "uses": "Treats acid reflux (GERD), stomach and duodenal ulcers, and Helicobacter pylori infection (with antibiotics). Reduces stomach acid production.",
        "dosage": "20mg once daily, 30-60 minutes before breakfast. For severe cases or ulcers: up to 40mg/day for 4-8 weeks as directed by doctor.",
        "sideEffects": "Headache, diarrhea, nausea, flatulence, stomach pain. Long-term use: reduced magnesium and vitamin B12 absorption, slightly increased fracture risk.",
        "warnings": "Not for immediate heartburn relief - takes 1-4 days to work fully. Long-term use (>8 weeks) should be supervised by a doctor. May mask symptoms of stomach cancer. Discuss with doctor if taking clopidogrel.",
        "keywords": [
            "omeprazole",
            "prilosec",
            "omez",
            "protoloc",
            "losec",
            "omepra",
            "omep",
        ],
    },
    {
        "id": "aspirin",
        "name": "Aspirin",
        "strength": "75mg",
        "brands": ["Ecosprin", "Disprin", "Loprin", "Bayer Aspirin"],
        "category": "Antiplatelet / NSAID",
        "safety": "danger",
        "uses": "Low dose (75mg): prevents heart attacks and strokes as antiplatelet therapy. Higher doses: pain, fever, and inflammation. Used under medical supervision.",
        "dosage": "75mg-150mg once daily for heart protection (as prescribed). For pain/fever: 300-900mg every 4-6 hours with food (adults only).",
        "sideEffects": "Stomach irritation and bleeding risk, heartburn, increased bleeding time (blood takes longer to clot). Tinnitus (ringing ears) at high doses.",
        "warnings": "NEVER give to children or teenagers under 16 - risk of Reye's syndrome (serious brain and liver condition). Significantly increases bleeding risk - tell your surgeon/dentist you take aspirin. Avoid with peptic ulcers or bleeding disorders. Avoid in pregnancy. NEVER stop prescribed aspirin without consulting your doctor first.",
        "keywords": [
            "aspirin",
            "ecosprin",
            "disprin",
            "loprin",
            "bayer",
            "acetylsalicylic",
            "asa",
        ],
    },
    {
        "id": "atorvastatin",
        "name": "Atorvastatin",
        "strength": "10mg",
        "brands": ["Lipitor", "Atorva", "Tonact", "Aztor"],
        "category": "Statin (Cholesterol-lowering)",
        "safety": "caution",
        "uses": "Lowers LDL (bad) cholesterol and triglycerides. Raises HDL (good) cholesterol. Reduces risk of heart attack, stroke, and cardiovascular events.",
        "dosage": "10-80mg once daily at any time of day (usually bedtime). Dose determined by doctor based on cholesterol levels and cardiovascular risk.",
        "sideEffects": "Muscle pain or weakness (myalgia), headache, nausea, diarrhea, elevated liver enzymes. Rare but serious: rhabdomyolysis (severe muscle breakdown).",
        "warnings": "PRESCRIPTION REQUIRED. Report any unexplained muscle pain, tenderness, or weakness to doctor immediately. Avoid grapefruit and grapefruit juice (interferes with metabolism). Absolutely NOT for use during pregnancy or breastfeeding. Regular liver function monitoring recommended.",
        "keywords": ["atorvastatin", "lipitor", "atorva", "tonact", "aztor", "atorvas"],
    },
    {
        "id": "azithromycin",
        "name": "Azithromycin",
        "strength": "500mg",
        "brands": ["Zithromax", "Azithral", "Azee", "Z-pack"],
        "category": "Antibiotic (Macrolide)",
        "safety": "caution",
        "uses": "Treats respiratory tract infections (pneumonia, bronchitis), ear and throat infections, skin infections, sexually transmitted infections, and typhoid fever.",
        "dosage": "500mg once daily for 3 days (typical course). May be taken with or without food. Longer courses for some infections as prescribed.",
        "sideEffects": "Nausea, diarrhea, stomach pain, vomiting. Rare: liver problems, abnormal heart rhythm (QT prolongation), severe skin reactions.",
        "warnings": "PRESCRIPTION REQUIRED. Inform your doctor of any heart conditions or electrolyte abnormalities before starting. Always complete the full antibiotic course. Take antacids 2 hours apart. May interact with warfarin and other medications.",
        "keywords": [
            "azithromycin",
            "zithromax",
            "azithral",
            "azee",
            "zpack",
            "azithro",
        ],
    },
    {
        "id": "pantoprazole",
        "name": "Pantoprazole",
        "strength": "40mg",
        "brands": ["Pantocid", "Pan D", "Pantodac", "Protonix"],
        "category": "Proton Pump Inhibitor (PPI)",
        "safety": "safe",
        "uses": "Treats gastroesophageal reflux disease (GERD), stomach and duodenal ulcers, and Zollinger-Ellison syndrome. Reduces stomach acid effectively.",
        "dosage": "40mg once daily, 30-60 minutes before breakfast. For severe conditions: up to 80mg/day. Duration as prescribed by doctor.",
        "sideEffects": "Headache, diarrhea, nausea, flatulence, abdominal pain. Long-term use may cause low magnesium levels and increased infection risk.",
        "warnings": "Not for immediate relief of heartburn - takes time to work. Long-term use needs medical supervision and monitoring. May mask symptoms of stomach cancer - seek medical attention if symptoms persist. Use lowest effective dose.",
        "keywords": [
            "pantoprazole",
            "pantocid",
            "pan d",
            "pantodac",
            "protonix",
            "panto",
            "pantopr",
        ],
    },
]

# Merge extended medicines into MEDS
MEDS = MEDS + EXTENDED_MEDS

# Initialize database on startup within application context
with app.app_context():
    init_db()


def find_medicine(query_text):
    """Searches SQLite database with fuzzy matching fallback."""
    q = query_text.strip().lower()
    if not q:
        return None

    # Prepare search term for SQL LIKE operator
    search_term = f"%{q}%"

    conn = get_db()
    c = conn.cursor()

    # 1. Exact LIKE match first (fast path)
    c.execute(
        """
        SELECT medicines.*, users.name as company_name 
        FROM medicines 
        LEFT JOIN users ON medicines.company_id = users.id
        WHERE lower(medicines.name) LIKE ? 
           OR lower(medicines.brands) LIKE ? 
           OR lower(medicines.keywords) LIKE ?
        LIMIT 1
    """,
        (search_term, search_term, search_term),
    )

    med_row = c.fetchone()

    # 2. Fuzzy match fallback if no exact match
    if not med_row:
        c.execute(
            """
            SELECT medicines.*, users.name as company_name 
            FROM medicines 
            LEFT JOIN users ON medicines.company_id = users.id
        """
        )
        all_meds = c.fetchall()
        best_match = None
        best_score = 0.0

        for row in all_meds:
            row_dict = dict(row)
            name = (row_dict.get("name") or "").lower()
            brands_raw = row_dict.get("brands") or "[]"
            keywords_raw = row_dict.get("keywords") or "[]"

            try:
                brands_list = json.loads(brands_raw)
            except (json.JSONDecodeError, TypeError):
                brands_list = []

            try:
                keywords_list = json.loads(keywords_raw)
            except (json.JSONDecodeError, TypeError):
                keywords_list = []

            # Check similarity against name, brands, and keywords
            score = max(
                SequenceMatcher(None, q, name).ratio(),
                max(
                    (SequenceMatcher(None, q, b.lower()).ratio() for b in brands_list),
                    default=0,
                ),
                max(
                    (
                        SequenceMatcher(None, q, k.lower()).ratio()
                        for k in keywords_list
                    ),
                    default=0,
                ),
            )

            if score > best_score:
                best_score = score
                best_match = row

        if best_score >= 0.55:  # Threshold for fuzzy match
            med_row = best_match

    if med_row:
        med = dict(med_row)
        try:
            med["brands"] = json.loads(med.get("brands", "[]"))
            med["keywords"] = json.loads(med.get("keywords", "[]"))
        except json.JSONDecodeError:
            med["brands"] = []
            med["keywords"] = []

        # Confidence based on match quality
        if search_term.strip("%") in (med.get("name") or "").lower():
            med["confidence"] = 1.0
        else:
            med["confidence"] = 0.85  # Fuzzy match confidence
        return med

    return None


def generate_qr_base64(data_dict, px_size=300):
    if not globals().get("HAS_QR_GEN", False):
        return None

    qr = qrcode.QRCode(
        version=None,
        error_correction=qrcode.constants.ERROR_CORRECT_H,
        box_size=10,
        border=4,
    )

    json_data = json.dumps(data_dict)

    try:
        from flask import request

        # Convert JSON into a Base64 encrypted URL query parameter
        b64_payload = base64.urlsafe_b64encode(json_data.encode("utf-8")).decode(
            "utf-8"
        )
        scan_url = f"{request.host_url}?q={b64_payload}"
        qr.add_data(scan_url)
    except Exception as e:
        # Fallback to pure JSON if request context is not available
        qr.add_data(json_data)

    qr.make(fit=True)

    img = qr.make_image(fill_color="black", back_color="white")
    img = img.resize((px_size, px_size), getattr(Image, "Resampling", Image).NEAREST)

    buffer = io.BytesIO()
    img.save(buffer, format="PNG")
    buffer.seek(0)
    return base64.b64encode(buffer.read()).decode("utf-8")


def generate_barcode_base64(text_data):
    if not globals().get("HAS_BARCODE_GEN", False):
        return None
    try:
        # We use Code128 because it supports alphanumeric characters
        rv = io.BytesIO()
        Code128(text_data, writer=ImageWriter()).write(
            rv, options={"write_text": True, "text_distance": 4, "font_size": 10}
        )
        rv.seek(0)
        return base64.b64encode(rv.read()).decode("utf-8")
    except Exception as e:
        print(f"Barcode gen failed: {e}")
        return None


def decode_qr_bytes(raw_bytes):
    if not globals().get("HAS_QR_SCAN", False):
        return None

    # Strict Pyzbar decoding (Optical only)
    if pyzbar_decode is not None:
        try:
            from PIL import Image

            img_pil = Image.open(io.BytesIO(raw_bytes)).convert("RGB")
            decoded = pyzbar_decode(img_pil)
            if decoded:
                return decoded[0].data.decode("utf-8")
        except Exception as e:
            print(f"Pyzbar error: {e}")

    # Strict OpenCV fallback
    if cv2 is not None and np is not None:
        try:
            arr = np.frombuffer(raw_bytes, np.uint8)
            img_cv = cv2.imdecode(arr, cv2.IMREAD_COLOR)
            if img_cv is not None:
                detector = cv2.QRCodeDetector()
                data, points, _ = detector.detectAndDecode(img_cv)
                if data:
                    return data
        except Exception as e:
            print(f"CV2 error: {e}")

    return None


# ===========================
#   Flask routes
# ===========================


@app.after_request
def add_security_headers(response):
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "SAMEORIGIN"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self' 'unsafe-inline' data: blob: "
        "https://fonts.googleapis.com https://fonts.gstatic.com "
        "https://accounts.google.com https://*.gstatic.com "
        "translate.google.com translate.googleapis.com *.translate.googleapis.com;"
    )
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Permissions-Policy"] = "camera=(self), microphone=(self), geolocation=()"
    response.headers["Strict-Transport-Security"] = "max-age=63072000; includeSubDomains"
    return response


@app.route("/")
def serve_index():
    return render_template("mediscan.html")


@app.route("/company")
def serve_company():
    return render_template("company.html")


@app.route("/api/search", methods=["POST"])
def api_search():
    body = request.get_json(silent=True)
    if not body or "query" not in body:
        return jsonify({"found": False, "error": "missing query"}), 400

    query = body["query"]
    match = find_medicine(query)

    if match:
        return jsonify({"found": True, "medicine": match})
    else:
        return jsonify({"found": False})


# Simple in-memory rate limiter (resets on server restart - fine for hackathon)
_chat_calls = {}


@app.route("/api/chat", methods=["POST"])
def api_chat():
    ip = request.headers.get("X-Forwarded-For", request.remote_addr).split(",")[0].strip()
    now = time.time()
    calls = _chat_calls.get(ip, [])
    # Allow max 10 calls per minute per IP
    calls = [t for t in calls if now - t < 60]
    if len(calls) >= 10:
        return jsonify({"error": "Too many requests. Please wait a moment."}), 429
    calls.append(now)
    _chat_calls[ip] = calls

    # Periodic cleanup: purge stale IPs every 100 calls to prevent memory leak
    if len(_chat_calls) > 200:
        stale_ips = [k for k, v in _chat_calls.items() if all(now - t > 120 for t in v)]
        for k in stale_ips:
            del _chat_calls[k]
    body = request.get_json(silent=True)
    if not body:
        return jsonify({"error": "no data"}), 400

    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        api_key = os.environ.get("GENAI_API_KEY")

    if not api_key:
        return jsonify({"error": "Missing Server API key."}), 500

    prompt = body.get("prompt", body.get("query", "")).strip()
    medicine = body.get("medicine")
    target_lang = body.get("language", "en-IN") # Get the language code

    # Map the code to a real word for the prompt
    lang_map = {
        "hi-IN": "Hindi", "mr-IN": "Marathi", "bn-IN": "Bengali", 
        "ta-IN": "Tamil", "te-IN": "Telugu", "gu-IN": "Gujarati", 
        "kn-IN": "Kannada", "ml-IN": "Malayalam", "en-IN": "English"
    }
    spoken_language = lang_map.get(target_lang, "English")

    if medicine:
        prompt = f"Context: The user is asking about {json.dumps(medicine)}. User Query: {prompt}"
    
    prompt = prompt[:500]

    try:
        # Use the new synchronous client, no transport config needed
        client = genai_sdk.Client(api_key=api_key)

        sys_prompt = (
            f"You are a friendly, local neighborhood doctor in India. "
            f"CRITICAL: You MUST reply in extremely simple, conversational {spoken_language}. "
            f"Do NOT use complex dictionary words. Speak exactly how a village doctor speaks to an elderly patient. "
            f"Keep answers short and practical. "
            f"ONLY answer questions about medicines, dosages, side effects, and drug interactions. "
            f"NEVER prescribe medication or diagnose conditions.\n\n"
        )

        # Use the latest Gemini 2.5 Pro for superior medical reasoning
        response = client.models.generate_content(
            model="gemini-2.5-pro-preview-05-06",
            contents=prompt,
            config=types.GenerateContentConfig(
                system_instruction=sys_prompt,
                tools=[types.Tool(google_search=types.GoogleSearch())]
            )
        )

        try:
            rtext = response.text
        except (ValueError, AttributeError):
            rtext = "I'm sorry, but that query was blocked by Google AI Safety filters."

        disclaimer = "\n\n⚠️ *This is general information only. Always consult a licensed pharmacist or doctor before taking any medication.*"
        return jsonify(
            {"ok": True, "response": rtext + disclaimer, "reply": rtext + disclaimer}
        )

    except Exception as e:
        error_str = str(e)
        print(f"⚠️ Primary AI Failed: {error_str}. Triggering Local Fallback...")
        
        # --- OFFLINE LOCAL FALLBACK (No API Key Needed) ---
        # If the AI fails, we check if the user is currently looking at a medicine.
        # If they are, we pull the answer directly from the local dictionary.
        medicine = body.get("medicine")
        
        if medicine:
            med_name = medicine.get("name", "this medicine")
            dosage = medicine.get("dosage", "Not specified.")
            side_effects = medicine.get("sideEffects", "Not specified.")
            warnings = medicine.get("warnings", "Not specified.")
            fallback_msg = (
                f"⚠️ *Live AI is busy. Switching to local offline database for {med_name}:*\n\n"
                f"• **Dosage:** {dosage}\n"
                f"• **Side Effects:** {side_effects}\n"
                f"• **Warnings:** {warnings}\n\n"
                f"*(Please try your custom question again in a minute).* "
            )
            
            return jsonify({"ok": True, "response": fallback_msg, "reply": fallback_msg})
        
        else:
            # If they haven't scanned a medicine yet and the AI is down
            busy_msg = "⚠️ The AI network is experiencing high demand. Please scan a medicine directly to view its offline safety records, or try asking again in a minute."
            return jsonify({"ok": True, "response": busy_msg, "reply": busy_msg})


@app.route("/api/medicine", methods=["POST"])
def api_upload_medicine():
    if not session.get("user_id") or session.get("role") != "company":
        return jsonify({"error": "Unauthorized. Please log in as a company."}), 403

    def truncate(val, max_len=2000):
        return str(val).strip()[:max_len]

    body = request.get_json(silent=True)
    if not body:
        return jsonify({"error": "no data"}), 400

    name = body.get("name", "").strip()
    if not name:
        return jsonify({"error": "Medicine name is required"}), 400

    # Strictly validate lists
    raw_brands = body.get("brands", "")
    brands_list = (
        [b.strip() for b in raw_brands.split(",") if b.strip()]
        if isinstance(raw_brands, str)
        else []
    )

    keywords_list = [name.lower()] + [b.lower() for b in brands_list]

    # Ensure safe string formatting
    try:
        brands_json = json.dumps(brands_list)
        keywords_json = json.dumps(keywords_list)
    except TypeError:
        return jsonify({"error": "Invalid data format for brands"}), 400

    safety = body.get("safety", "safe")
    if safety not in ["safe", "caution", "danger"]:
        safety = "safe"

    company_id = session.get("user_id")

    exp_date_str = body.get("exp_date", "").strip()
    if exp_date_str:
        try:
            exp_date_parsed = date.fromisoformat(exp_date_str)
            if exp_date_parsed < date.today():
                return (
                    jsonify({"error": "Cannot register an already-expired medicine"}),
                    400,
                )
        except ValueError:
            return jsonify({"error": "Invalid expiry date format"}), 400

    try:
        conn = get_db()
        c = conn.cursor()
        c.execute(
            """
            INSERT INTO medicines (name, strength, brands, category, safety, uses, dosage, sideEffects, warnings, disposal, mfg_date, exp_date, keywords, company_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                name,
                truncate(body.get("strength", "")),
                brands_json,
                truncate(body.get("category", "")),
                safety,
                truncate(body.get("uses", "")),
                truncate(body.get("dosage", "")),
                truncate(body.get("sideEffects", "")),
                truncate(body.get("warnings", "")),
                truncate(body.get("disposal", "")),
                body.get("mfg_date", "").strip(),
                body.get("exp_date", "").strip(),
                keywords_json,
                company_id,
            ),
        )
        med_id = c.lastrowid
        conn.commit()
    except Exception as e:
        return jsonify({"error": "Database write failed"}), 500

    return jsonify({"ok": True, "medicine_id": med_id})


@app.route("/api/demo-login", methods=["POST"])
def api_demo_login():
    """Bypasses OAuth for rapid hackathon judge demonstrations."""
    if os.environ.get("FLASK_ENV") == "production":
        return jsonify({"error": "Demo login disabled in production"}), 403
    body = request.get_json(silent=True) or {}
    role = body.get("role", "user")

    session.clear()
    session["user_id"] = 99
    session["role"] = role
    session.permanent = True

    if role == "company":
        name = "Demo Pharma Corp"
        email = "demo@pharma.com"
    else:
        name = "Google User"
        email = "user@gmail.com"

    return jsonify(
        {"ok": True, "user": {"id": 99, "name": name, "email": email, "role": role}}
    )


@app.route("/api/google-login", methods=["POST"])
def api_google_login():
    body = request.get_json(silent=True)
    token = body.get("idToken")
    
    # Self-service Google login defaults to user. Companies must be invited.
    requested_role = "user"

    if not token:
        return jsonify({"error": "No token provided"}), 400

    try:
        # Verify the token with Google
        CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID")
        if not CLIENT_ID:
            return jsonify({"error": "Google login not configured"}), 500
        idinfo = id_token.verify_oauth2_token(
            token, google_requests.Request(), CLIENT_ID
        )

        email = idinfo["email"].lower()
        name = idinfo.get("name", "Google User")

        # Connect to DB to check if user exists, or register them
        conn = get_db()
        c = conn.cursor()
        c.execute("SELECT id, role FROM users WHERE email = ?", (email,))
        user = c.fetchone()

        if not user:
            # Auto-register Google users with the requested role
            hashed_pw = generate_password_hash(os.urandom(16).hex())  # Dummy password
            c.execute(
                "INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)",
                (name, email, hashed_pw, requested_role),
            )
            user_id = c.lastrowid
            role = requested_role
            conn.commit()
        else:
            user_id = user["id"]
            role = user["role"]

        session["user_id"] = user_id
        session["role"] = role

        return jsonify(
            {
                "ok": True,
                "user": {"id": user_id, "name": name, "email": email, "role": role},
            }
        )

    except ValueError:
        return jsonify({"error": "Invalid token"}), 401


@app.route("/api/company/medicines", methods=["GET"])
def api_company_medicines():
    """Returns medicines uploaded by the logged-in company."""
    company_id = session.get("user_id")

    if not company_id or session.get("role") != "company":
        return jsonify({"error": "Unauthorized. Please log in as a company."}), 403

    try:
        conn = get_db()
        c = conn.cursor()
        c.execute(
            "SELECT * FROM medicines WHERE company_id = ? ORDER BY id DESC LIMIT 100",
            (company_id,),
        )
        rows = c.fetchall()
        medicines = [dict(r) for r in rows]
        # Parse the JSON arrays back
        for m in medicines:
            try:
                m["brands"] = json.loads(m.get("brands", "[]"))
            except (json.JSONDecodeError, TypeError):
                m["brands"] = []
        return jsonify({"ok": True, "medicines": medicines})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/company/medicines/<int:med_id>", methods=["DELETE"])
def api_delete_medicine(med_id):
    """Deletes a medicine from the registry if it belongs to the logged-in company."""
    company_id = session.get("user_id")

    if not company_id or session.get("role") != "company":
        return jsonify({"error": "Unauthorized"}), 403

    try:
        conn = get_db()
        c = conn.cursor()

        c.execute(
            "SELECT id FROM medicines WHERE id = ? AND company_id = ?",
            (med_id, company_id),
        )
        if not c.fetchone():
            return jsonify({"error": "Medicine not found or unauthorized"}), 404

        c.execute("DELETE FROM medicines WHERE id = ?", (med_id,))
        conn.commit()

        return jsonify({"ok": True, "message": "Medicine deleted successfully."})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/generate-qr", methods=["POST"])
def api_gen_qr():
    if not session.get("user_id") or session.get("role") != "company":
        return jsonify({"error": "Unauthorized"}), 403

    if not globals().get("HAS_QR_GEN", False):
        return (
            jsonify(
                {
                    "error": "QR generation dependencies not installed.",
                    "install": 'pip install "qrcode[pil]" Pillow python-barcode',
                }
            ),
            501,
        )

    body = request.get_json(silent=True)
    if not body:
        return jsonify({"error": "no data sent"}), 400

    b64_img = None
    b64_barcode = None
    short_code = None

    # If body has a med_id, generate a signed QR for anti-counterfeit
    if "med_id" in body:
        med_id = body["med_id"]
        conn = get_db()
        c = conn.cursor()
        c.execute("SELECT name FROM medicines WHERE id = ?", (med_id,))
        row = c.fetchone()
        if row:
            serial_no = (
                uuid.uuid4().hex
            )  # Generate unique serial number for anti-cloning
            sig = sign_medicine(med_id, row["name"], serial_no)

            body = {"med_id": med_id, "serial_no": serial_no, "sig": sig}

            for _ in range(5):
                rand_str = "".join(
                    random.choices(string.ascii_uppercase + string.digits, k=6)
                )
                short_code = f"MED-{rand_str}"
                
                try:
                    # Pre-register this serial in the database with 0 scans
                    c.execute(
                        "INSERT INTO scan_history (serial_no, short_code, med_id, scan_count) VALUES (?, ?, ?, 0)",
                        (serial_no, short_code, med_id),
                    )
                    conn.commit()
                    break
                except Exception:
                    continue
            else:
                return jsonify({"error": "Could not generate unique code"}), 500

            # Generate the 1D Barcode
            b64_barcode = generate_barcode_base64(short_code)

    b64_img = generate_qr_base64(body)

    if b64_img:
        return jsonify(
            {"image": b64_img, "barcode": b64_barcode, "short_code": short_code}
        )
    return jsonify({"error": "failed to generate QR"}), 500


@app.route("/api/scan-qr", methods=["POST"])
def api_scan_qr():
    if "file" not in request.files:
        return jsonify({"error": "no file in request"}), 400

    uploaded = request.files["file"]
    raw = uploaded.read()
    result = decode_qr_bytes(raw)

    if result:
        # Check if the result is a 1D Barcode short code (e.g. "MED-K9B3A1")
        if isinstance(result, str) and result.startswith("MED-"):
            conn = get_db()
            c = conn.cursor()
            # Lookup the short code in our registry
            c.execute("SELECT * FROM scan_history WHERE short_code = ?", (result,))
            history_row = c.fetchone()

            if history_row:
                history = dict(history_row)
                c.execute(
                    """
                    SELECT medicines.*, users.name as company_name 
                    FROM medicines 
                    LEFT JOIN users ON medicines.company_id = users.id 
                    WHERE medicines.id = ?
                """,
                    (history["med_id"],),
                )
                med_row = c.fetchone()

                if med_row:
                    med_dict = dict(med_row)
                    try:
                        med_dict["brands"] = json.loads(med_dict.get("brands", "[]"))
                    except (json.JSONDecodeError, TypeError):
                        med_dict["brands"] = []

                    # It's verified via the registry directly
                    verified = True

                    # Anti-cloning feature removed
                    is_cloned = False

                    med_dict["verified"] = verified
                    med_dict["is_cloned"] = is_cloned
                    parsed = {
                        "medicine": med_dict,
                        "verified": verified,
                        "is_cloned": is_cloned,
                        "barcode": True,
                    }
                    return jsonify({"found": True, "data": parsed, "raw": result})

        # Try parsing as JSON or base64 URL payload
        try:
            if "?q=" in result:
                b64_payload = result.split("?q=")[-1]
                result = base64.urlsafe_b64decode(b64_payload).decode("utf-8")
            parsed = json.loads(result)

            # If the QR code contains a med_id, resolve it from the database
            if isinstance(parsed, dict) and "med_id" in parsed:
                conn = get_db()
                c = conn.cursor()
                c.execute(
                    """
                    SELECT medicines.*, users.name as company_name 
                    FROM medicines 
                    LEFT JOIN users ON medicines.company_id = users.id 
                    WHERE medicines.id = ?
                """,
                    (parsed["med_id"],),
                )
                med_row = c.fetchone()

                if med_row:
                    med_dict = dict(med_row)
                    try:
                        med_dict["brands"] = json.loads(med_dict.get("brands", "[]"))
                    except (json.JSONDecodeError, TypeError):
                        med_dict["brands"] = []

                    # ANTI-COUNTERFEIT: Verify HMAC signature and Serial No
                    sig = parsed.get("sig", "")
                    serial_no = parsed.get("serial_no", "")
                    if sig and serial_no:
                        verified = verify_signature(
                            parsed["med_id"], med_dict["name"], serial_no, sig
                        )

                        # Anti-cloning feature removed
                        is_cloned = False
                    else:
                        verified = False
                        is_cloned = False

                    med_dict["verified"] = verified
                    med_dict["is_cloned"] = is_cloned
                    parsed["medicine"] = med_dict
                    parsed["verified"] = verified
                    parsed["is_cloned"] = is_cloned

            return jsonify({"found": True, "data": parsed, "raw": result})
        except json.JSONDecodeError:
            return jsonify({"found": True, "data": result, "raw": result})

    return jsonify({"found": False, "message": "no QR code detected in image"})


@app.route("/api/verify-direct", methods=["POST"])
def api_verify_direct():
    """Endpoint optimized for Google Lens / Tap-to-Open URL intercepts"""
    body = request.get_json(silent=True)
    if not body or "payload" not in body:
        return jsonify({"error": "missing payload"}), 400

    try:
        # Front-end has already base64 decoded the URL parameter and sent us raw JSON string
        parsed = json.loads(body["payload"])
    except json.JSONDecodeError:
        return jsonify({"error": "invalid payload format"}), 400

    if isinstance(parsed, dict) and "med_id" in parsed:
        conn = get_db()
        c = conn.cursor()
        c.execute(
            """
            SELECT medicines.*, users.name as company_name 
            FROM medicines 
            LEFT JOIN users ON medicines.company_id = users.id 
            WHERE medicines.id = ?
        """,
            (parsed["med_id"],),
        )
        med_row = c.fetchone()

        if med_row:
            med_dict = dict(med_row)
            try:
                med_dict["brands"] = json.loads(med_dict.get("brands", "[]"))
            except (json.JSONDecodeError, TypeError):
                med_dict["brands"] = []

            sig = parsed.get("sig", "")
            serial_no = parsed.get("serial_no", "")
            if sig and serial_no:
                verified = verify_signature(
                    parsed["med_id"], med_dict["name"], serial_no, sig
                )
                # Anti-cloning feature removed
                is_cloned = False
            else:
                verified = False
                is_cloned = False

            med_dict["verified"] = verified
            med_dict["is_cloned"] = is_cloned
            parsed["medicine"] = med_dict
            parsed["verified"] = verified
            parsed["is_cloned"] = is_cloned

            return jsonify({"found": True, "data": parsed, "raw": body["payload"]})

    return jsonify({"found": False})


@app.route("/api/check-interaction", methods=["POST"])
def api_check_interaction():
    """Check for known drug interactions between two medicines."""
    body = request.get_json(silent=True)
    if not body:
        return jsonify({"error": "no data"}), 400

    med_a = body.get("medicine_a", "").strip().lower()
    med_b = body.get("medicine_b", "").strip().lower()

    if not med_a or not med_b:
        return jsonify({"interaction": False})

    # Check the DRUG_INTERACTIONS dictionary
    pair = frozenset([med_a, med_b])
    warning = DRUG_INTERACTIONS.get(pair)

    if warning:
        return jsonify({"interaction": True, "warning": warning, "severity": "high"})

    return jsonify({"interaction": False})


@app.route("/api/profile", methods=["GET"])
def api_get_profile():
    user_id = session.get("user_id")
    if not user_id:
        return jsonify({}), 401

    try:
        conn = get_db()
        c = conn.cursor()
        c.execute("SELECT profile_data FROM users WHERE id = ?", (user_id,))
        row = c.fetchone()
        if row:
            # Use key-based access for compatibility with both SQLite Row and PostgreSQL RealDictCursor
            profile_val = row["profile_data"] if isinstance(row, dict) else (row["profile_data"] if hasattr(row, 'keys') else row[0])
            if profile_val:
                return jsonify(json.loads(profile_val))
    except Exception:
        pass
    return jsonify({})


@app.route("/api/profile", methods=["POST"])
def api_save_profile():
    user_id = session.get("user_id")
    if not user_id:
        return jsonify({"error": "Unauthorized"}), 401

    body = request.get_json(silent=True)
    if not body:
        return jsonify({"error": "no profile data"}), 400

    try:
        conn = get_db()
        c = conn.cursor()
        c.execute(
            "UPDATE users SET profile_data = ? WHERE id = ?",
            (json.dumps(body), user_id),
        )
        conn.commit()
        return jsonify({"saved": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/register", methods=["POST"])
def api_register():
    body = request.get_json(silent=True)
    if not body:
        return jsonify({"error": "no data"}), 400

    name = body.get("name", "").strip()
    email = body.get("email", "").strip().lower()
    password = body.get("password", "")
    
    # Force self-registrations to 'user'. 
    # Companies must be invited/created by admins.
    role = "user"

    if not name or not email or not password:
        return jsonify({"error": "Please fill in all fields"}), 400
    if len(password) < 8:
        return jsonify({"error": "Password must be at least 8 characters"}), 400
    if "@" not in email:
        return jsonify({"error": "Please enter a valid email"}), 400

    hashed_pw = generate_password_hash(password)

    try:
        conn = get_db()
        c = conn.cursor()
        c.execute(
            "INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)",
            (name, email, hashed_pw, role),
        )
        user_id = c.lastrowid
        conn.commit()
    except Exception as e:
        if "IntegrityError" in type(e).__name__ or "UNIQUE" in str(e).upper():
            return (
                jsonify({"error": "This email is already registered. Try signing in."}),
                400,
            )
        raise e

    # Authenticate via session immediately after registration
    session["user_id"] = user_id
    session["role"] = role

    return jsonify(
        {
            "ok": True,
            "user": {"id": user_id, "name": name, "email": email, "role": role},
        }
    )


@app.route("/api/login", methods=["POST"])
def api_login():
    body = request.get_json(silent=True)
    if not body:
        return jsonify({"error": "no data"}), 400

    email = body.get("email", "").strip().lower()
    password = body.get("password", "")

    if not email or not password:
        return jsonify({"error": "Please enter email and password"}), 400

    conn = get_db()
    c = conn.cursor()
    c.execute(
        "SELECT id, name, email, password, role FROM users WHERE email = ?",
        (email,),
    )
    user = c.fetchone()

    if user and check_password_hash(user["password"], password):
        # Establish Server Session Cookie
        session["user_id"] = user["id"]
        session["role"] = user["role"]

        return jsonify(
            {
                "ok": True,
                "user": {
                    "id": user["id"],
                    "name": user["name"],
                    "email": user["email"],
                    "role": user["role"],
                },
            }
        )

    return jsonify({"error": "Wrong email or password. Check and try again."}), 401


@app.route("/api/logout", methods=["POST"])
def api_logout():
    session.clear()
    return jsonify({"ok": True})


# ===========================


@app.errorhandler(404)
def not_found(e):
    if request.path.startswith("/api/"):
        return jsonify({"error": "Not found"}), 404
    return render_template("mediscan.html")


@app.route("/api/stats", methods=["GET"])
def api_stats():
    try:
        conn = get_db()
        c = conn.cursor()
        c.execute("SELECT COUNT(*) FROM medicines")
        total_meds = c.fetchone()[0]

        c.execute("SELECT SUM(scan_count) FROM scan_history")
        sum_row = c.fetchone()[0]
        total_scans = sum_row if sum_row else 0

        return jsonify(
            {"success": True, "total_meds": total_meds, "total_scans": total_scans}
        )
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


if __name__ == "__main__":
    debug_mode = os.environ.get("FLASK_DEBUG", "true").lower() == "true"
    print()
    print("  MediScan server starting...")
    print(f"  Debug mode: {debug_mode}")
    print("  Open http://localhost:5000 in your browser")
    print()
    port = int(os.environ.get("PORT", 5000))
    
    if debug_mode:
        app.run(debug=True, host="0.0.0.0", port=port)
    else:
        try:
            from waitress import serve
            print("  Running with production WSGI server (Waitress)...")
            serve(app, host="0.0.0.0", port=port)
        except ImportError:
            print("  [Warning] Waitress not installed. Falling back to development server.")
            print("  Run `pip install waitress` for a production deployment on Windows.")
            app.run(debug=False, host="0.0.0.0", port=port)
