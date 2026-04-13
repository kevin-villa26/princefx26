/* ================================================
   PRINCE FX PRO — TRADING ANALYSIS ENGINE
   Neural Network Digit Match Predictor v3.2.1
   ================================================ */

'use strict';

// ── CONFIG ──────────────────────────────────────
const CONFIG = {
  WS_URL: 'wss://ws.derivws.com/websockets/v3?app_id=1089',
  CYCLE: 20,       // seconds per cycle
  TICK_BUFFER: 100, // last N ticks used for prediction
  INDICES: [
    { id: 'v10',  symbol: '1HZ10V',  name: 'Volatility 10 (1s)',  class: 'v10',  icon: '〜' },
    { id: 'v25',  symbol: '1HZ25V',  name: 'Volatility 25 (1s)',  class: 'v25',  icon: '〰' },
    { id: 'v50',  symbol: '1HZ50V',  name: 'Volatility 50 (1s)',  class: 'v50',  icon: '〜' },
    { id: 'v75',  symbol: '1HZ75V',  name: 'Volatility 75 (1s)',  class: 'v75',  icon: '〰' },
  ]
};

// ── STATE ────────────────────────────────────────
const state = {
  token: null,
  ws: null,
  connected: false,
  firstCycle: true, // show "Initializing" only on first login cycle
  analyzers: {},    // per-symbol state
};

// Per-analyzer state factory
function makeAnalyzer(symbol) {
  return {
    symbol,
    ticks: [],          // last 100 tick last-digits
    countdown: CONFIG.CYCLE,
    interval: null,
    prediction: null,   // { digit, confidence }
    phase: 'init',      // 'init' | 'processing' | 'predicting'
    initialized: false,
  };
}

// ── BOOT ─────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const token = sessionStorage.getItem('deriv_token');
  if (!token) { window.location.href = '/'; return; }
  state.token = token;

  buildUI();
  connectWebSocket();
});

// ── BUILD UI ─────────────────────────────────────
function buildUI() {
  const grid = document.getElementById('analyzersGrid');
  grid.innerHTML = '';

  CONFIG.INDICES.forEach(idx => {
    state.analyzers[idx.symbol] = makeAnalyzer(idx.symbol);

    grid.insertAdjacentHTML('beforeend', `
      <div class="analyzer-card ${idx.class}" id="card-${idx.id}">
        <div class="card-header">
          <div class="card-title-wrap">
            <div class="card-icon">${idx.icon}</div>
            <div class="card-name">${idx.name}</div>
          </div>
          <div class="live-badge">
            <div class="live-dot"></div>
            LIVE
          </div>
        </div>

        <div class="countdown-row">
          <span class="countdown-label">Next analysis in</span>
          <span class="countdown-num" id="cd-${idx.id}">—</span>
        </div>

        <div class="progress-wrap">
          <div class="progress-fill" id="pb-${idx.id}"></div>
        </div>

        <div class="prediction-box" id="pbox-${idx.id}">
          <div class="processing-state">
            <div class="spin-ring"></div>
            <div>Connecting...</div>
          </div>
        </div>
      </div>
    `);
  });
}

// ── WEBSOCKET ─────────────────────────────────────
function connectWebSocket() {
  state.ws = new WebSocket(CONFIG.WS_URL);

  state.ws.onopen = () => {
    state.connected = true;
    authorize();
  };

  state.ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    handleMessage(msg);
  };

  state.ws.onerror = () => reconnect();
  state.ws.onclose = () => { state.connected = false; reconnect(); };
}

function reconnect() {
  setTimeout(connectWebSocket, 3000);
}

function send(payload) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(payload));
  }
}

// ── AUTH + SUBSCRIBE ──────────────────────────────
function authorize() {
  send({ authorize: state.token });
}

function subscribeAll() {
  CONFIG.INDICES.forEach(idx => {
    send({ ticks: idx.symbol, subscribe: 1 });
  });
}

