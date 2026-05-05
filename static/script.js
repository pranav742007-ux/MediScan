// mediscan app - main js file
// navigation, search, results, reminders etc
var currentScannedMedicine = null; // Stores the currently viewed medicine
var _voiceMsgStore = []; // Stores AI messages for the speaker button
// html escape helper (prevents XSS)
function escHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}

// Global fetch timeout helper (5 seconds)
function fetchWithTimeout(resource, options = {}) {
  const { timeout = 5000 } = options;
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  return fetch(resource, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(id));
}


var scanHistory = JSON.parse(localStorage.getItem('mediscan_history') || '[]');
var reminders = JSON.parse(localStorage.getItem('mediscan_reminders') || '[]');
var activeTab = 'text';
var totalScans = parseInt(localStorage.getItem('mediscan_total') || '0');
var currentUser = JSON.parse(localStorage.getItem('mediscan_user') || 'null');

// check if already logged in on page load
(function() {
  const urlParams = new URLSearchParams(window.location.search);
  const qParam = urlParams.get('q');
  
  if (qParam) {
    // If arriving via Google Lens Deep Link, clean the URL bar instantly
    window.history.replaceState({}, document.title, window.location.pathname);
    
    // Process deep link after 1 second so UI can load
    setTimeout(function() {
      processDeepLinkPayload(qParam);
    }, 1000);
  }

  if (currentUser && currentUser.name) {
    // already logged in, skip login screen, show splash
    document.getElementById('loginScreen').classList.remove('active');
    document.getElementById('splashScreen').classList.add('active');
    setTimeout(function() { goTo('homeScreen'); }, 2500);
  }
})();

function processDeepLinkPayload(base64Payload) {
    showLoader();
    fetch('/api/verify-direct', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payload: base64Payload })
    })
    .then(r => r.json())
    .then(res => {
        hideLoader();
        if (res.found && res.data) {
            document.getElementById('loginScreen').classList.remove('active');
            var med = res.data.medicine;
            if (med) showResult(med, res.raw);
        } else {
            showWarning("Invalid or corrupted QR Code.");
        }
    })
    .catch(e => {
        hideLoader();
        showWarning("Failed to connect to verification server.");
    });
}

// --- login / register stuff ---

function switchLoginMode(mode) {
  var errEl = document.getElementById('loginError');
  var succEl = document.getElementById('loginSuccess');
  errEl.style.display = 'none';
  succEl.style.display = 'none';

  if (mode === 'register') {
    document.getElementById('signinForm').style.display = 'none';
    document.getElementById('registerForm').style.display = 'flex';
    document.getElementById('loginTabSign').classList.remove('on');
    document.getElementById('loginTabReg').classList.add('on');
    document.getElementById('loginFooter').innerHTML = 'Already have an account? <a onclick="switchLoginMode(\'signin\')">Sign in</a>';
  } else {
    document.getElementById('signinForm').style.display = 'flex';
    document.getElementById('registerForm').style.display = 'none';
    document.getElementById('loginTabSign').classList.add('on');
    document.getElementById('loginTabReg').classList.remove('on');
    document.getElementById('loginFooter').innerHTML = 'Don\'t have an account? <a onclick="switchLoginMode(\'register\')">Register here</a>';
  }
}

function showLoginError(msg) {
  var el = document.getElementById('loginError');
  el.textContent = msg;
  el.style.display = 'block';
  document.getElementById('loginSuccess').style.display = 'none';
}

function showLoginSuccess(msg) {
  var el = document.getElementById('loginSuccess');
  el.textContent = msg;
  el.style.display = 'block';
  document.getElementById('loginError').style.display = 'none';
}

function doSignIn() {
  var email = document.getElementById('signEmail').value.trim();
  var pass = document.getElementById('signPass').value;

  if (!email || !pass) { showLoginError('Please enter both email and password'); return; }

  fetch('/api/login', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: email, password: pass })
  })
  .then(function(r) { return r.json().then(function(d) { return { status: r.status, data: d }; }); })
  .then(function(res) {
    if (res.data.ok) {
      currentUser = res.data.user;
      localStorage.setItem('mediscan_user', JSON.stringify(currentUser));
      loginComplete();
    } else {
      showLoginError(res.data.error || 'Login failed');
    }
  })
  .catch(function() {
    // backend offline - allow demo login
    if (email && pass.length >= 4) {
      currentUser = { name: email.split('@')[0], email: email };
      localStorage.setItem('mediscan_user', JSON.stringify(currentUser));
      loginComplete();
    } else {
      showLoginError('Server not running. Use any email + password (4+ chars) to demo.');
    }
  });
}

function doRegister() {
  var name = document.getElementById('regName').value.trim();
  var email = document.getElementById('regEmail').value.trim();
  var pass = document.getElementById('regPass').value;
  var confirm = document.getElementById('regConfirm').value;

  if (!name || !email || !pass) { showLoginError('Please fill in all fields'); return; }
  if (pass !== confirm) { showLoginError('Passwords don\'t match'); return; }
  if (pass.length < 8) { showLoginError('Password needs to be at least 8 characters'); return; }

  fetch('/api/register', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name, email: email, password: pass })
  })
  .then(function(r) { return r.json().then(function(d) { return { status: r.status, data: d }; }); })
  .then(function(res) {
    if (res.data.ok) {
      showLoginSuccess('Account created! You can sign in now.');
      setTimeout(function() { switchLoginMode('signin'); }, 1500);
    } else {
      showLoginError(res.data.error || 'Registration failed');
    }
  })
  .catch(function() {
    // backend offline - just proceed
    currentUser = { name: name, email: email };
    localStorage.setItem('mediscan_user', JSON.stringify(currentUser));
    loginComplete();
  });
}

function doGoogleLogin() {
  try {
    google.accounts.id.initialize({
      client_id: window.GOOGLE_CLIENT_ID || "1234567890-xxxx.apps.googleusercontent.com",
      callback: handleGoogleCredentialResponse
    });
    google.accounts.id.prompt(function(notification) {
      if (notification.isNotDisplayed() || notification.isSkippedMoment()) {
        console.log("Google One Tap hidden or skipped - switching to simulation");
        simulateGoogleLogin();
      }
    });
  } catch (e) {
    console.error("GSI Error:", e);
    simulateGoogleLogin();
  }
}

function simulateGoogleLogin() {
  showToast("Demo: Connecting to secure backend...");
  fetch('/api/demo-login', { 
      method: 'POST', 
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'user' })
  })
  .then(function(r) { return r.json(); })
  .then(function(res) {
      if (res.ok) {
          currentUser = res.user;
          localStorage.setItem('mediscan_user', JSON.stringify(currentUser));
          setTimeout(loginComplete, 1000);
      } else {
          showToast("Demo login failed structurally.");
      }
  })
  .catch(function() { showToast("Backend offline. Cannot demo without server."); });
}

function handleGoogleCredentialResponse(response) {
  showToast("Verifying Google account...");
  fetch('/api/google-login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken: response.credential, role: 'user' })
  })
  .then(function(r) { return r.json(); })
  .then(function(res) {
    if (res.ok) {
      currentUser = res.user;
      localStorage.setItem('mediscan_user', JSON.stringify(currentUser));
      showLoginSuccess('Signed in with Google!');
      setTimeout(loginComplete, 800);
    } else {
      console.log("Real Google auth failed - switching to simulation");
      simulateGoogleLogin();
    }
  }).catch(function() {
    simulateGoogleLogin();
  });
}

function loginComplete() {
  // show splash then go to proper screen
  document.querySelectorAll('.screen').forEach(function(s) { s.classList.remove('active'); });
  document.getElementById('splashScreen').classList.add('active');
  setTimeout(function() { goTo('homeScreen'); }, 2500);
}

function doLogout() {
  fetch('/api/logout', {method: 'POST', credentials: 'same-origin'});
  currentUser = null;
  localStorage.removeItem('mediscan_user');
  document.querySelectorAll('.screen').forEach(function(s) { s.classList.remove('active'); });
  document.getElementById('loginScreen').classList.add('active');
  // clear form fields
  document.getElementById('signEmail').value = '';
  document.getElementById('signPass').value = '';
  document.getElementById('loginError').style.display = 'none';
  document.getElementById('loginSuccess').style.display = 'none';
  showToast('Logged out');
}
// ---- navigation ----
function goTo(screenId) {
  document.querySelectorAll('.screen').forEach(function(s) {
    s.classList.remove('active');
  });
  document.getElementById(screenId).classList.add('active');
  window.scrollTo(0, 0);

  // update nav buttons
  document.querySelectorAll('.navBtn').forEach(function(btn) {
    btn.classList.remove('current');
  });
  var activeNav = document.querySelector('#' + screenId + ' .topBar-nav');
  if (activeNav) {
    activeNav.querySelectorAll('.navBtn').forEach(function(btn) {
      if (btn.getAttribute('onclick') && btn.getAttribute('onclick').indexOf(screenId) > -1) {
        btn.classList.add('current');
      }
    });
  }

  if (screenId === 'homeScreen') {
    refreshHome();
    // show user name if logged in
    var nameEl = document.getElementById('userNameHome');
    if (nameEl && currentUser) nameEl.textContent = currentUser.name;
  }
  if (screenId === 'reminderScreen') renderReminders();
  if (screenId === 'profileScreen') loadProfile();
}

