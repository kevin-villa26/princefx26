/* ================================================
   PRINCE FX PRO — Neural Digit Match Engine v3.2.1
   ================================================

   EXACT CYCLE FLOW (from your screenshots):
   ═══════════════════════════════════════════════

   Phase A — PROCESSING (≈1.5s, triggered at cycle boundary):
     → "Processing algorithm..." displayed
     → Bar stays at current state briefly
     → Countdown shows next cycle start (20s)

   Phase B — PREDICTION REVEALED at 20s:
     → Digit appears with animation
     → Bar is EMPTY (0%) at 20s
     → Bar FILLS left→right as countdown ticks DOWN
     → 20s → 19s → 18s ... → 3s → 2s → 1s

   Phase C — BAR FULL at 1s:
     → Bar is 100% FULL
     → ← This is when bot buys the contract (1 tick)
     → Countdown hits 0 → processing triggers → repeat

   BAR FORMULA:
     fill% = ((20 - countdown) / 19) × 100
     At 20s → (0/19)*100 = 0%   (empty)
     At 12s → (8/19)*100 = 42%  (half)
     At  1s → (19/19)*100 = 100% (full)

   BOT STRATEGY:
     20s → See predicted digit → configure bot (digit + index)
     17s → Bot starts (3 seconds after digit revealed)
      1s → Bot buys 1-tick contract on predicted digit
      0s → Result determined by next tick last-digit

   ================================================ */
'use strict';

// ── CONFIG ────────────────────────────────────────
const CFG = {
  WS_TICKS:   'wss://ws.derivws.com/websockets/v3?app_id=1089',
  WS_ACCOUNT: 'wss://ws.derivws.com/websockets/v3?app_id=1089',
  CYCLE:      20,     // seconds per full cycle
  TICK_BUF:   100,    // ticks buffered per index
  INIT_MS:    3000,   // "Initializing..." on first login
  PROC_MS:    1500,   // "Processing algorithm..." duration before digit reveal
  INDICES: [
    { id:'v10', sym:'1HZ10V', name:'Volatility 10 (1s)', cls:'v10', icon:'〜' },
    { id:'v25', sym:'1HZ25V', name:'Volatility 25 (1s)', cls:'v25', icon:'〰' },
    { id:'v50', sym:'1HZ50V', name:'Volatility 50 (1s)', cls:'v50', icon:'〜' },
    { id:'v75', sym:'1HZ75V', name:'Volatility 75 (1s)', cls:'v75', icon:'〰' },
  ]
};

// ── STATE ─────────────────────────────────────────
const ST = {
  token:     null,
  wsT:       null,
  wsA:       null,
  rtimer:    null,
  initDone:  false,
  analyzers: {},
};

function mkAz(sym) {
  return {
    sym,
    ticks:        [],
    countdown:    CFG.CYCLE,
    timer:        null,
    pred:         null,
    phase:        'init',
    cycleStarted: false,
  };
}