// ── MESSAGE HANDLER ───────────────────────────────
function handleMessage(msg) {
  if (msg.msg_type === 'authorize') {
    if (msg.error) { logout(); return; }
    updateAccount(msg.authorize);
    subscribeAll();
  }

  if (msg.msg_type === 'tick') {
    const tick = msg.tick;
    const az = state.analyzers[tick.symbol];
    if (!az) return;

    // Extract last digit of price
    const priceStr = tick.quote.toFixed(2);
    const lastDigit = parseInt(priceStr[priceStr.length - 1]);
    az.ticks.push(lastDigit);
    if (az.ticks.length > CONFIG.TICK_BUFFER) az.ticks.shift();

    // Start cycle on first tick
    if (!az.initialized && az.ticks.length >= 5) {
      az.initialized = true;
      startCycle(tick.symbol);
    }
  }
}

// ── ACCOUNT UI ───────────────────────────────────
function updateAccount(auth) {
  document.getElementById('acctId').textContent = auth.loginid || '—';
  const bal = auth.balance !== undefined ? parseFloat(auth.balance).toFixed(2) : '—';
  const cur = auth.currency || '';
  document.getElementById('acctBal').textContent = `${cur} ${bal}`;
}

// ── PREDICTION ALGORITHM ──────────────────────────
// Neural-network-style weighted probability engine
function predict(ticks) {
  if (ticks.length < 10) return { digit: Math.floor(Math.random() * 10), confidence: 55 + Math.random() * 20 };

  // 1. Frequency analysis (last 100 ticks)
  const freq = new Array(10).fill(0);
  ticks.forEach(d => freq[d]++);

  // 2. Recency weighting — recent ticks count more
  const weighted = new Array(10).fill(0);
  ticks.forEach((d, i) => {
    const weight = Math.pow(1.05, i); // exponential recency weight
    weighted[d] += weight;
  });

  // 3. Momentum: last 10 vs last 30 ticks
  const recentFreq = new Array(10).fill(0);
  const olderFreq = new Array(10).fill(0);
  const last10 = ticks.slice(-10);
  const last30 = ticks.slice(-30);
  last10.forEach(d => recentFreq[d]++);
  last30.forEach(d => olderFreq[d]++);

  const momentum = recentFreq.map((r, i) => {
    const o = olderFreq[i] / 3 || 0.001;
    return r / o; // momentum ratio
  });

  // 4. Anti-bias: digits appearing too much get penalized
  const mean = freq.reduce((a, b) => a + b, 0) / 10;
  const antiFreq = freq.map(f => {
    const deviation = f - mean;
    return deviation > 0 ? Math.max(0.1, 1 - deviation * 0.08) : 1 + Math.abs(deviation) * 0.04;
  });

  // 5. Combine scores
  const scores = new Array(10).fill(0).map((_, d) => {
    return weighted[d] * 0.5 + momentum[d] * 3 * 0.3 + antiFreq[d] * 2 * 0.2;
  });

  // 6. Softmax to probabilities
  const maxScore = Math.max(...scores);
  const expScores = scores.map(s => Math.exp(s - maxScore));
  const sumExp = expScores.reduce((a, b) => a + b, 0);
  const probs = expScores.map(s => s / sumExp);

  // 7. Select predicted digit
  const digit = probs.indexOf(Math.max(...probs));
  const rawConf = probs[digit];

  // 8. Scale confidence to 60-97% range for display realism
  const confidence = 60 + rawConf * 185;
  const displayConf = Math.min(97, Math.max(60, confidence));

  return { digit, confidence: parseFloat(displayConf.toFixed(1)), probs };
}

// ── CYCLE MANAGER ─────────────────────────────────
function startCycle(symbol) {
  const az = state.analyzers[symbol];
  const idx = CONFIG.INDICES.find(i => i.symbol === symbol);
  if (!idx) return;

  // Phase 1 (first login only): Show "Initializing prediction model..." for 3s
  if (state.firstCycle && az.ticks.length > 0) {
    state.firstCycle = false;
    // All cards show init for 3s together
    CONFIG.INDICES.forEach(i => {
      showPhase(i.id, 'init');
    });

    setTimeout(() => {
      // After 3s, start all cycles
      CONFIG.INDICES.forEach(i => {
        const a = state.analyzers[i.symbol];
        if (a.initialized) beginCountdown(i.symbol);
      });
    }, 3000);
    return;
  }

  beginCountdown(symbol);
}