// ---- tabs ----
function switchTab(tab) {
  activeTab = tab;
  var tabs = ['text', 'barcode', 'manual'];
  for (var i = 0; i < tabs.length; i++) {
    var t = tabs[i];
    var tabEl = document.getElementById('tab' + t.charAt(0).toUpperCase() + t.slice(1));
    var panelEl = document.getElementById('panel' + t.charAt(0).toUpperCase() + t.slice(1));
    if (t === tab) {
      tabEl.classList.add('on');
      panelEl.classList.remove('hidden');
    } else {
      tabEl.classList.remove('on');
      panelEl.classList.add('hidden');
    }
  }
}

// ---- barcode / short-code search ----
function runBarcodeSearch() {
  var code = document.getElementById('barcodeInput').value.trim().toUpperCase();
  if (!code) { showToast('Please enter a barcode or short code'); return; }

  // If it looks like a MED- short code, use the verify-direct endpoint
  if (code.startsWith('MED-')) {
    showLoading();
    fetch('/api/verify-direct', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload: JSON.stringify({ short_code: code }) })
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      hideLoading();
      if (data.medicine) {
        saveToHistory(data.medicine, code);
        showResult(data.medicine, code);
      } else {
        showWarning(code);
      }
    })
    .catch(function() { hideLoading(); showWarning(code); });
  } else {
    // Fall back: treat numeric barcode as text and run a name search
    document.getElementById('ocrInput').value = code;
    switchTab('text');
    runScan();
  }
}

// ---- example chips ----
function fillExample(text) {
  document.getElementById('ocrInput').value = text;
  document.getElementById('ocrInput').focus();
  showToast('Loaded - click Search to look it up');
}

// ---- file upload stuff ----
function doDragOver(e) {
  e.preventDefault();
  document.getElementById('uploadZone').classList.add('dragOn');
}
function doDragLeave() {
  document.getElementById('uploadZone').classList.remove('dragOn');
}
function doDrop(e) {
  e.preventDefault();
  document.getElementById('uploadZone').classList.remove('dragOn');
  var file = e.dataTransfer.files[0];
  if (file && file.type.startsWith('image/')) processUpload(file);
}
function handleFile(e) {
  var file = e.target.files[0];
  if (file) processUpload(file);
}

// Replace processUpload
function processUpload(file) {
  showToast('Image uploaded - processing...');
  var formData = new FormData();
  formData.append('file', file);

  fetch('/api/scan-qr', { method: 'POST', body: formData })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.found && data.data && data.data.medicine) {
        // FIX: Route directly to the main result screen
        showResult(data.data.medicine, "Decoded from QR Image");
        showToast('QR code decoded!');
      } else {
        // Fallback to text scanning simulation
        var reader = new FileReader();
        reader.onload = function() {
          var zone = document.getElementById('uploadZone');
          zone.innerHTML = '<img src="' + reader.result + '" style="max-height:120px;border-radius:8px;object-fit:cover;margin-bottom:8px;">' +
            '<p style="color:var(--pri);font-weight:600;font-size:13px;">Image loaded. Tap Search to scan.</p>';
          document.getElementById('ocrInput').value = '';
          showToast('No QR detected. Please type the medicine name manually.');
        };
        reader.readAsDataURL(file);
      }
    }).catch(function(err) { showToast("Error connecting to server for scan"); });
}

// ---- main scan ----
function runScan() {
  var query = '';
  if (activeTab === 'text') {
    query = document.getElementById('ocrInput').value.trim();
    if (!query) { showToast('Please enter medicine text first'); return; }
  } else if (activeTab === 'barcode') {
    query = document.getElementById('barcodeInput').value.trim();
    if (!query) { showToast('Please enter a barcode number'); return; }
  } else {
    query = document.getElementById('manualImprint').value.trim();
    if (!query) { showToast('Please enter at least the tablet imprint'); return; }
  }

  showLoader();

  // try backend API first
  fetchWithTimeout('/api/search', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: query }),
    timeout: 8000 // Give Search 8 seconds
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    hideLoader();
    if (data.found && data.medicine) {
      showResult(data.medicine, query);
    } else {
      showWarning(query);
    }
  })
  .catch(function() {
    // backend not available - use local fallback search
    setTimeout(function() {
      hideLoader();
      var result = localSearch(query);
      if (result) {
        showResult(result, query);
      } else {
        showWarning(query);
      }
    }, 2200);
  });
}