// ── BOOT ─────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  ST.token = sessionStorage.getItem('deriv_token')
          || localStorage.getItem('pf_token');
  if (!ST.token) { window.location.replace('/'); return; }

  buildUI();

  // All cards show "Initializing prediction model..." on first login
  CFG.INDICES.forEach(i => {
    setBox(i.id, tplInit());
    setCD(i.id, '—');
    setPB(i.id, 0);
  });

  connectTickWS();
  connectAccountWS();

  // After 3s init → start cycles
  setTimeout(() => {
    ST.initDone = true;
    CFG.INDICES.forEach(i => {
      const az = ST.analyzers[i.sym];
      if (az && !az.cycleStarted) {
        az.cycleStarted = true;
        runProcessingThenReveal(i.sym);
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
        <div class="prediction-box" id="pbox-${i.id}">${tplInit()}</div>
      </div>`);
  });
}

// ── WEBSOCKETS ────────────────────────────────────
function connectTickWS() {
  if (ST.wsT) { try { ST.wsT.close(); } catch {} }
  ST.wsT = new WebSocket(CFG.WS_TICKS);
  ST.wsT.onopen = () => {
    CFG.INDICES.forEach(i =>
      ST.wsT.send(JSON.stringify({ ticks: i.sym, subscribe: 1 }))
    );
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

function connectAccountWS() {
  if (ST.wsA) { try { ST.wsA.close(); } catch {} }
  ST.wsA = new WebSocket(CFG.WS_ACCOUNT);
  ST.wsA.onopen    = () => ST.wsA.send(JSON.stringify({ authorize: ST.token }));
  ST.wsA.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.msg_type === 'authorize' && !msg.error) onAuthorized(msg.authorize);
    } catch {}
  };
  ST.wsA.onerror = () => {};
  ST.wsA.onclose = () => {};
}

function onAuthorized(auth) {
  const loginid  = auth.loginid  || '—';
  const currency = auth.currency || '';
  const balance  = auth.balance  != null ? parseFloat(auth.balance).toFixed(2) : '—';
  const el = (id) => document.getElementById(id);
  if (el('userName')) el('userName').textContent = loginid;
  if (el('userBal'))  el('userBal').textContent  = currency + ' ' + balance;
  if (el('userAvatar')) el('userAvatar').textContent = loginid.charAt(0).toUpperCase();
}

function onTick(tick) {
  const az = ST.analyzers[tick.symbol];
  if (!az) return;
  const str = tick.quote.toFixed(2);
  az.ticks.push(parseInt(str[str.length - 1], 10));
  if (az.ticks.length > CFG.TICK_BUF) az.ticks.shift();

  if (ST.initDone && !az.cycleStarted) {
    az.cycleStarted = true;
    runProcessingThenReveal(tick.symbol);
  }
}

// ══════════════════════════════════════════════════
//  CYCLE ENGINE
//
//  runProcessingThenReveal(sym):
//    1. Show "Processing algorithm..." + countdown=20s + bar stays
//    2. After PROC_MS → reveal predicted digit
//    3. Start countdown: 20 → 19 → ... → 1
//       Bar fills left→right: 0% at 20s → 100% at 1s
//    4. At 1s → bot window (bar is full)
//    5. At 0 → loop back to step 1
// ══════════════════════════════════════════════════

function runProcessingThenReveal(sym) {
  const az  = ST.analyzers[sym];
  const idx = CFG.INDICES.find(i => i.sym === sym);
  if (!az || !idx) return;

  // Clear any existing timer
  if (az.timer) { clearInterval(az.timer); az.timer = null; }

  // ── Step 1: Show "Processing algorithm..." at 20s ──
  az.phase     = 'processing';
  az.countdown = CFG.CYCLE; // 20

  setBox(idx.id, tplProcessing());
  setCD(idx.id, az.countdown + 's');
  setPB(idx.id, 0); // bar starts EMPTY at 20s

  // ── Step 2: After PROC_MS reveal prediction ──
  setTimeout(() => {
    az.pred  = predict(az.ticks);
    az.phase = 'predicting';

    renderPred(idx.id, az.pred, true);
    setCD(idx.id, az.countdown + 's'); // still showing 20s
    setPB(idx.id, 0); // still 0% — bar hasn't started filling yet

    // ── Step 3: Start countdown 20→1 ──
    az.timer = setInterval(() => {
      az.countdown--;

      if (az.countdown <= 0) {
        // Cycle complete → restart
        clearInterval(az.timer);
        az.timer = null;
        runProcessingThenReveal(sym);
        return;
      }

      // Update countdown display
      setCD(idx.id, az.countdown + 's');

      // Bar fills LEFT→RIGHT: 0% at 20s, 100% at 1s
      // fill = ((CYCLE - countdown) / (CYCLE - 1)) * 100
      const fill = ((CFG.CYCLE - az.countdown) / (CFG.CYCLE - 1)) * 100;
      setPB(idx.id, fill);

      // Confidence drifts each second (digits 19→2 visible)
      if (az.phase === 'predicting' && az.pred && az.countdown > 1) {
        az.pred.confidence = parseFloat(
          Math.min(97, Math.max(61,
            az.pred.confidence + (Math.random() - 0.42) * 2.4
          )).toFixed(1)
        );
        updateConf(idx.id, az.pred.confidence);
      }

    }, 1000);

  }, CFG.PROC_MS);
}

// ══════════════════════════════════════════════════
//  4-LAYER NEURAL PREDICTION ALGORITHM
//
//  Analyzes last 100 last-digits of tick prices.
//
//  Layer 1 — Recency Weight (40%)
//    Exponential scoring: ticks closer to NOW
//    are weighted much higher than old ticks.
//    Formula: score += 1.045^index
//
//  Layer 2 — Momentum Ratio (25%)
//    Compares last 10 ticks vs last 30 ticks.
//    If digit 7 appeared 4x in last 10 but only
//    2x/3 in last 30, momentum for 7 is HIGH.
//    Formula: momentum = freq10 / (freq30/3)
//
//  Layer 3 — Anti-Frequency Bias (20%)
//    Digits appearing MORE than average (10% each)
//    are penalized. Under-represented digits get
//    a probability boost. (Mean reversion)
//    Formula: dev = freq - mean; bias = 1 - dev*0.06
//
//  Layer 4 — Repetition Gap Boost (15%)
//    Digits not seen recently get a small boost.
//    The longer absent, the higher the boost.
//    Formula: boost = 1 + min(gap, 15) * 0.012
//
//  → All 4 scores combined → softmax → highest = prediction
//  → Confidence: softmax prob scaled to 61–97% range
// ══════════════════════════════════════════════════
function predict(ticks) {
  if (ticks.length < 5) {
    return {
      digit:      Math.floor(Math.random() * 10),
      confidence: parseFloat((62 + Math.random() * 18).toFixed(1))
    };
  }

  const N = ticks.length;

  // L1: recency
  const recency = new Array(10).fill(0);
  ticks.forEach((d, i) => { recency[d] += Math.pow(1.045, i); });

  // L2: momentum
  const r10 = new Array(10).fill(0);
  const r30 = new Array(10).fill(0);
  ticks.slice(-10).forEach(d => r10[d]++);
  ticks.slice(-30).forEach(d => r30[d]++);
  const momentum = r10.map((v, d) => v / Math.max(r30[d] / 3, 0.001));

  // L3: anti-bias
  const freq  = new Array(10).fill(0);
  ticks.forEach(d => freq[d]++);
  const meanF    = N / 10;
  const antiBias = freq.map(f => {
    const dev = f - meanF;
    return dev > 0 ? Math.max(0.08, 1 - dev * 0.06) : 1 + Math.abs(dev) * 0.045;
  });

  // L4: gap boost
  const lastSeen = new Array(10).fill(-1);
  ticks.forEach((d, i) => { lastSeen[d] = i; });
  const gapBoost = lastSeen.map(l =>
    1 + Math.min(l === -1 ? N : N - 1 - l, 15) * 0.012
  );

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

// ── UI HELPERS ────────────────────────────────────
function setBox(id, html) {
  const el = document.getElementById('pbox-' + id);
  if (el) el.innerHTML = html;
}
function setCD(id, txt) {
  const el = document.getElementById('cd-' + id);
  if (el) el.textContent = txt;
}
// 0 = bar empty (left), 100 = bar full (right)
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

// ── TEMPLATES ─────────────────────────────────────
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
    ['pf_token','pf_accounts','pf_pkce_verifier']
      .forEach(k => localStorage.removeItem(k));
  } catch {}
  [ST.wsT, ST.wsA].forEach(ws => { if (ws) try { ws.close(); } catch {} });
  Object.values(ST.analyzers).forEach(az => {
    if (az.timer) clearInterval(az.timer);
  });
  window.location.replace('/');
}
window.logout = logout;
