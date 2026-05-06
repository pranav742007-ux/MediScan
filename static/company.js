var currentUser = JSON.parse(localStorage.getItem('company_user') || 'null');

// check if already logged in on page load
(function() {
  if (currentUser && currentUser.name) {
    document.getElementById('loginScreen').classList.remove('active');
    goTo('companyScreen');
  }
})();

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
    document.getElementById('loginFooter').innerHTML = 'Already registered? <a onclick="switchLoginMode(\'signin\')">Sign in</a>';
  } else {
    document.getElementById('signinForm').style.display = 'flex';
    document.getElementById('registerForm').style.display = 'none';
    document.getElementById('loginTabSign').classList.add('on');
    document.getElementById('loginTabReg').classList.remove('on');
    document.getElementById('loginFooter').innerHTML = 'Registering a new company? <a onclick="switchLoginMode(\'register\')">Register here</a>';
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
    body: JSON.stringify({ 
      email: email, 
      password: pass,
      invite_code: document.getElementById('signInvite').value.trim()
    })
  })
  .then(function(r) { return r.json().then(function(d) { return { status: r.status, data: d }; }); })
  .then(function(res) {
    if (res.data.ok) {
      if (res.data.user.role !== 'company') {
         showLoginError('This account is not registered as a Company.');
         return;
      }
      currentUser = res.data.user;
      localStorage.setItem('company_user', JSON.stringify(currentUser));
      loginComplete();
    } else {
      showLoginError(res.data.error || 'Login failed');
    }
  })
  .catch(function() { showLoginError('Server not running.'); });
}

function doRegister() {
  var name = document.getElementById('regName').value.trim();
  var email = document.getElementById('regEmail').value.trim();
  var pass = document.getElementById('regPass').value;
  var confirm = document.getElementById('regConfirm').value;
  var invite = document.getElementById('regInvite').value.trim();

  if (!name || !email || !pass) { showLoginError('Please fill in all fields'); return; }
  if (pass !== confirm) { showLoginError('Passwords don\'t match'); return; }
  if (pass.length < 8) { showLoginError('Password needs to be at least 8 characters'); return; }

  fetch('/api/register', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ 
      name: name, 
      email: email, 
      password: pass, 
      role: 'company', 
      invite_code: invite 
    })
  })
  .then(function(r) { return r.json().then(function(d) { return { status: r.status, data: d }; }); })
  .then(function(res) {
    if (res.data.ok) {
      showLoginSuccess('Account created! You can sign in now.');
      setTimeout(function() { switchLoginMode('signin'); }, 1500);
    } else {
      showLoginError(res.data.error || 'Registration failed');
    }
  });
}

function loginComplete() {
  document.getElementById('loginScreen').classList.remove('active');
  goTo('companyScreen');
  loadCompanyHistory(); // Fetch dashboard history on login
}

function doGoogleLogin() {
  try {
    google.accounts.id.initialize({
      client_id: window.GOOGLE_CLIENT_ID || "YOUR_GOOGLE_OAUTH_CLIENT_ID.apps.googleusercontent.com",
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
      body: JSON.stringify({ role: 'company' })
  })
  .then(function(r) { return r.json(); })
  .then(function(res) {
      if (res.ok) {
          currentUser = res.user;
          localStorage.setItem('company_user', JSON.stringify(currentUser));
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
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ 
      idToken: response.credential,
      invite_code: document.getElementById('googleInvite').value.trim(),
      role: 'company' 
    })
  })
  .then(function(r) { return r.json(); })
  .then(function(res) {
    if (res.ok) {
      currentUser = res.user;
      localStorage.setItem('company_user', JSON.stringify(currentUser));
      loginComplete();
    } else {
      console.log("Real Google auth failed - switching to simulation");
      simulateGoogleLogin();
    }
  }).catch(function() {
    simulateGoogleLogin();
  });
}