// local fallback medicine database (in case backend is down)
var LOCAL_MEDS = [
  { id:'paracetamol', name:'Paracetamol', strength:'500mg', brands:['Crocin','Dolo','Calpol','Tylenol','Para 500','Dolo 650'], category:'Analgesic / Antipyretic', safety:'safe', uses:'Relieves mild to moderate pain (headache, toothache, backache) and reduces fever. Safe for most age groups when used correctly.', dosage:'Adults: 500mg-1000mg every 4-6 hours as needed. Maximum 4000mg per day. Take with or without food. Children: as per doctor\'s advice.', sideEffects:'Generally very well tolerated. Rare side effects include nausea, stomach upset, and skin rash. Liver damage may occur with overdose.', warnings:'Do NOT exceed the recommended dose. Avoid if you have liver disease or consume alcohol regularly. Do not combine with other paracetamol-containing products.', keywords:['paracetamol','para','crocin','dolo','calpol','tylenol','acetaminophen','p500','dolo650','paracet'] },
  { id:'ibuprofen', name:'Ibuprofen', strength:'400mg', brands:['Brufen','Advil','Nurofen','Combiflam'], category:'NSAID Anti-inflammatory', safety:'caution', uses:'Relieves pain, inflammation and fever. Used for arthritis, menstrual pain, dental pain, sports injuries, and headaches.', dosage:'400mg every 6-8 hours with food or milk. Maximum 1200mg per day (OTC). Do not use for more than 3 days for fever without medical advice.', sideEffects:'Stomach upset, nausea, heartburn, dizziness. Less common: stomach bleeding, kidney effects with long-term use, fluid retention.', warnings:'Take with food or milk - never on an empty stomach. Avoid if you have stomach ulcers, kidney disease, or heart conditions. Not recommended in pregnancy (3rd trimester).', keywords:['ibuprofen','brufen','advil','nurofen','combiflam','ibupro','ibuf'] },
  { id:'amoxicillin', name:'Amoxicillin', strength:'500mg', brands:['Amoxil','Trimox','Moxatag','Novamox'], category:'Antibiotic (Penicillin)', safety:'caution', uses:'Treats bacterial infections: ear infections, strep throat, pneumonia, urinary tract infections (UTIs), and skin infections.', dosage:'500mg every 8 hours (3 times daily) for 7-14 days, or as prescribed by doctor. Complete the full course even if feeling better.', sideEffects:'Diarrhea, stomach upset, nausea, skin rash. Rare but serious: severe allergic reaction (anaphylaxis) - seek emergency help immediately.', warnings:'PRESCRIPTION REQUIRED. Inform your doctor of any penicillin or drug allergy BEFORE taking. Do not stop the course early.', keywords:['amoxicillin','amoxil','trimox','novamox','moxatag','amox','amoxi'] },
  { id:'metformin', name:'Metformin', strength:'500mg', brands:['Glucophage','Glycomet','Obimet','Formet'], category:'Antidiabetic (Biguanide)', safety:'caution', uses:'Controls blood sugar levels in Type 2 diabetes. Also used for PCOS. Helps the body use insulin more effectively.', dosage:'500mg twice daily with meals. May be gradually increased up to 2550mg/day in divided doses.', sideEffects:'Nausea, diarrhea, stomach cramps, loss of appetite. Rare: lactic acidosis (serious).', warnings:'PRESCRIPTION REQUIRED. Do not take if you have kidney disease or severe liver disease. Monitor blood sugar regularly.', keywords:['metformin','glucophage','glycomet','obimet','formet','metfor'] },
  { id:'cetirizine', name:'Cetirizine', strength:'10mg', brands:['Zyrtec','Cetzine','Alerid','Okacet'], category:'Antihistamine (Allergy)', safety:'safe', uses:'Relieves allergy symptoms including runny nose, sneezing, itchy eyes, skin rashes, and hives. Less drowsy than older antihistamines.', dosage:'10mg once daily, preferably in the evening. Children 6-12: 5mg twice daily.', sideEffects:'Mild drowsiness, dry mouth, headache, dizziness.', warnings:'May cause drowsiness - avoid driving if affected. Use caution with kidney disease. Avoid alcohol.', keywords:['cetirizine','zyrtec','cetzine','alerid','okacet','cetriz','cetz'] },
  { id:'omeprazole', name:'Omeprazole', strength:'20mg', brands:['Prilosec','Omez','Protoloc','Losec'], category:'Proton Pump Inhibitor (PPI)', safety:'safe', uses:'Treats acid reflux (GERD), stomach ulcers, and H. pylori infection. Reduces stomach acid production.', dosage:'20mg once daily, 30-60 minutes before breakfast. Up to 40mg/day for severe cases.', sideEffects:'Headache, diarrhea, nausea, flatulence. Long-term: reduced magnesium and B12 absorption.', warnings:'Not for immediate heartburn relief. Long-term use (>8 weeks) needs doctor supervision.', keywords:['omeprazole','prilosec','omez','protoloc','losec','omepra','omep'] },
  { id:'aspirin', name:'Aspirin', strength:'75mg', brands:['Ecosprin','Disprin','Loprin','Bayer Aspirin'], category:'Antiplatelet / NSAID', safety:'danger', uses:'Low dose (75mg): prevents heart attacks and strokes. Higher doses: pain, fever, inflammation.', dosage:'75mg-150mg once daily for heart protection. For pain: 300-900mg every 4-6 hours with food.', sideEffects:'Stomach irritation, bleeding risk, heartburn. Tinnitus at high doses.', warnings:'NEVER give to children under 16 - risk of Reye\'s syndrome. Increases bleeding risk significantly. Avoid with peptic ulcers. Avoid in pregnancy.', keywords:['aspirin','ecosprin','disprin','loprin','bayer','acetylsalicylic','asa'] },
  { id:'atorvastatin', name:'Atorvastatin', strength:'10mg', brands:['Lipitor','Atorva','Tonact','Aztor'], category:'Statin (Cholesterol-lowering)', safety:'caution', uses:'Lowers LDL cholesterol and triglycerides. Reduces risk of heart attack and stroke.', dosage:'10-80mg once daily (usually bedtime). Dose determined by doctor.', sideEffects:'Muscle pain, headache, nausea. Rare: rhabdomyolysis (severe muscle breakdown).', warnings:'PRESCRIPTION REQUIRED. Report unexplained muscle pain immediately. Avoid grapefruit. NOT for pregnancy.', keywords:['atorvastatin','lipitor','atorva','tonact','aztor','atorvas'] },
  { id:'azithromycin', name:'Azithromycin', strength:'500mg', brands:['Zithromax','Azithral','Azee','Z-pack'], category:'Antibiotic (Macrolide)', safety:'caution', uses:'Treats respiratory infections, ear/throat infections, skin infections, and typhoid fever.', dosage:'500mg once daily for 3 days. Longer courses as prescribed.', sideEffects:'Nausea, diarrhea, stomach pain. Rare: liver problems, abnormal heart rhythm.', warnings:'PRESCRIPTION REQUIRED. Complete the full course. Take antacids 2 hours apart.', keywords:['azithromycin','zithromax','azithral','azee','zpack','azithro'] },
  { id:'pantoprazole', name:'Pantoprazole', strength:'40mg', brands:['Pantocid','Pan D','Pantodac','Protonix'], category:'Proton Pump Inhibitor (PPI)', safety:'safe', uses:'Treats GERD, stomach ulcers, and Zollinger-Ellison syndrome.', dosage:'40mg once daily before breakfast. Up to 80mg/day for severe cases.', sideEffects:'Headache, diarrhea, nausea, flatulence. Long-term: low magnesium risk.', warnings:'Not for immediate heartburn relief. Long-term use needs monitoring.', keywords:['pantoprazole','pantocid','pan d','pantodac','protonix','panto','pantopr'] }
];

function localSearch(query) {
  var q = query.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').trim();
  var words = q.split(/\s+/);
  var best = null, bestScore = 0;

  for (var i = 0; i < LOCAL_MEDS.length; i++) {
    var med = LOCAL_MEDS[i];
    var score = 0;
    if (q.indexOf(med.name.toLowerCase()) > -1) score += 0.9;
    for (var b = 0; b < med.brands.length; b++) {
      if (q.indexOf(med.brands[b].toLowerCase()) > -1) { score += 0.85; break; }
    }
    for (var k = 0; k < med.keywords.length; k++) {
      var kw = med.keywords[k];
      if (q.indexOf(kw) > -1) score += 0.6;
      for (var w = 0; w < words.length; w++) {
        if (words[w].length >= 4 && kw.indexOf(words[w].substring(0, Math.min(words[w].length, 5))) === 0) score += 0.25;
      }
    }
    if (q.indexOf(med.strength.replace('mg', '').trim()) > -1) score += 0.2;
    var norm = Math.min(score / 1.5, 1.0);
    if (norm > bestScore) { bestScore = norm; best = Object.assign({}, med, { confidence: norm }); }
  }
  return (best && bestScore >= 0.25) ? best : null;
}

// ---- processing overlay ----
function showLoader() {
  document.getElementById('loadingOverlay').classList.remove('hidden');
  var steps = ['ls1', 'ls2', 'ls3', 'ls4'];
  var msgs = ['Scanning for barcodes...', 'Analyzing text input...', 'Searching medicine database...', 'Analyzing safety data...'];
  steps.forEach(function(s) { document.getElementById(s).className = 'loadStep'; });

  var idx = 0;
  var interval = setInterval(function() {
    if (idx > 0) {
      document.getElementById(steps[idx - 1]).className = 'loadStep done';
    }
    if (idx < steps.length) {
      document.getElementById(steps[idx]).className = 'loadStep now';
      document.getElementById('loadMsg').textContent = msgs[idx];
      idx++;
    } else {
      clearInterval(interval);
    }
  }, 500);
}

function hideLoader() {
  ['ls1', 'ls2', 'ls3', 'ls4'].forEach(function(s) {
    document.getElementById(s).className = 'loadStep done';
  });
  setTimeout(function() {
    document.getElementById('loadingOverlay').classList.add('hidden');
  }, 300);
}

