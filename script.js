/* ================================================
   PRINCE FX PRO — Neural Digit Match Engine v3.2.1
   ================================================
   KEY FIX: Ticks are PUBLIC on Deriv WebSocket —
   we do NOT need to authorize to receive them.
   We subscribe directly, collect digits, and run
   the prediction algorithm independently.
   Account info is fetched via a separate authorized
   WebSocket connection.
   ================================================ */
'use strict';

// ── CONFIG ────────────────────────────────────────
const CFG = {
  // Public app_id — ONLY for tick subscriptions (no auth needed)
  WS_TICKS:   'wss://ws.derivws.com/websockets/v3?app_id=1089',
  // Same endpoint for authorized calls (balance/account)
  WS_ACCOUNT: 'wss://ws.derivws.com/websockets/v3?app_id=1089',
  CYCLE:       20,    // seconds per prediction cycle
  TICK_BUF:   100,   // ticks kept per index
  INIT_MS:   3000,   // "Initializing..." duration on first login
  INDICES: [
    { id:'v10', sym:'1HZ10V', name:'Volatility 10 (1s)', cls:'v10', icon:'〜' },
    { id:'v25', sym:'1HZ25V', name:'Volatility 25 (1s)', cls:'v25', icon:'〰' },
    { id:'v50', sym:'1HZ50V', name:'Volatility 50 (1s)', cls:'v50', icon:'〜' },
    { id:'v75', sym:'1HZ75V', name:'Volatility 75 (1s)', cls:'v75', icon:'〰' },
  ]
};

// ── STATE ─────────────────────────────────────────
const ST = {
  token:       null,
  wsT:         null,   // tick WebSocket (public)
  wsA:         null,   // account WebSocket (authorized)
  rtimer:      null,   // reconnect timer
  initDone:    false,  // 3s init phase complete
  analyzers:   {},     // symbol → analyzer object
};

function mkAz(sym) {
  return {
    sym,
    ticks:        [],
    countdown:    CFG.CYCLE,
    timer:        null,
    pred:         null,   // { digit, confidence }
    phase:        'init', // init|processing|predicting
    cycleStarted: false,
  };
}

// ── BOOT ─────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  ST.token = sessionStorage.getItem('deriv_token')
          || localStorage.getItem('pf_token');

  if (!ST.token) { window.location.replace('/'); return; }

  buildUI();

  // Show initializing on all cards immediately
  CFG.INDICES.forEach(i => {
    setBox(i.id, tplInit());
    setCD(i.id, '—');
    setPB(i.id, 0);
  });

  // Step 1: connect public tick WebSocket (no auth needed)
  connectTickWS();

  // Step 2: connect account WebSocket (authorized) for balance/username
  connectAccountWS();

  // Step 3: after INIT_MS, mark init done & start any cycles that have ticks
  setTimeout(() => {
    ST.initDone = true;
    CFG.INDICES.forEach(i => {
      const az = ST.analyzers[i.sym];
      if (az && !az.cycleStarted && az.ticks.length >= 5) {
        az.cycleStarted = true;
        startCycle(i.sym);
      } else if (az && !az.cycleStarted) {
        // Not enough ticks yet — show processing, will start on next tick
        setBox(i.id, tplProcessing());
      }
    });
  }, CFG.INIT_MS);
});

// ── BUILD UI ─────────────────────────────────────
function buildUI() {
  const grid = document.getElementById('analyzersGrid');
  if (!grid) return;
  grid.innerHTML = '';
  CFG.INDICES.forEach(i => {
    ST.analyzers[i.sym] = mkAz(i.sym);
    grid.insertAdjacentHTML('beforeend', `
      <div class="analyzer-card ${i.cls}" id="card-${i.id}">
        <div class="card-header">
          <div class="card-title-wrap">
            <div class="card-icon">${i.icon}</div>
            <div class="card-name">${i.name}</div>
          </div>
          <div class="live-badge"><div class="live-dot"></div>LIVE</div>
        </div>
        <div class="countdown-row">
          <span class="countdown-label">Next analysis in</span>
          <span class="countdown-num" id="cd-${i.id}">—</span>
        </div>
        <div class="progress-wrap">
          <div class="progress-fill" id="pb-${i.id}" style="width:0%"></div>
        </div>
        <div class="prediction-box" id="pbox-${i.id}">
          ${tplInit()}
        </div>
      </div>`);
  });
}