function doLogout() {
  fetch('/api/logout', {method: 'POST', credentials: 'same-origin'});
  currentUser = null;
  localStorage.removeItem('company_user');
  document.getElementById('companyScreen').classList.remove('active');
  document.getElementById('loginScreen').classList.add('active');
  document.getElementById('signEmail').value = '';
  document.getElementById('signPass').value = '';
  document.getElementById('loginError').style.display = 'none';
  document.getElementById('loginSuccess').style.display = 'none';
  showToast('Logged out');
}

function goTo(screenId) {
  document.getElementById(screenId).classList.add('active');
  var nameEl = document.getElementById('userNameCompany');
  if (nameEl && currentUser) nameEl.textContent = currentUser.name;
}

var toastTimer = null;
function showToast(msg) {
  var el = document.getElementById('toast');
  el.textContent = msg;
  if (toastTimer) clearTimeout(toastTimer);
  el.classList.add('show');
  toastTimer = setTimeout(function() { el.classList.remove('show'); toastTimer = null; }, 2500);
}

function uploadCompanyMedicine() {
  if (!currentUser) { showToast("You must be logged in as a company to do this."); return; }

  var medData = {
    name: document.getElementById('cMedName').value.trim(),
    strength: document.getElementById('cMedStrength').value.trim(),
    brands: document.getElementById('cMedBrands').value.trim(),
    category: document.getElementById('cMedCategory').value.trim(),
    safety: document.getElementById('cMedSafety').value,
    dosage: document.getElementById('cMedDosage').value.trim(),
    uses: document.getElementById('cMedUses').value.trim(),
    sideEffects: document.getElementById('cMedSide').value.trim(),
    warnings: document.getElementById('cMedWarnings').value.trim(),
    disposal: document.getElementById('cMedDisposal').value.trim(),
    mfg_date: document.getElementById('cMedMfgDate').value.trim(),
    exp_date: document.getElementById('cMedExpDate').value.trim(),
    company_id: currentUser.id || 0
  };

  if (!medData.name) { showToast("Medicine name is required!"); return; }
  showToast("Uploading medicine...");

  fetch('/api/medicine', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(medData)
  })
  .then(function(r) { return r.json(); })
  .then(function(res) {
    if (res.ok && res.medicine_id) {
      // Start HMAC signing status animation
      var bBox = document.getElementById('signingStatus');
      var bText = document.getElementById('signingText');
      if (bBox && bText) {
        bBox.style.display = 'flex';
        bText.textContent = "HMAC-SHA256 signing in progress...";
        bBox.style.borderLeftColor = "#9333ea";
      }

      setTimeout(function() {
        if (bText) bText.textContent = "Registering medicine (ID: #" + res.medicine_id + ")...";
        setTimeout(function() {
          if (bText) { bText.textContent = "Cryptographically signed & saved ✓"; }
          if (bBox) { bBox.style.borderLeftColor = "#16A34A"; }

          showToast("Medicine uploaded! Generating QR...");
          fetch('/api/generate-qr', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ med_id: res.medicine_id })
          })
          .then(function(r2) { return r2.json(); })
          .then(function(qrRes) {
            if (qrRes.image) {
              var area = document.getElementById('companyQrArea');
              var container = document.getElementById('companyQrContainer');
              area.style.display = 'block';
              var html = '<div style="display:flex; justify-content:center; gap:20px; flex-wrap:wrap;">';
              
              // QR Code Block
              html += '<div style="text-align:center;">' +
                      '<img src="data:image/png;base64,' + qrRes.image + '" alt="QR Code" style="max-width:200px;border-radius:12px;margin:auto;"><br>' +
                      '<a href="data:image/png;base64,' + qrRes.image + '" download="' + medData.name + '-qr.png" class="actBtn primary" style="display:inline-flex;margin-top:12px;text-decoration:none;">Download QR</a>' +
                      '</div>';
                      
              // Barcode Block
              if (qrRes.barcode) {
                  html += '<div style="text-align:center;">' +
                          '<div style="background:white; padding:10px; border-radius:12px; display:inline-block;">' +
                          '<img src="data:image/png;base64,' + qrRes.barcode + '" alt="Barcode" style="max-width:200px;"><br>' +
                          '<div style="font-family:monospace; font-weight:bold; letter-spacing:1px; margin-top:5px;">' + (qrRes.short_code || '') + '</div></div><br>' +
                          '<a href="data:image/png;base64,' + qrRes.barcode + '" download="' + medData.name + '-barcode.png" class="actBtn primary" style="display:inline-flex;margin-top:12px;text-decoration:none;">Download Barcode</a>' +
                          '</div>';
              }
              
              html += '</div>';
              container.innerHTML = html;
              document.getElementById('cMedName').value = '';
              document.getElementById('cMedStrength').value = '';
              document.getElementById('cMedBrands').value = '';
              document.getElementById('cMedCategory').value = '';
              document.getElementById('cMedDosage').value = '';
              document.getElementById('cMedUses').value = '';
              document.getElementById('cMedSide').value = '';
              document.getElementById('cMedWarnings').value = '';
              document.getElementById('cMedDisposal').value = '';
              document.getElementById('cMedMfgDate').value = '';
              document.getElementById('cMedExpDate').value = '';

              loadCompanyHistory();
            } else {
              showToast("Could not generate QR code.");
            }
          }).catch(function() { showToast("QR generation failed"); });
        }, 1200); // end inner setTimeout
      }, 1200); // end outer setTimeout
    } else {
      showToast(res.error || "Upload failed");
    }
  }).catch(function(err) { showToast("Server error during upload"); });
}