// ---- show result ----
function showResult(med, rawText) {
 // Save the scanned medicine so the AI can read it!
  if (currentScannedMedicine && currentScannedMedicine.name !== med.name) {
    document.getElementById('aiChatMessages').innerHTML = ''; // clear chat for new med
    addChatMessage('Now viewing: ' + med.name + '. Ask me anything about it.', 'ai-msg');
  }
  currentScannedMedicine = med; // only add to history for new scans (not when clicking existing history cards)
  if (rawText) {
    saveToHistory(med, rawText);
    totalScans++;
    localStorage.setItem('mediscan_total', totalScans);
  }
  var themeClass = med.safety === 'safe' ? 'safe' : med.safety === 'danger' ? 'danger' : 'caution';
  var safetyText = med.safety === 'safe' ? '&#10003; SAFE' : med.safety === 'danger' ? '&#9888; HIGH RISK' : '&#9889; CAUTION';
  var pct = Math.round((med.confidence || 0.8) * 100);

  // ANTI-COUNTERFEIT: Show dramatic verification panel
  var verifyBadge = '';
  if (med.verified === true && med.is_cloned === false) {
    verifyBadge = '<div class="verify-panel verify-genuine">' +
      '<div class="verify-icon"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#16A34A" stroke-width="2.5"><path d="M9 12l2 2 4-4"/><path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z"/></svg></div>' +
      '<div class="verify-text"><div class="verify-title">&#10004; Verified Authentic First Scan</div>' +
      '<div class="verify-desc">Cryptographic signature matches and serial is unique. This product is genuine.</div></div></div>';
  } else if (med.verified === true && med.is_cloned === true) {
    // Valid signature but scanned multiple times
    verifyBadge = '<div class="verify-panel" style="background: linear-gradient(135deg, #FFFBEB, #FEF3C7); border-color: #FCD34D;">' +
      '<div class="verify-icon" style="background: rgba(255,255,255,0.8);"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#D97706" stroke-width="2.5"><path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg></div>' +
      '<div class="verify-text"><div class="verify-title" style="color:#B45309; font-weight:700; font-size:15px;">&#9888; DUPLICATE SERIAL SCANNED</div>' +
      '<div class="verify-desc" style="color:#92400E; font-size:13px;">Signature is valid, but this QR code has been scanned before. This may be a cloned counterfeit.</div></div></div>';
  } else if (med.verified === false) {
    verifyBadge = '<div class="verify-panel verify-fake">' +
      '<div class="verify-icon"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#DC2626" stroke-width="2.5"><path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg></div>' +
      '<div class="verify-text"><div class="verify-title">&#9888; COUNTERFEIT WARNING</div>' +
      '<div class="verify-desc">Signature mismatch detected. This product may be fake or tampered with. Do NOT consume.</div></div></div>';
  } else if (med.company_name) {
    verifyBadge = '<div class="verify-panel verify-mfg">' +
      '<div class="verify-icon"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#6366F1" stroke-width="2"><path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg></div>' +
      '<div class="verify-text"><div class="verify-title">Registered Manufacturer</div>' +
      '<div class="verify-desc">Uploaded by ' + escHtml(med.company_name) + '</div></div></div>';
  }

  // DRUG INTERACTION CHECK: Compare against scan history
  if (med.name && scanHistory.length > 1) {
    var prevMed = scanHistory[1]; // Previous scan
    if (prevMed && prevMed.name && prevMed.name !== med.name) {
      fetch('/api/check-interaction', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ medicine_a: med.name, medicine_b: prevMed.name })
      })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.interaction) {
          var warnEl = document.getElementById('interactionWarning');
          if (warnEl) {
            warnEl.innerHTML = '<div class="interaction-header">' +
              '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg>' +
              '<strong>Drug Interaction Detected</strong></div>' +
              '<div class="interaction-pills"><span class="int-pill">' + escHtml(med.name) + '</span>' +
              '<span class="int-x">&#10005;</span>' +
              '<span class="int-pill">' + escHtml(prevMed.name) + '</span></div>' +
              '<div class="interaction-detail">' + escHtml(data.warning) + '</div>' +
              '<div class="interaction-action"><strong>Action:</strong> Consult your doctor before combining these medications.</div>';
            warnEl.style.display = 'block';
          }
        }
      }).catch(function() {});
    }
  }

  var brandsHtml = '';
  if (med.brands) {
    for (var i = 0; i < med.brands.length; i++) {
      brandsHtml += '<span class="brandTag">' + escHtml(med.brands[i]) + '</span>';
    }
  }

  // Unified Voice: Combine text and strip ALL quotes to prevent HTML breaking
  let voiceText = `${med.name || 'Medicine'}. Uses: ${med.uses || 'Not specified'}. Dosage: ${med.dosage || 'Not specified'}. Side effects: ${med.sideEffects || 'Not specified'}.`;
  let safeVoiceText = voiceText.replace(/['"]/g, "");

  // 1. Convert the brands into rounded UI "Pill" tags
  let brandsList = [];
  if (Array.isArray(med.brands)) {
      brandsList = med.brands;
  } else if (typeof med.brands === 'string') {
      brandsList = med.brands.split(',');
  } else {
      brandsList = ['N/A'];
  }
  
  let brandTags = brandsList.map(b => 
      `<span style="background: #CCFBF1; color: #0F766E; padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: bold; margin-right: 8px; margin-bottom: 8px; display: inline-block;">${escHtml(String(b).trim())}</span>`
  ).join('');

  var html = `
    <style>
        /* Mini-CSS just for this results screen */
        .scan-card { background: white; border-radius: 12px; padding: 16px; margin-bottom: 15px; box-shadow: 0 2px 4px rgba(0,0,0,0.05); text-align: left;}
        .scan-card-title { font-size: 12px; font-weight: bold; color: #64748B; text-transform: uppercase; margin-bottom: 10px; display: flex; align-items: center; gap: 8px; letter-spacing: 0.5px; }
        .split-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 15px; }
        /* Makes it stack vertically on small phone screens */
        @media (max-width: 600px) { .split-grid { grid-template-columns: 1fr; } }
    </style>

    <div class="resultHero ${themeClass}" style="margin-bottom: 15px;">
      ${verifyBadge}
      <div class="safetyTag">${safetyText}</div>
      <div class="confWrap" style="margin-top:10px;"><div class="confRow"><span class="confLabel">Match Confidence</span><span class="confPct">${pct}%</span></div>
      <div class="confBar"><div class="confFill" id="confFill" style="width:0%"></div></div></div>
    </div>

    <button onclick="readAloud('${safeVoiceText}')" class="goBtn" style="margin-bottom: 15px; background: #0F766E; width: 100%; display: flex; align-items: center; justify-content: center; gap: 8px; border-radius: 8px; padding: 12px;">
        <svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path d="M11 5L6 9H2v6h4l5 4V5z"/></svg>
        Listen to Medical Info
    </button>

    <div class="scan-card" style="border-top: 4px solid #0F766E;">
        <h2 style="margin: 0 0 4px 0; color: #0F766E; font-size: 24px;">
            ${escHtml(med.name || 'Unknown')} 
            <span style="font-size: 16px; color: #64748B; font-weight: normal;">(${escHtml(med.strength || '')})</span>
        </h2>
        <p style="margin: 0; color: #475569; font-size: 14px;"><strong>Category:</strong> ${escHtml(med.category || 'N/A')}</p>
    </div>

    <div class="scan-card">
        <div class="scan-card-title">ALSO KNOWN AS</div>
        <div style="display: flex; flex-wrap: wrap;">${brandTags}</div>
    </div>

    <div class="scan-card">
        <div class="scan-card-title"><span style="color:#3B82F6;">ℹ️</span> USES</div>
        <p style="margin: 0; color: #333; font-size: 14px; line-height: 1.5;">${escHtml(med.uses || 'N/A')}</p>
    </div>

    <div class="scan-card">
        <div class="scan-card-title"><span style="color:#10B981;">⏱️</span> DOSAGE</div>
        <p style="margin: 0; color: #333; font-size: 14px; line-height: 1.5;">${escHtml(med.dosage || 'N/A')}</p>
    </div>

    <div class="split-grid">
        <div class="scan-card" style="background: #FEF3C7; margin-bottom: 0; border: 1px solid #FDE68A;">
            <div class="scan-card-title" style="color: #D97706;"><span>⚠️</span> SIDE EFFECTS</div>
            <p style="margin: 0; color: #451A03; font-size: 14px; line-height: 1.5;">${escHtml(med.sideEffects || 'N/A')}</p>
        </div>
        
        <div class="scan-card" style="background: #FEE2E2; margin-bottom: 0; border: 1px solid #FECACA;">
            <div class="scan-card-title" style="color: #DC2626;"><span>🚫</span> WARNINGS</div>
            <p style="margin: 0; color: #7F1D1D; font-size: 14px; line-height: 1.5;">${escHtml(med.warnings || 'N/A')}</p>
        </div>
    </div>

    <div class="split-grid">
        <div class="scan-card" style="margin-bottom: 0; background: #F8FAFC;">
            <div class="scan-card-title">🛡️ SAFETY</div>
            <p style="margin: 0; color: #333; font-size: 14px; line-height: 1.5;">${escHtml(med.safety || 'N/A')}</p>
        </div>
        <div class="scan-card" style="margin-bottom: 0; background: #F8FAFC;">
            <div class="scan-card-title">🗑️ DISPOSAL</div>
            <p style="margin: 0; color: #333; font-size: 14px; line-height: 1.5;">${escHtml(med.disposal || 'N/A')}</p>
        </div>
    </div>

    <div style="display: flex; justify-content: space-between; padding: 12px; background: #F8FAFC; border-radius: 8px; font-size: 12px; color: #64748B; border: 1px solid #E2E8F0; margin-bottom: 10px;">
        <span><strong>Mfg Date:</strong> ${escHtml(med.mfg_date || 'N/A')}</span>
        <span><strong>Exp Date:</strong> ${escHtml(med.exp_date || 'N/A')}</span>
    </div>
    
    <p style="font-size: 10px; color: #9CA3AF; text-align: center;">Keywords: ${escHtml(med.keywords || 'N/A')}</p>

    <div class="actionRow" style="margin-top: 15px;">
      <button id="scanAgainBtn" class="actBtn secondary"><svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2"><circle cx="11" cy="11" r="8"/><path stroke-linecap="round" stroke-linejoin="round" d="m21 21-4.35-4.35"/></svg> Scan Again</button>
      <button id="setReminderBtn" class="actBtn primary"><svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2"><path stroke-linecap="round" stroke-linejoin="round" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"/></svg> Set Reminder</button>
    </div>
    <div id="interactionWarning" style="display:none; background:#FEF2F2; border:1px solid #FECACA; border-radius:12px; padding:14px 18px; margin-bottom:16px; color:#991B1B; font-size:14px; line-height:1.6;"></div>
  `;

  if (rawText) {
    html += "<details style='background:var(--card);border:1px solid var(--bdr);border-radius:12px;padding:14px 18px;margin-bottom:16px;'><summary style='cursor:pointer;font-size:13px;color:var(--txt3);font-weight:600;list-style:none;'>View raw input text</summary><p style='margin-top:10px;font-size:13px;color:var(--txt2);font-family:monospace;line-height:1.6;'>" + escHtml(rawText) + "</p></details>";
  }

  html += '<div class="disclaimer"><svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg><p><strong>Note:</strong> This data comes from a limited database maintained for this project. Please double-check with an actual pharmacist or your doctor before taking any medicine.</p></div>';

  document.getElementById('resultContent').innerHTML = html;

  // attach event listeners for created buttons (avoid inline onclick with unescaped data)
  var scanBtn = document.getElementById('scanAgainBtn');
  if (scanBtn) scanBtn.addEventListener('click', function() { goTo('scanScreen'); });
  var remBtn = document.getElementById('setReminderBtn');
  if (remBtn) remBtn.addEventListener('click', function() { prefillReminder(med.name, med.strength || ''); });

  goTo('resultScreen');

  // animate confidence bar
  setTimeout(function() {
    var fill = document.getElementById('confFill');
    if (fill) fill.style.width = pct + '%';
  }, 300);
}

// ---- show warning ----
function showWarning(query) {
  document.getElementById('warnContent').innerHTML =
    '<div class="warnHero">' +
    '<div class="warnBigIco"><svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg></div>' +
    '<div class="warnTitle">Not Identified</div>' +
    '<div class="warnMsg">Medicine could not be identified reliably.</div>' +
    '<div class="warnAdvice"><strong>Do NOT consume without consulting a doctor.</strong><br><br>The text "' + escHtml(query) + '" did not match any medicine in our database with sufficient confidence.</div></div>' +
    '<div class="infoBlock" style="margin-bottom:16px;"><div class="blockLabel" style="font-size:13px;color:var(--txt2);margin-bottom:10px;">What you can do:</div>' +
    '<ul style="padding-left:18px;font-size:14px;color:var(--txt2);line-height:2;"><li>Try the <strong>Manual tab</strong> - describe tablet color, shape and imprint</li><li>Check spelling - try the full medicine name</li><li>Try a brand name (e.g. "Crocin" instead of "Paracetamol")</li><li>Consult a pharmacist or doctor for identification</li></ul></div>' +
    '<div class="actionRow"><button class="actBtn secondary" onclick="goTo(\'scanScreen\');switchTab(\'manual\')">Try Manual Input</button><button class="actBtn primary" onclick="goTo(\'scanScreen\')">Search Again</button></div>' +
    '<div class="disclaimer"><svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg><p>MediScan uses a curated medicine database. If your medicine wasn\'t found, it may not be in our registry yet. Always consult a healthcare professional.</p></div>';
  goTo('warnScreen');
}

// ---- home refresh ----
function refreshHome() {
  loadRealTimeStats();
  renderHistoryUI();
}

// Function to fetch and display real-time statistics
async function loadRealTimeStats() {
    try {
        let res = await fetch('/api/stats');
        if (res.ok) {
            let data = await res.json();
            if (data.success) {
                let medCountEl = document.getElementById('statNetworkMeds');
                if (medCountEl) medCountEl.innerText = data.total_meds || 0;
                let scanCountEl = document.getElementById('statNetworkScans');
                if (scanCountEl) scanCountEl.innerText = data.total_scans || 0;
            }
        }
    } catch (e) {
        console.error("Failed to load global stats:", e);
        let medCountEl = document.getElementById('statNetworkMeds');
        let scanCountEl = document.getElementById('statNetworkScans');
        if (medCountEl) medCountEl.innerText = "Error";
        if (scanCountEl) scanCountEl.innerText = "Error";
    }

    let reminders = JSON.parse(localStorage.getItem('mediscan_reminders') || '[]');
    let remCountEl = document.getElementById('statReminders');
    if (remCountEl) remCountEl.innerText = reminders.length;
}

// ---- delete single history item ----
function deleteHistoryItem(index, event) {
  if (event) event.stopPropagation();
  var item = scanHistory[index];
  if (!item) return;
  showConfirm(
    'Delete Scan?',
    'Remove <strong>' + item.name + '</strong> from your history? This can\'t be undone.',
    function() {
      scanHistory.splice(index, 1);
      localStorage.setItem('mediscan_history', JSON.stringify(scanHistory));
      showToast(item.name + ' removed');
      closeOverlays();
      refreshHome();
    }
  );
}

// ---- edit / rename history item ----
function editHistoryItem(index) {
  var item = scanHistory[index];
  if (!item) return;

  var overlay = document.createElement('div');
  overlay.className = 'editOverlay';
  overlay.id = 'editOverlay';
  overlay.innerHTML =
    '<div class="editBox">' +
      '<h3>Edit Scan Entry</h3>' +
      '<label>Medicine Name</label>' +
      '<input type="text" id="editName" value="' + escHtml(item.name || '') + '">' +
      '<label>Strength / Dosage</label>' +
      '<input type="text" id="editStrength" value="' + escHtml(item.strength || '') + '">' +
      '<label>Notes (optional)</label>' +
      '<input type="text" id="editNotes" value="' + escHtml(item.notes || '') + '" placeholder="Add a personal note...">' +
      '<div class="editBtns">' +
        '<button class="cancelBtn" onclick="closeOverlays()">Cancel</button>' +
        '<button class="saveBtn" onclick="saveHistoryEdit(' + index + ')">Save Changes</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(overlay);
}

function saveHistoryEdit(index) {
  var name = document.getElementById('editName').value.trim();
  var strength = document.getElementById('editStrength').value.trim();
  var notes = document.getElementById('editNotes').value.trim();

  if (!name) { showToast('Name cannot be empty'); return; }

  scanHistory[index].name = name;
  scanHistory[index].strength = strength;
  scanHistory[index].notes = notes;
  localStorage.setItem('mediscan_history', JSON.stringify(scanHistory));
  closeOverlays();
  showToast('Scan entry updated');
  refreshHome();
}

// ---- clear all history ----
function clearAllHistory() {
  showConfirm(
    'Clear All History?',
    'This will remove all <strong>' + scanHistory.length + ' scan(s)</strong> from your history. Are you sure?',
    function() {
      scanHistory = [];
      totalScans = 0;
      localStorage.setItem('mediscan_history', '[]');
      localStorage.setItem('mediscan_total', '0');
      closeOverlays();
      showToast('All scan history cleared');
      refreshHome();
    }
  );
}

// 1. Save scan to history
function saveToHistory(scanData, rawText) {
    // Add new scan to the beginning of the global array
    scanHistory.unshift({
        timestamp: new Date().getTime(),
        raw: rawText,
        data: scanData
    });

    // Keep only the last 20 scans to prevent local storage bloat
    if (scanHistory.length > 20) scanHistory.pop();
    
    localStorage.setItem('mediscan_history', JSON.stringify(scanHistory));
    renderHistoryUI();
}

// 2. Render the history list to the screen
function renderHistoryUI() {
    // Always re-sync from the global array
    let list = document.getElementById('historyList');
    let clearBtn = document.getElementById('clearAllBtn');
    
    if (!list) return;
    
    if (scanHistory.length === 0) {
        list.innerHTML = '<div class="emptyBox"><div class="emptyIco">&#128138;</div><div class="emptyTxt">Nothing here yet.<br>Go to the <strong>Search</strong> page to look up a medicine!</div></div>';
        if(clearBtn) clearBtn.style.display = 'none';
        return;
    }

    if(clearBtn) clearBtn.style.display = 'flex';

    list.innerHTML = scanHistory.map((h, index) => {
        let medName = (h.data && h.data.name) ? h.data.name : "Unknown / Unverified Scan";
        let dateStr = new Date(h.timestamp).toLocaleString();
        let icon = (h.data && h.data.verified) ? "✅" : "💊";
        
        return `
        <div style="background:var(--card); border:1px solid var(--bdr); border-radius:12px; padding:14px; margin-bottom:10px; display:flex; justify-content:space-between; align-items:center; transition:0.2s;">
            
            <div onclick="reopenHistoryItem(${index})" style="cursor:pointer; flex:1;">
                <div style="font-weight:600; color:var(--txt); font-size:15px; margin-bottom:4px;">${icon} ${escHtml(medName)}</div>
                <div style="font-size:12px; color:var(--txt2);">${dateStr}</div>
            </div>
            
            <button onclick="deleteHistoryItem(${index}, event)" style="background:none; border:none; color:#EF4444; cursor:pointer; padding:8px;">
                <svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
            </button>
            
        </div>`;
    }).join('');
}

// 3. The function that triggers when a user clicks a history card
function reopenHistoryItem(index) {
    if (index < 0 || index >= scanHistory.length) return;
    let item = scanHistory[index];
    if (item && item.data) {
        showResult(item.data, null); // Pass null rawText to avoid re-adding to history
    }
}



// Call renderHistoryUI() when the app loads
document.addEventListener('DOMContentLoaded', () => {
    renderHistoryUI();
    loadRealTimeStats();
});

// ---- confirm dialog helper ----
function showConfirm(title, message, onConfirm) {
  var overlay = document.createElement('div');
  overlay.className = 'confirmOverlay';
  overlay.id = 'confirmOverlay';
  overlay.innerHTML =
    '<div class="confirmBox">' +
      '<h3>' + title + '</h3>' +
      '<p>' + message + '</p>' +
      '<div class="confirmBtns">' +
        '<button class="cancelBtn" onclick="closeOverlays()">Cancel</button>' +
        '<button class="dangerBtn" id="confirmYes">Yes, Delete</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(overlay);
  document.getElementById('confirmYes').onclick = onConfirm;
}

function closeOverlays() {
  var c = document.getElementById('confirmOverlay');
  var e = document.getElementById('editOverlay');
  if (c) c.remove();
  if (e) e.remove();
}

// ---- reminders ----
function addReminder() {
  var name = document.getElementById('rName').value.trim();
  var dose = document.getElementById('rDose').value.trim();
  var time = document.getElementById('rTime').value;
  var freq = document.getElementById('rFreq').value;

  if (!name) { showToast('Please enter a medicine name'); return; }
  if (!time) { showToast('Please set a time'); return; }

  reminders.unshift({
    id: Date.now(), name: name, dose: dose,
    time: time, freq: freq, active: true,
    created: new Date().toLocaleDateString()
  });
  localStorage.setItem('mediscan_reminders', JSON.stringify(reminders));
  document.getElementById('rName').value = '';
  document.getElementById('rDose').value = '';
  showToast('Reminder added!');
  renderReminders();
}

function prefillReminder(name, dose) {
  goTo('reminderScreen');
  setTimeout(function() {
    document.getElementById('rName').value = name;
    document.getElementById('rDose').value = dose;
    document.getElementById('rName').focus();
    showToast('Medicine pre-filled - set your time!');
  }, 100);
}

function toggleReminder(id) {
  for (var i = 0; i < reminders.length; i++) {
    if (reminders[i].id === id) { reminders[i].active = !reminders[i].active; break; }
  }
  localStorage.setItem('mediscan_reminders', JSON.stringify(reminders));
  renderReminders();
}

function deleteReminder(id) {
  reminders = reminders.filter(function(r) { return r.id !== id; });
  localStorage.setItem('mediscan_reminders', JSON.stringify(reminders));
  showToast('Reminder deleted');
  renderReminders();
}

function renderReminders() {
  var list = document.getElementById('reminderList');
  if (!reminders.length) {
    list.innerHTML = '<div class="emptyBox"><div class="emptyIco">&#9200;</div><div class="emptyTxt">No reminders set yet.<br>Add one above to get notified!</div></div>';
    return;
  }
  var html = '';
  for (var i = 0; i < reminders.length; i++) {
    var r = reminders[i];
    html += '<div class="reminderCard">' +
      '<div class="remIco"><svg fill="none" viewBox="0 0 24 24" stroke="var(--pri)" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"/></svg></div>' +
      '<div class="remInfo"><div class="remName">' + r.name + '</div><div class="remTime">&#128336; ' + formatTime(r.time) + ' &middot; ' + r.freq + '</div>' +
      (r.dose ? '<div class="remDose">' + r.dose + '</div>' : '') + '</div>' +
      '<label class="toggleWrap"><input type="checkbox" ' + (r.active ? 'checked' : '') + ' onchange="toggleReminder(' + r.id + ')"><span class="toggleTrack"></span></label>' +
      '<button class="delBtn" onclick="deleteReminder(' + r.id + ')"><svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg></button></div>';
  }
  list.innerHTML = html;
}

function formatTime(t) {
  if (!t) return '';
  var parts = t.split(':');
  var h = parseInt(parts[0]); var m = parts[1];
  var ampm = h >= 12 ? 'PM' : 'AM';
  var hr = h % 12 || 12;
  return hr + ':' + m + ' ' + ampm;
}

// ---- profile ----
function loadProfile() {
  fetch('/api/profile', {credentials: 'same-origin'})
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.name) document.getElementById('pName').value = data.name;
      if (data.age) document.getElementById('pAge').value = data.age;
      if (data.blood) document.getElementById('pBlood').value = data.blood;
      if (data.phone) document.getElementById('pPhone').value = data.phone;
      if (data.doctor) document.getElementById('pDoctor').value = data.doctor;
      if (data.allergy) document.getElementById('pAllergy').value = data.allergy;
    })
    .catch(function() { /* backend offline, no profile to load */ });
}