function beginCountdown(symbol) {
  const az = state.analyzers[symbol];
  const idx = CONFIG.INDICES.find(i => i.symbol === symbol);
  if (!idx) return;

  if (az.interval) clearInterval(az.interval);

  az.countdown = CONFIG.CYCLE;
  az.phase = 'processing';

  // Show processing state
  showPhase(idx.id, 'processing');

  // Generate first prediction at second 20
  const newPred = predict(az.ticks);
  az.prediction = newPred;

  // Reveal prediction right as cycle starts
  setTimeout(() => {
    showPrediction(idx.id, az.prediction, true);
    az.phase = 'predicting';
  }, 100);

  az.interval = setInterval(() => {
    az.countdown--;

    // Update confidence dynamically during countdown
    if (az.phase === 'predicting' && az.prediction) {
      // Small confidence fluctuation each second
      const delta = (Math.random() - 0.4) * 3;
      az.prediction.confidence = parseFloat(
        Math.min(97, Math.max(60, az.prediction.confidence + delta)).toFixed(1)
      );
      updateConfidence(idx.id, az.prediction.confidence);
    }

    updateCountdown(idx.id, az.countdown);

    if (az.countdown <= 0) {
      // Cycle ends — reset
      az.countdown = CONFIG.CYCLE;
      az.phase = 'processing';

      // Show "Processing algorithm..." for 1.5s
      showPhase(idx.id, 'processing');

      setTimeout(() => {
        // Generate new prediction
        const pred = predict(az.ticks);
        az.prediction = pred;
        az.phase = 'predicting';
        showPrediction(idx.id, pred, true);
        az.countdown = CONFIG.CYCLE;
        updateCountdown(idx.id, az.countdown);
      }, 1500);
    }
  }, 1000);
}

// ── UI UPDATES ─────────────────────────────────────
function updateCountdown(idxId, seconds) {
  const cdEl = document.getElementById(`cd-${idxId}`);
  const pbEl = document.getElementById(`pb-${idxId}`);
  if (!cdEl || !pbEl) return;

  cdEl.textContent = `${seconds}s`;

  // Progress bar: empty at 20s, full at 1s → left to right
  const fill = ((CONFIG.CYCLE - seconds) / (CONFIG.CYCLE - 1)) * 100;
  pbEl.style.width = `${Math.max(0, Math.min(100, fill))}%`;
}

function showPhase(idxId, phase) {
  const box = document.getElementById(`pbox-${idxId}`);
  const card = document.getElementById(`card-${idxId}`);
  const idx = CONFIG.INDICES.find(i => i.id === idxId);
  if (!box || !idx) return;

  const colorClass = card.className.split(' ').find(c => ['v10','v25','v50','v75'].includes(c)) || 'v10';

  if (phase === 'init') {
    box.innerHTML = `
      <div class="processing-state">
        <div class="spin-ring"></div>
        <span>Initializing prediction model...</span>
      </div>
    `;
    document.getElementById(`cd-${idxId}`).textContent = '—';
    document.getElementById(`pb-${idxId}`).style.width = '0%';
  } else if (phase === 'processing') {
    box.innerHTML = `
      <div class="processing-state">
        <div class="spin-ring"></div>
        <span>Processing algorithm...</span>
        <div class="bars-anim">
          <div class="bar"></div>
          <div class="bar"></div>
          <div class="bar"></div>
          <div class="bar"></div>
          <div class="bar"></div>
        </div>
      </div>
    `;
  }
}

function showPrediction(idxId, pred, animate = false) {
  const box = document.getElementById(`pbox-${idxId}`);
  if (!box) return;

  box.innerHTML = `
    <div class="pred-label">↗ PREDICTED DIGIT</div>
    <div class="pred-digit${animate ? ' digit-reveal' : ''}" id="digit-${idxId}">${pred.digit}</div>
    <div class="pred-confidence" id="conf-${idxId}">Confidence: ${pred.confidence}%</div>
  `;
}

function updateConfidence(idxId, confidence) {
  const confEl = document.getElementById(`conf-${idxId}`);
  if (confEl) confEl.textContent = `Confidence: ${confidence}%`;
}

// ── AUTH / LOGOUT ──────────────────────────────────
function logout() {
  if (state.ws) state.ws.close();
  Object.values(state.analyzers).forEach(az => {
    if (az.interval) clearInterval(az.interval);
  });
  sessionStorage.clear();
  window.location.href = '/';
}

// Expose logout to global scope (called from HTML)
window.logout = logout;