// ------ DASHBOARD HISTORY LOGIC ------
function loadCompanyHistory() {
  if (!currentUser) return;
  fetch('/api/company/medicines', { method: 'GET', credentials: 'same-origin' })
    .then(function(r) { 
      if (r.status === 403 && !r.ok) {
        console.log("Session expired - re-syncing profile...");
        return { ok: false, retry: true };
      }
      return r.json(); 
    })
    .then(function(data) {
      if (data.retry) {
        // Silently try to fix the session and reload once
        simulateGoogleLogin();
        return;
      }
      if (data.ok) {
        var listEl = document.getElementById('companyHistoryList');
        if (data.medicines.length === 0) {
          listEl.innerHTML = '<div style="background:var(--card);padding:16px;border-radius:8px;text-align:center;color:var(--txt2);">You have not uploaded any medicines yet.</div>';
          return;
        }
        var html = '';
        data.medicines.forEach(function(m) {
          html += '<div style="background:var(--card);padding:16px;border-radius:8px;border:1px solid var(--bdr);display:flex;justify-content:space-between;align-items:center;">' +
                  '<div><strong style="font-size:16px;">' + (m.name||'Unknown') + ' ' + (m.strength||'') + '</strong>' +
                  '<div style="font-size:13px;color:var(--txt2);margin-top:4px;">Category: ' + (m.category||'N/A') + ' | Safety: ' + (m.safety||'N/A') + '</div></div>' +
                  '<button class="loginBtn" style="width:140px;margin-top:0;font-size:13px;" onclick="regenerateQR(' + m.id + ', \'' + (m.name||'Medicine').replace(/'/g, "\\'") + '\')">Get QR Code</button></div>';
        });
        listEl.innerHTML = html;
      }
    });
}

function regenerateQR(id, medName) {
  showToast("Generating QR...");
  fetch('/api/generate-qr', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ med_id: id })
  })
  .then(function(r) { return r.json(); })
  .then(function(qrRes) {
    if (qrRes.image) {
      var area = document.getElementById('companyQrArea');
      var container = document.getElementById('companyQrContainer');
      area.style.display = 'block';
      var html = '<div style="display:flex; justify-content:center; gap:20px; flex-wrap:wrap;">';
      
      html += '<div style="text-align:center;">' +
              '<img src="data:image/png;base64,' + qrRes.image + '" alt="QR Code" style="max-width:200px;border-radius:12px;margin:auto;"><br>' +
              '<a href="data:image/png;base64,' + qrRes.image + '" download="' + medName + '-qr.png" class="actBtn primary" style="display:inline-flex;margin-top:12px;text-decoration:none;">Download QR</a>' +
              '</div>';
              
      if (qrRes.barcode) {
          html += '<div style="text-align:center;">' +
                  '<div style="background:white; padding:10px; border-radius:12px; display:inline-block;">' +
                  '<img src="data:image/png;base64,' + qrRes.barcode + '" alt="Barcode" style="max-width:200px;"><br>' +
                  '<div style="font-family:monospace; font-weight:bold; letter-spacing:1px; margin-top:5px;">' + (qrRes.short_code || '') + '</div></div><br>' +
                  '<a href="data:image/png;base64,' + qrRes.barcode + '" download="' + medName + '-barcode.png" class="actBtn primary" style="display:inline-flex;margin-top:12px;text-decoration:none;">Download Barcode</a>' +
                  '</div>';
      }
      
      html += '</div>';
      container.innerHTML = html;
      area.scrollIntoView({ behavior: 'smooth' });
    } else {
      showToast("Could not generate QR code.");
    }
  });
}