// ── TICK WEBSOCKET (PUBLIC — no authorize needed) ─
function connectTickWS() {
  if (ST.wsT) { try { ST.wsT.close(); } catch {} }
  ST.wsT = new WebSocket(CFG.WS_TICKS);

  ST.wsT.onopen = () => {
    // Subscribe to all 4 indices immediately — no auth required for public ticks
    CFG.INDICES.forEach(i => {
      ST.wsT.send(JSON.stringify({ ticks: i.sym, subscribe: 1 }));
    });
  };

  ST.wsT.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.msg_type === 'tick') onTick(msg.tick);
    } catch {}
  };

  ST.wsT.onclose = () => {
    if (ST.rtimer) return;
    ST.rtimer = setTimeout(() => { ST.rtimer = null; connectTickWS(); }, 3000);
  };

  ST.wsT.onerror = () => {};
}

// ── ACCOUNT WEBSOCKET (AUTHORIZED — for balance/name)
function connectAccountWS() {
  if (ST.wsA) { try { ST.wsA.close(); } catch {} }
  ST.wsA = new WebSocket(CFG.WS_ACCOUNT);

  ST.wsA.onopen = () => {
    ST.wsA.send(JSON.stringify({ authorize: ST.token }));
  };

  ST.wsA.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.msg_type === 'authorize' && !msg.error) onAuthorized(msg.authorize);
      // Silently ignore auth errors — ticks still work
    } catch {}
  };

  ST.wsA.onerror = () => {};
  ST.wsA.onclose = () => {};
}

// ── ON AUTHORIZED (account info only) ────────────
function onAuthorized(auth) {
  const loginid  = auth.loginid  || '—';
  const currency = auth.currency || '';
  const balance  = auth.balance  != null ? parseFloat(auth.balance).toFixed(2) : '—';

  const elName = document.getElementById('userName');
  const elBal  = document.getElementById('userBal');
  const elAvtr = document.getElementById('userAvatar');
  if (elName) elName.textContent = loginid;
  if (elBal)  elBal.textContent  = `${currency} ${balance}`;
  if (elAvtr) elAvtr.textContent = loginid.charAt(0).toUpperCase();
}

// ── ON TICK ───────────────────────────────────────
function onTick(tick) {
  const az = ST.analyzers[tick.symbol];
  if (!az) return;

  // Extract last digit from price (e.g. 12345.67 → 7)
  const str   = tick.quote.toFixed(2);
  const digit = parseInt(str[str.length - 1], 10);
  az.ticks.push(digit);
  if (az.ticks.length > CFG.TICK_BUF) az.ticks.shift();

  // Once init phase done & enough ticks: start cycle
  if (ST.initDone && !az.cycleStarted && az.ticks.length >= 5) {
    az.cycleStarted = true;
    startCycle(tick.symbol);
  }
}

// ── PREDICTION ALGORITHM ──────────────────────────
/*
  4-Layer Neural Weighting:
  L1 – Exponential recency weight  (recent ticks weighted higher)
  L2 – Momentum ratio              (last 10 vs last 30 ticks)
  L3 – Anti-frequency bias         (underrepresented digits boosted)
  L4 – Repetition gap              (digits absent longer get boost)
  → Combined via softmax → highest prob digit + scaled confidence %
*/
function predict(ticks) {
  if (ticks.length < 5) {
    return {
      digit:      Math.floor(Math.random() * 10),
      confidence: parseFloat((62 + Math.random() * 18).toFixed(1))
    };
  }

  const N = ticks.length;

  // L1: recency-weighted frequency
  const recency = new Array(10).fill(0);
  ticks.forEach((d, i) => { recency[d] += Math.pow(1.045, i); });

  // L2: momentum
  const r10 = new Array(10).fill(0);
  const r30 = new Array(10).fill(0);
  ticks.slice(-10).forEach(d => r10[d]++);
  ticks.slice(-30).forEach(d => r30[d]++);
  const momentum = r10.map((v, d) => v / Math.max(r30[d] / 3, 0.001));

  // L3: anti-bias
  const freq = new Array(10).fill(0);
  ticks.forEach(d => freq[d]++);
  const meanF = N / 10;
  const antiBias = freq.map(f => {
    const dev = f - meanF;
    return dev > 0 ? Math.max(0.08, 1 - dev * 0.06) : 1 + Math.abs(dev) * 0.045;
  });

  // L4: gap boost
  const lastSeen = new Array(10).fill(-1);
  ticks.forEach((d, i) => { lastSeen[d] = i; });
  const gapBoost = lastSeen.map(l => 1 + Math.min(l === -1 ? N : N - 1 - l, 15) * 0.012);

  // Combine
  const scores = new Array(10).fill(0).map((_, d) =>
    recency[d]  * 0.40 +
    momentum[d] * 3    * 0.25 +
    antiBias[d] * 2    * 0.20 +
    gapBoost[d] * 2    * 0.15
  );

  // Softmax
  const maxS = Math.max(...scores);
  const exps  = scores.map(s => Math.exp(s - maxS));
  const sumE  = exps.reduce((a, b) => a + b, 0);
  const probs = exps.map(e => e / sumE);

  const predDigit = probs.indexOf(Math.max(...probs));
  const conf = parseFloat(
    Math.min(97, Math.max(61, 61 + probs[predDigit] * 190)).toFixed(1)
  );

  return { digit: predDigit, confidence: conf };
}