function saveProfile() {
  var profileData = {
    name: document.getElementById('pName').value.trim(),
    age: document.getElementById('pAge').value.trim(),
    blood: document.getElementById('pBlood').value,
    phone: document.getElementById('pPhone').value.trim(),
    doctor: document.getElementById('pDoctor').value.trim(),
    allergy: document.getElementById('pAllergy').value.trim()
  };

  fetch('/api/profile', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(profileData)
  })
  .then(function() {
    var msg = document.getElementById('profileMsg');
    msg.style.display = 'block';
    setTimeout(function() { msg.style.display = 'none'; }, 2500);
    showToast('Profile saved!');
  })
  .catch(function() {
    showToast('Could not save - is the server running?');
  });
}

// ---- QR generation (connected to python backend) ----
function generateQR() {
  var medData = {
    medicine: {
      name: document.getElementById('qrMedName').value.trim() || 'N/A',
      dosage: document.getElementById('qrDosage').value.trim() || 'N/A',
      manufactured: document.getElementById('qrMfg').value.trim() || 'N/A',
      expiry: document.getElementById('qrExp').value.trim() || 'N/A',
      batch: document.getElementById('qrBatch').value.trim() || 'N/A',
      disease: document.getElementById('qrDisease').value.trim() || 'N/A',
      sideEffects: document.getElementById('qrSide').value.trim() || 'N/A',
      instructions: document.getElementById('qrInst').value.trim() || 'N/A'
    }
  };

  if (document.getElementById('qrIncludeProfile').checked) {
    medData.patient = {
      name: document.getElementById('pName').value.trim(),
      age: document.getElementById('pAge').value.trim(),
      blood: document.getElementById('pBlood').value,
      phone: document.getElementById('pPhone').value.trim(),
      doctor: document.getElementById('pDoctor').value.trim(),
      allergy: document.getElementById('pAllergy').value.trim()
    };
  }

  fetch('/api/generate-qr', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(medData)
  })
  .then(function(r) {
    return r.json().then(function(d) { return { status: r.status, ok: r.ok, data: d }; })
      .catch(function() { return { status: r.status, ok: r.ok, data: null }; });
  })
  .then(function(res) {
    var data = res.data || {};
    if (res.ok && data.image) {
      var area = document.getElementById('qrOutputArea');
      area.innerHTML = '<div class="qrOutput"><img src="data:image/png;base64,' + data.image + '" alt="QR Code"><p>Print at 1-1.2 cm for optimal scanning</p>' +
        '<a href="data:image/png;base64,' + data.image + '" download="medicine-qr.png" class="actBtn primary" style="display:inline-flex;margin-top:12px;text-decoration:none;">Download QR</a></div>';
      showToast('QR code generated!');
      return;
    }

    // handle backend signalling that QR deps are missing (status 501 or install field)
    if (data && data.install) {
      var area = document.getElementById('qrOutputArea');
      area.innerHTML = '<div class="infoBlock wide" style="margin-top:12px;padding:12px;">' +
        '<div class="blockHead"><span class="blockLabel" style="color:var(--pri);">QR Generation Unavailable</span></div>' +
        '<div class="blockTxt">' +
        '<strong>Error:</strong> ' + escHtml(data.error || 'Dependencies missing') + '<br><br>' +
        '<strong>To enable QR features run:</strong><pre style="white-space:pre-wrap;background:#f6f8fa;padding:8px;border-radius:8px;margin-top:8px;">' + escHtml(data.install) + '</pre>' +
        '</div></div>';
      showToast('QR generation unavailable');
      return;
    }

    // generic error
    showToast('Error: ' + (data.error || 'failed to generate QR'));
  })
  .catch(function(err) {
    console.error('generateQR error:', err);
    showToast('Server not running - cannot generate QR');
  });
}