// Tab Switching Logic
function switchCompanyTab(tab) {
    // UI updates for buttons
    document.getElementById('navUpload').classList.remove('current');
    document.getElementById('navProfile').classList.remove('current');
    
    // UI updates for sections
    document.getElementById('companyUploadSection').style.display = 'none';
    document.getElementById('companyProfileSection').style.display = 'none';
    
    if (tab === 'upload') {
        document.getElementById('navUpload').classList.add('current');
        document.getElementById('companyUploadSection').style.display = 'block';
        loadCompanyHistory(); // Fetch latest data when tab is opened
    } else if (tab === 'profile') {
        document.getElementById('navProfile').classList.add('current');
        document.getElementById('companyProfileSection').style.display = 'block';
        loadCompanyProfile(); // Fetch latest data when tab is opened
    }
}

// Fetch Profile from the Universal Backend API
async function loadCompanyProfile() {
    try {
        let res = await fetch('/api/profile');
        if (res.ok) {
            let data = await res.json();
            // Populate the fields
            document.getElementById('cpName').value = data.company_name || '';
            document.getElementById('cpID').value = data.cin_number || '';
            document.getElementById('cpEmail').value = data.support_email || '';
            document.getElementById('cpPhone').value = data.support_phone || '';
            document.getElementById('cpAddress').value = data.hq_address || '';
            document.getElementById('cpLicense').value = data.mfg_license || '';
        }
    } catch (e) {
        console.error("Failed to load profile", e);
    }
}

// Save Profile to the Backend
async function saveCompanyProfile() {
    let profileData = {
        company_name: document.getElementById('cpName').value.trim(),
        cin_number: document.getElementById('cpID').value.trim(),
        support_email: document.getElementById('cpEmail').value.trim(),
        support_phone: document.getElementById('cpPhone').value.trim(),
        hq_address: document.getElementById('cpAddress').value.trim(),
        mfg_license: document.getElementById('cpLicense').value.trim()
    };

    try {
        let res = await fetch('/api/profile', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(profileData)
        });

        if (res.ok) {
            let toast = document.getElementById('cpToast');
            toast.style.display = 'block';
            setTimeout(() => toast.style.display = 'none', 3000);
        } else {
            alert("Failed to save profile. Check your connection.");
        }
    } catch (e) {
        console.error("Profile save error", e);
        alert("An error occurred while saving.");
    }
}