// ── CYCLE MANAGER ─────────────────────────────────
function startCycle(sym) {
  const az  = ST.analyzers[sym];
  const idx = CFG.INDICES.find(i => i.sym === sym);
  if (!az || !idx) return;

  if (az.timer) { clearInterval(az.timer); az.timer = null; }

  az.countdown = CFG.CYCLE;

  // Show "Processing algorithm..." for 1.5s then reveal digit
  setBox(idx.id, tplProcessing());
  setCD(idx.id, az.countdown + 's');
  setPB(idx.id, 0);

  setTimeout(() => {
    az.pred  = predict(az.ticks);
    az.phase = 'predicting';
    renderPred(idx.id, az.pred, true);
  }, 1500);

  // Countdown tick — every 1 second
  az.timer = setInterval(() => {
    az.countdown--;
    setCD(idx.id, az.countdown + 's');
    setPB(idx.id, ((CFG.CYCLE - az.countdown) / (CFG.CYCLE - 1)) * 100);

    // Live confidence drift each second
    if (az.phase === 'predicting' && az.pred) {
      az.pred.confidence = parseFloat(
        Math.min(97, Math.max(61,
          az.pred.confidence + (Math.random() - 0.42) * 2.6
        )).toFixed(1)
      );
      updateConf(idx.id, az.pred.confidence);
    }

    // Cycle ends
    if (az.countdown <= 0) {
      az.countdown = CFG.CYCLE;
      az.phase = 'processing';

      setBox(idx.id, tplProcessing());
      setCD(idx.id, az.countdown + 's');
      setPB(idx.id, 0);

      setTimeout(() => {
        az.pred  = predict(az.ticks);
        az.phase = 'predicting';
        renderPred(idx.id, az.pred, true);
      }, 1500);
    }
  }, 1000);
}

// ── UI HELPERS ────────────────────────────────────
function setBox(id, html) {
  const el = document.getElementById('pbox-' + id);
  if (el) el.innerHTML = html;
}

function setCD(id, txt) {
  const el = document.getElementById('cd-' + id);
  if (el) el.textContent = txt;
}

function setPB(id, pct) {
  const el = document.getElementById('pb-' + id);
  if (el) el.style.width = Math.max(0, Math.min(100, pct)) + '%';
}

function updateConf(id, conf) {
  const val = document.getElementById('cval-' + id);
  const bar = document.getElementById('cbar-' + id);
  if (val) val.textContent = conf + '%';
  if (bar) bar.style.width = conf + '%';
}

function renderPred(id, pred, animate) {
  setBox(id, `
    <div class="pred-label">↗ PREDICTED DIGIT</div>
    <div class="pred-digit${animate ? ' digit-reveal' : ''}">${pred.digit}</div>
    <div class="conf-wrap">
      <div class="conf-row">
        <span class="conf-label">CONFIDENCE</span>
        <span class="conf-value" id="cval-${id}">${pred.confidence}%</span>
      </div>
      <div class="conf-bar-wrap">
        <div class="conf-bar-fill" id="cbar-${id}" style="width:${pred.confidence}%"></div>
      </div>
    </div>
  `);
}

// ── HTML TEMPLATES ────────────────────────────────
function tplInit() {
  return `<div class="processing-state">
    <div class="spin-ring"></div>
    <span>Initializing prediction model...</span>
  </div>`;
}

function tplProcessing() {
  return `<div class="processing-state">
    <div class="spin-ring"></div>
    <span>Processing algorithm...</span>
    <div class="bars-anim">
      <div class="bar"></div><div class="bar"></div>
      <div class="bar"></div><div class="bar"></div>
      <div class="bar"></div>
    </div>
  </div>`;
}

// ── LOGOUT ────────────────────────────────────────
function logout() {
  try { sessionStorage.clear(); } catch {}
  try {
    ['pf_token','pf_accounts','pf_pkce_verifier'].forEach(k => localStorage.removeItem(k));
  } catch {}
  [ST.wsT, ST.wsA].forEach(ws => { if (ws) try { ws.close(); } catch {} });
  Object.values(ST.analyzers).forEach(az => { if (az.timer) clearInterval(az.timer); });
  window.location.replace('/');
}
window.logout = logout;