// ---- QR scanning ----
// Replace scanQRFile (Profile tab scanner)
function scanQRFile(e) {
  var file = e.target.files[0];
  if (!file) return;
  var formData = new FormData();
  formData.append('file', file);

  fetch('/api/scan-qr', { method: 'POST', body: formData })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.found && data.data && data.data.medicine) {
        // FIX: Route directly to the main result screen
        showResult(data.data.medicine, "Decoded from Prescription QR");
        showToast('QR code decoded successfully!');
      } else {
        showToast('No QR code found in this image');
      }
    }).catch(function() { showToast('Server not running - cannot scan QR'); });
}

// ---- toast ----
var toastTimer = null;
function showToast(msg) {
  var el = document.getElementById('toast');
  el.textContent = msg;
  if (toastTimer) clearTimeout(toastTimer);
  el.classList.add('show');
  toastTimer = setTimeout(function() { el.classList.remove('show'); toastTimer = null; }, 2500);
}

// ---- browser notifications ----
if ('Notification' in window && Notification.permission === 'default') {
  Notification.requestPermission();
}

// check reminders every minute
setInterval(function() {
  var now = new Date();
  var hm = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
  for (var i = 0; i < reminders.length; i++) {
    var r = reminders[i];
    if (r.active && r.time === hm) {
      if (Notification.permission === 'granted') {
        new Notification('Medicine Reminder: ' + r.name, {
          body: 'Time to take ' + (r.dose || r.name) + '. Stay healthy!'
        });
      }
      showToast('Reminder: Take ' + r.name);
    }
  }
}, 60000);