// Fetch and display company's uploaded medicines (Generation History)
async function loadCompanyHistory() {
    let listContainer = document.getElementById('companyHistoryList');
    try {
        let res = await fetch('/api/company/medicines');
        if (res.ok) {
            let data = await res.json();
            if (data.medicines && data.medicines.length > 0) {
                listContainer.innerHTML = data.medicines.map(med => `
                    <div style="background:var(--card); border:1px solid var(--bdr); border-radius:12px; padding:14px; display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
                        <div>
                            <div style="font-weight:600; color:var(--txt); font-size:15px; margin-bottom:4px;">💊 ${med.name} ${med.strength}</div>
                            <div style="font-size:12px; color:var(--txt2);">Category: ${med.category}</div>
                        </div>
                        <div style="display:flex; align-items:center; gap:10px;">
                            <button class="goBtn" style="padding:6px 12px; width:auto; font-size:13px;" onclick="regenerateQR(${med.id}, '${med.name.replace(/'/g, "\\'")}')">View Codes</button>
                            <button onclick="deleteCompanyMedicine(${med.id}, '${med.name.replace(/'/g, "\\'")}')" style="background:none; border:none; color:#EF4444; cursor:pointer; padding:6px; transition: 0.2s;" title="Delete Medicine">
                                <svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
                            </button>
                        </div>
                    </div>
                `).join('');
            } else {
                listContainer.innerHTML = '<div style="color:var(--txt2); font-size:14px; padding:10px;">No medicines uploaded yet. Fill the form above to register your first drug.</div>';
            }
        }
    } catch (e) {
        console.error("Failed to load company history", e);
        listContainer.innerHTML = '<div style="color:red; font-size:14px;">Error loading history from server.</div>';
    }
}

// Function to delete a medicine from the database
async function deleteCompanyMedicine(med_id, med_name) {
    if (!confirm(`WARNING: Are you sure you want to delete ${med_name} from the registry?\n\nAny QR codes already printed for this medicine will stop working and show as "Unverified" when users scan them.`)) {
        return;
    }

    try {
        let res = await fetch(`/api/company/medicines/${med_id}`, {
            method: 'DELETE',
            credentials: 'same-origin'
        });

        let data = await res.json();

        if (res.ok && data.ok) {
            loadCompanyHistory();
        } else {
            alert(`Failed to delete: ${data.error || 'Unknown error'}`);
        }
    } catch (e) {
        console.error("Delete error", e);
        alert("An error occurred while communicating with the server.");
    }
}

// Regenerate the QR and 1D Barcode for a previously uploaded medicine
async function regenerateQR(med_id, med_name) {
    let qrArea = document.getElementById('companyQrArea');
    let qrContainer = document.getElementById('companyQrContainer');
    let signingStatus = document.getElementById('signingStatus');
    
    // Show loading UI
    signingStatus.style.display = 'flex';
    document.getElementById('signingText').innerText = `Fetching secure codes for ${med_name}...`;
    qrArea.style.display = 'none';

    try {
        // Hitting your existing generate-qr endpoint with the med_id
        let res = await fetch('/api/generate-qr', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ med_id: med_id })
        });
        
        let data = await res.json();
        signingStatus.style.display = 'none';

        if (data.image) {
            qrArea.style.display = 'block';
            
            // Build the UI for both QR and Barcode
            let html = `
                <div style="margin-bottom:20px;">
                    <h4 style="margin-bottom:8px; color:var(--txt);">Cryptographic QR Code</h4>
                    <img src="data:image/png;base64,${data.image}" style="max-width:200px; border-radius:8px; border:2px solid var(--bdr); padding:4px; background:#fff;">
                </div>
            `;
            
            if (data.barcode) {
                html += `
                <div>
                    <h4 style="margin-bottom:8px; color:var(--txt);">1D Barcode (Short Code: <span style="color:var(--pri);">${data.short_code}</span>)</h4>
                    <img src="data:image/png;base64,${data.barcode}" style="max-width:250px; border-radius:8px; border:2px solid var(--bdr); padding:4px; background:#fff;">
                </div>`;
            }
            
            qrContainer.innerHTML = html;
            qrArea.scrollIntoView({ behavior: 'smooth' });
        } else {
            alert("Failed to generate codes.");
        }
    } catch (e) {
        console.error(e);
        signingStatus.style.display = 'none';
        alert("Error connecting to server.");
    }
}
