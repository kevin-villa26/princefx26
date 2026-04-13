# 👑 Prince FX PRO — Digit Match Predictor

**Professional AI-powered Volatility Index Analysis Tool for Deriv**  
Built by Kevin Villamar · Neural Engine v3.2.1

---

## 🚀 Deployment (Netlify)

### 1. Push to GitHub
```bash
git init
git add .
git commit -m "Prince FX PRO v3.2.1"
git remote add origin https://github.com/YOUR_USERNAME/princefx.git
git push -u origin main
```

### 2. Deploy on Netlify
1. Go to [netlify.com](https://netlify.com) → **Add new site** → **Import from Git**
2. Select your GitHub repo
3. Build settings: leave blank (static site)
4. Click **Deploy**
5. Set custom domain or use the given Netlify URL (e.g., `princefx26.netlify.app`)

### 3. Verify Deriv App Settings
Your app in [developers.deriv.com](https://developers.deriv.com):
- **App ID:** `32P7P7Js60xbi0ISjpAyK`
- **Redirect URL:** `https://princefx26.netlify.app/callback`
- **Scopes:** `trade`, `account_management`

---

## 📁 File Structure

```
princefx/
├── index.html                    # Login page (PKCE OAuth)
├── callback.html                 # OAuth callback handler
├── dashboard.html                # Main analysis dashboard
├── style.css                     # Professional trading UI styles
├── script.js                     # Prediction engine + WebSocket
├── netlify.toml                  # Routing + security headers
├── package.json
└── netlify/
    └── functions/
        └── exchange-token.js     # Backend: OAuth code → token exchange
```

---

## ⚙️ How It Works

### OAuth 2.0 + PKCE Flow
1. User clicks **Login with Deriv**
2. PKCE verifier + challenge generated client-side
3. Redirect to `oauth.deriv.com` for authorization
4. User logs in → redirected to `/callback`
5. `callback.html` sends code to `/.netlify/functions/exchange-token`
6. Netlify Function exchanges code for access token (no CORS issues)
7. Token stored in `sessionStorage`
8. Dashboard loads and connects to Deriv WebSocket

### Prediction Algorithm
- Collects **last 100 ticks** per volatility index
- Runs **neural-network-style weighted probability analysis**:
  - Exponential recency weighting
  - Momentum analysis (last 10 vs last 30 ticks)
  - Anti-frequency bias correction
  - Softmax probability distribution
- Outputs: **predicted digit (0–9)** + **confidence % (60–97%)**

### Countdown Cycle
- **20s** → Processing / New prediction revealed
- **19s → 1s** → Display predicted digit (confidence updates each second)
- **0s** → "Processing algorithm..." for 1.5s → New prediction

### First Login
- Shows "Initializing prediction model..." for **3 seconds** across all cards
- Then all four analyzers begin their live cycles simultaneously

---

## 📊 Supported Indices

| Symbol | Name | Color |
|--------|------|-------|
| 1HZ10V | Volatility 10 (1s) | 🔵 Blue |
| 1HZ25V | Volatility 25 (1s) | 🟡 Amber |
| 1HZ50V | Volatility 50 (1s) | 🟢 Green |
| 1HZ75V | Volatility 75 (1s) | 🔴 Red |

---

## 🛡️ Security

- PKCE prevents code interception attacks
- Token exchange runs **server-side** (Netlify Functions)
- Token stored in `sessionStorage` (cleared on tab close)
- CSP headers block unauthorized domains
- No API keys in client-side code

---

## 📱 Mobile Responsive
Fully responsive for desktop, tablet, and mobile.

---

*Prince FX PRO v3.2.1 — © Kevin Villamar*