// ---- camera scanner (google lens style) ----
var camStream = null;
var camFacing = 'environment'; // back camera first
var capturedDataUrl = null;

function openCamera() {
  var overlay = document.getElementById('cameraOverlay');
  overlay.classList.add('open');
  document.getElementById('camPreview').classList.remove('show');
  startCameraStream();
}

function startCameraStream() {
  var constraints = {
    video: {
      facingMode: camFacing,
      width: { ideal: 1280 },
      height: { ideal: 720 }
    },
    audio: false
  };

  navigator.mediaDevices.getUserMedia(constraints)
    .then(function(stream) {
      camStream = stream;
      var video = document.getElementById('camVideo');
      video.srcObject = stream;
      video.play();
      showToast('Camera active - ready to scan');
    })
    .catch(function(err) {
      console.log('camera error:', err);
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        alert("Camera Permission Denied. Please enable camera access in your browser settings to use the scanner.");
      } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
        alert("No camera detected on this device. Please use the 'Upload Image' instead.");
      } else {
        showToast('Camera Error: ' + err.message);
      }
      closeCamera();
    });
}

function closeCamera() {
  if (camStream) {
    camStream.getTracks().forEach(function(t) { t.stop(); });
    camStream = null;
  }
  var video = document.getElementById('camVideo');
  video.srcObject = null;
  document.getElementById('cameraOverlay').classList.remove('open');
  document.getElementById('camPreview').classList.remove('show');
}

function flipCamera() {
  camFacing = (camFacing === 'environment') ? 'user' : 'environment';
  if (camStream) {
    camStream.getTracks().forEach(function(t) { t.stop(); });
  }
  startCameraStream();
  showToast(camFacing === 'user' ? 'Front camera' : 'Back camera');
}

function capturePhoto() {
  var video = document.getElementById('camVideo');
  var canvas = document.getElementById('camCanvas');
  canvas.width = video.videoWidth || 640;
  canvas.height = video.videoHeight || 480;
  var ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  // flash effect
  var flash = document.getElementById('camFlash');
  flash.classList.add('fired');
  setTimeout(function() { flash.classList.remove('fired'); }, 200);

  capturedDataUrl = canvas.toDataURL('image/jpeg', 0.85);

  // show preview
  document.getElementById('camPreviewImg').src = capturedDataUrl;
  document.getElementById('camPreview').classList.add('show');
}

function retakePhoto() {
  document.getElementById('camPreview').classList.remove('show');
  capturedDataUrl = null;
}

// Replace usePhoto (Camera scanner)
function usePhoto() {
  if (!capturedDataUrl) return;
  closeCamera();
  showToast('Processing captured image...');

  var canvas = document.getElementById('camCanvas');
  var photoUrl = capturedDataUrl;
  capturedDataUrl = null;

  canvas.toBlob(function(blob) {
    var formData = new FormData();
    formData.append('file', blob, 'camera-capture.jpg');

    fetch('/api/scan-qr', { method: 'POST', body: formData })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.found && data.data && data.data.medicine) {
           // FIX: Route directly to the main result screen
          showResult(data.data.medicine, "Captured via Camera");
          showToast('QR code found and decoded!');
        } else {
          showCapturedInScan(photoUrl);
        }
      })
      .catch(function() { showCapturedInScan(photoUrl); });
  }, 'image/jpeg', 0.85);
}

// helper to show captured photo in scan page
function showCapturedInScan(photoUrl) {
  goTo('scanScreen');
  switchTab('text');
  document.getElementById('ocrInput').value = '';
  var zone = document.getElementById('uploadZone');
  zone.innerHTML = '<img src="' + photoUrl + '" style="max-height:120px;border-radius:8px;object-fit:cover;margin-bottom:8px;">' +
    '<p style="color:var(--pri);font-weight:600;font-size:13px;">Photo captured. Tap Search to look it up.</p>';
  showToast('No QR detected. Please type the medicine name manually.');
}
// ====== AI CHAT LOGIC ======
function toggleAIChat() {
  const chatWindow = document.getElementById('aiChatWindow');
  chatWindow.classList.toggle('open');
  if (chatWindow.classList.contains('open')) {
    document.getElementById('aiChatInput').focus();
  }
}

function askQuickQuestion(question) {
  const inputEl = document.getElementById('aiChatInput');
  if (inputEl) {
    inputEl.value = question;
    triggerSend('text');
  }
}

function handleAIChatEnter(event) {
  if (event.key === 'Enter') {
    triggerSend('text');
  }
}

function sendAIMessage() {
  const inputEl = document.getElementById('aiChatInput');
  const text = inputEl.value.trim();
  if (!text) return;

  addChatMessage(text, 'user-msg');
  inputEl.value = '';

  if (!currentScannedMedicine) {
    addChatMessage("👋 Please scan or search for a medicine first — then I can answer all your questions about it!", 'ai-msg');
    return;
  }

  // Hide the welcome card and quick chips once conversation starts
  let welcomeCard = document.querySelector('.ai-welcome-card');
  if (welcomeCard) welcomeCard.style.display = 'none';

  const chatBox = document.getElementById('aiChatMessages');
  const loadingId = 'loading-' + Date.now();
  chatBox.innerHTML += `<div id="${loadingId}" class="ai-typing-indicator"><span></span><span></span><span></span></div>`;
  chatBox.scrollTop = chatBox.scrollHeight;

  let selectedLang = document.getElementById('aiLangSelect') ? document.getElementById('aiLangSelect').value : 'en-IN';

  fetchWithTimeout('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ 
      query: text, 
      medicine: currentScannedMedicine,
      language: selectedLang 
    }),
    timeout: 25000 // Give AI 25 seconds to think
  })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      document.getElementById(loadingId).remove();
      if (data.reply) {
        addChatMessage(data.reply, 'ai-msg');
        // Auto-read ONLY if the user used the mic
        if (isVoiceModeActive) {
            readAloud(data.reply);
            isVoiceModeActive = false; // CRITICAL: Reset flag
        }
      } else if (data.error) {
        let msg = "Error: " + data.error;
        addChatMessage(msg, 'ai-msg');
        if (isVoiceModeActive) {
            readAloud(msg);
            isVoiceModeActive = false;
        }
      } else {
        let msg = "Sorry, I encountered an error. Please try again.";
        addChatMessage(msg, 'ai-msg');
        if (isVoiceModeActive) {
            readAloud(msg);
            isVoiceModeActive = false;
        }
      }
    })
  .catch(function(err) {
    document.getElementById(loadingId).remove();
    addChatMessage("Server error: Could not reach the AI assistant.", 'ai-msg');
  });
}

function formatAIText(text) {
  // Escape HTML first
  let s = escHtml(text);

  // Style the disclaimer block specially
  s = s.replace(/⚠️\s*\*(.*?)\*/g, '<div class="ai-disclaimer">⚠️ $1</div>');

  // Bold: **text** → styled strong
  s = s.replace(/\*\*(.*?)\*\*/g, '<strong style="color:#0F766E;">$1</strong>');
  // Italics: *text*
  s = s.replace(/\*(.*?)\*/g, '<em>$1</em>');

  // Headings: lines starting with ### or ##
  s = s.replace(/^###\s*(.+)$/gm, '<div class="ai-heading">$1</div>');
  s = s.replace(/^##\s*(.+)$/gm, '<div class="ai-heading">$1</div>');

  // Bullet lists: lines starting with * or -
  s = s.replace(/\n\* (.+)/g, '\n<div class="ai-bullet"><span class="ai-dot"></span>$1</div>');
  s = s.replace(/\n- (.+)/g, '\n<div class="ai-bullet"><span class="ai-dot"></span>$1</div>');
  // Also match bullets at the very start
  s = s.replace(/^\* (.+)/gm, '<div class="ai-bullet"><span class="ai-dot"></span>$1</div>');
  s = s.replace(/^- (.+)/gm, '<div class="ai-bullet"><span class="ai-dot"></span>$1</div>');

  // Numbered lists: 1. 2. 3.
  s = s.replace(/\n(\d+)\.\s+(.+)/g, '\n<div class="ai-bullet"><span class="ai-num">$1.</span>$2</div>');

  // Line breaks (remaining \n)
  s = s.replace(/\n/g, '<br>');

  // Clean up double <br> from bullet conversion
  s = s.replace(/<br><div class="ai-bullet">/g, '<div class="ai-bullet">');
  s = s.replace(/<br><div class="ai-heading">/g, '<div class="ai-heading">');
  s = s.replace(/<br><div class="ai-disclaimer">/g, '<div class="ai-disclaimer">');

  return s;
}

function addChatMessage(text, className) {
  const chatBox = document.getElementById('aiChatMessages');

  if (className === 'ai-msg') {
    // Format AI text with rich rendering
    let safeText = formatAIText(text);

    // Store voice text in array for speaker button
    let cleanVoiceText = text.replace(/[*#]/g, '').replace(/['"]/g, "");
    let voiceIdx = _voiceMsgStore.length;
    _voiceMsgStore.push(cleanVoiceText);

    let aiMessageHTML = `
      <div class="msg-bubble ai-msg">
          <div class="ai-msg-body">
              ${safeText}
          </div>
          <button onclick="readAloud(_voiceMsgStore[${voiceIdx}])" class="ai-speaker-btn" title="Listen">
              <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M15.536 8.464a5 5 0 010 7.072M17.657 6.343a8 8 0 010 11.314M11 5L6 9H2v6h4l5 4V5z"/>
              </svg>
          </button>
      </div>
    `;
    chatBox.innerHTML += aiMessageHTML;
  } else {
    let safeText = escHtml(text);
    chatBox.innerHTML += `<div class="msg-bubble ${className}">${safeText}</div>`;
  }
  chatBox.scrollTop = chatBox.scrollHeight;
}

// ==========================================
// UNIFIED VOICE ENGINE (CHAT + MANUAL AUDIO)
// ==========================================
let isVoiceModeActive = false; 
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition;

// Force voices to load in the background
if ('speechSynthesis' in window) {
    window.speechSynthesis.onvoiceschanged = () => window.speechSynthesis.getVoices();
    window.speechSynthesis.getVoices();
}

// 1. The Master Reader Function
function readAloud(text, targetLang = null) {
    if (!('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel(); // Stop current audio

    // If no language is passed, grab it from the dropdown, default to English (India)
    if (!targetLang) {
        let langDropdown = document.getElementById('aiLangSelect');
        targetLang = langDropdown ? langDropdown.value : 'en-IN';
    }

    // Strip weird characters and HTML that break speech engines
    let cleanText = text.replace(/[*#]/g, '').replace(/(<([^>]+)>)/gi, "");
    
    let utterance = new SpeechSynthesisUtterance(cleanText);
    let voices = window.speechSynthesis.getVoices();
    
    // 1. First, prioritize high-quality network/cloud voices for emotion and natural inflection
    let bestVoice = voices.find(v => 
        (v.lang.includes(targetLang) || v.lang.includes(targetLang.split('-')[0])) && 
        (v.name.includes('Google') || v.name.includes('Natural') || v.name.includes('Microsoft') || v.name.includes('Premium'))
    );
    
    // 2. Fallback to any voice matching the language if no premium voice is found
    if (!bestVoice) {
        bestVoice = voices.find(v => v.lang.includes(targetLang) || v.lang.includes(targetLang.split('-')[0]));
    }
    
    if (bestVoice) {
        utterance.voice = bestVoice;
    }
    // Always set the language explicitly 
    utterance.lang = targetLang;

    // Tweak pitch and rate to make it sound slightly warmer and more conversational
    utterance.pitch = 1.05; 
    utterance.rate = 0.95;

    // Show/hide stop button if it exists
    let stopBtn = document.getElementById('stopAudioBtn');
    if (stopBtn) {
        stopBtn.style.display = 'block';
        utterance.onend = () => stopBtn.style.display = 'none';
        utterance.onerror = () => stopBtn.style.display = 'none';
    }

    window.speechSynthesis.speak(utterance);
}

// 2. The Chatbot Listener
if (SpeechRecognition) {
    recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = false;

    recognition.onstart = function() {
        let mic = document.getElementById('micBtn');
        let stat = document.getElementById('voiceStatus');
        if(mic) { mic.style.color = '#EF4444'; mic.style.borderColor = '#EF4444'; }
        if(stat) stat.style.display = 'block';
        window.speechSynthesis.cancel(); // Shut up AI if user interrupts
    };

    recognition.onresult = function(event) {
        let transcript = event.results[0][0].transcript;
        let input = document.getElementById('aiChatInput');
        if (input) {
            input.value = transcript;
            triggerSend('voice'); 
        }
    };

    recognition.onend = function() {
        let mic = document.getElementById('micBtn');
        let stat = document.getElementById('voiceStatus');
        if(mic) { mic.style.color = 'var(--txt)'; mic.style.borderColor = 'var(--bdr)'; }
        if(stat) stat.style.display = 'none';
    };

    recognition.onerror = function() {
        let mic = document.getElementById('micBtn');
        let stat = document.getElementById('voiceStatus');
        if(mic) { mic.style.color = 'var(--txt)'; mic.style.borderColor = 'var(--bdr)'; }
        if(stat) stat.style.display = 'none';
    };
}

function toggleListening() {
    if (!recognition) { alert("Voice input not supported on this browser. Use Chrome."); return; }
    // Unlock mobile audio
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(''));
    let langDropdown = document.getElementById('aiLangSelect');
    recognition.lang = langDropdown ? langDropdown.value : 'en-IN';
    try { recognition.start(); } catch(e) { recognition.stop(); }
}

function stopSpeaking() {
    window.speechSynthesis.cancel();
    let stopBtn = document.getElementById('stopAudioBtn');
    if (stopBtn) stopBtn.style.display = 'none';
}

function triggerSend(mode) {
    let input = document.getElementById('aiChatInput');
    if (!input || !input.value.trim()) return;
    isVoiceModeActive = (mode === 'voice'); // Flag if voice was used
    sendAIMessage(); 
}

function resetMicUI() {
    let mic = document.getElementById('micBtn');
    let stat = document.getElementById('voiceStatus');
    if(mic) { mic.style.color = 'var(--txt)'; mic.style.borderColor = 'var(--bdr)'; }
    if(stat) stat.style.display = 'none';
}

// --- INDIAN LANGUAGE LOADER (with hardcoded fallback) ---
const _indianLangs = [
    { code: 'en-IN', label: '🗣️ English (India)' },
    { code: 'hi-IN', label: '🗣️ हिंदी (Hindi)' },
    { code: 'mr-IN', label: '🗣️ मराठी (Marathi)' },
    { code: 'bn-IN', label: '🗣️ বাংলা (Bengali)' },
    { code: 'ta-IN', label: '🗣️ தமிழ் (Tamil)' },
    { code: 'te-IN', label: '🗣️ తెలుగు (Telugu)' },
    { code: 'gu-IN', label: '🗣️ ગુજરાતી (Gujarati)' },
    { code: 'kn-IN', label: '🗣️ ಕನ್ನಡ (Kannada)' },
    { code: 'ml-IN', label: '🗣️ മലയാളം (Malayalam)' }
];

function populateIndianLanguages() {
    let dropdown = document.getElementById('aiLangSelect');
    if (!dropdown) return;
    
    // Always populate with all Indian languages (hardcoded)
    dropdown.innerHTML = '';
    _indianLangs.forEach(lang => {
        let opt = document.createElement('option');
        opt.value = lang.code;
        opt.textContent = lang.label;
        dropdown.appendChild(opt);
    });
    dropdown.value = 'en-IN';
}

// Populate immediately on load
populateIndianLanguages();

// Also refresh if voices load later (may add more detail)
if ('speechSynthesis' in window) {
    window.speechSynthesis.onvoiceschanged = () => {
        populateIndianLanguages();
    };
}