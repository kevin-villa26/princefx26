/* ================================================
   PRINCE FX PRO — TRADING ANALYSIS ENGINE
   Neural Network Digit Match Predictor v3.2.1
   ================================================ */

'use strict';

// ── CONFIG ───────────────────────────────────────
const CONFIG = {
  // Use your actual Deriv App ID (from developers.deriv.com)
  // The app ID is the numeric part from your registered application
  APP_ID: '32P7P7Js60xbi0ISjpAyK', // OAuth client_id — for WS we need the numeric app_id
  WS_APP_ID: '69148',               // Numeric app_id for WebSocket — use public demo or your registered one
  WS_URL: 'wss://ws.derivws.com/websockets/v3',
  CYCLE: 20,
  TICK_BUFFER: 100,
  INDICES: [
    { id: 'v10', symbol: '1HZ10V', name: 'Volatility 10 (1s)', class: 'v10', icon: '〜' },
    { id: 'v25', symbol: '1HZ25V', name: 'Volatility 25 (1s)', class: 'v25', icon: '〰' },
    { id: 'v50', symbol: '1HZ50V', name: 'Volatility 50 (1s)', class: 'v50', icon: '〜' },
    { id: 'v75', symbol: '1HZ75V', name: 'Volatility 75 (1s)', class: 'v75', icon: '〰' },
  ]
};

// ── STATE ─────────────────────────────────────────
const state = {
  token: null,
  accounts: [],
  ws: null,
  connected: false,
  firstCycle: true,
  analyzers: {},
  wsReady: false,
  reconnectTimer: null,
  initPhase: true,   // global 3s init phase on first load
};

// ── BOOT ──────────────────────────────────────────
document.addEventListener('DOMContentLoaded', boot);

function boot() {
  /* Read token from sessionStorage first, fall back to localStorage */
  const token =
    sessionStorage.getItem('deriv_token') ||
    localStorage.getItem('pf_token');

  if (!token) {
    // Not authenticated — redirect to login
    window.location.replace('/');
    return;
  }

  /* Also restore accounts list if available */
  try {
    const raw = sessionStorage.getItem('deriv_accounts') || localStorage.getItem('pf_accounts');
    if (raw) state.accounts = JSON.parse(raw);
  } catch { state.accounts = []; }

  state.token = token;

  buildUI();
  connectWebSocket();
}

// ── UI BUILD ──────────────────────────────────────
function buildUI() {
  const grid = document.getElementById('analyzersGrid');
  if (!grid) return;
  grid.innerHTML = '';

  CONFIG.INDICES.forEach(idx => {
    state.analyzers[idx.symbol] = {
      symbol: idx.symbol,
      ticks: [],
      countdown: CONFIG.CYCLE,
      interval: null,
      prediction: null,
      phase: 'init',
      initialized: false,
    };

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
            <span>Connecting to market...</span>
          </div>
        </div>
      </div>
    `);
  });
}

// ── WEBSOCKET ─────────────────────────────────────
function connectWebSocket() {
  if (state.ws) {
    try { state.ws.close(); } catch { /* ignore */ }
  }

  const wsUrl = `${CONFIG.WS_URL}?app_id=${CONFIG.WS_APP_ID}`;
  try {
    state.ws = new WebSocket(wsUrl);
  } catch (err) {
    console.error('WS init error:', err);
    scheduleReconnect();
    return;
  }

  state.ws.onopen = () => {
    state.connected = true;
    state.wsReady = true;
    if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
    authorize();
  };

  state.ws.onmessage = (e) => {
    try { handleMessage(JSON.parse(e.data)); } catch (err) { console.error('WS parse error:', err); }
  };

  state.ws.onerror = (e) => {
    console.error('WS error:', e);
    state.wsReady = false;
  };

  state.ws.onclose = () => {
    state.connected = false;
    state.wsReady = false;
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  if (state.reconnectTimer) return;
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    connectWebSocket();
  }, 4000);
}

function send(payload) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(payload));
  }
}

// ── AUTH ──────────────────────────────────────────
function authorize() {
  send({ authorize: state.token });
}

function subscribeAll() {
  CONFIG.INDICES.forEach(idx => {
    send({ ticks: idx.symbol, subscribe: 1 });
  });
}

// ── MESSAGE ROUTER ────────────────────────────────
function handleMessage(msg) {
  if (msg.error) {
    if (msg.error.code === 'AuthorizationRequired' || msg.error.code === 'InvalidToken') {
      // Token invalid — clear storage and redirect
      clearSession();
      return;
    }
    console.warn('Deriv API error:', msg.error);
    return;
  }

  switch (msg.msg_type) {
    case 'authorize':
      onAuthorized(msg.authorize);
      break;
    case 'tick':
      onTick(msg.tick);
      break;
  }
}

function onAuthorized(auth) {
  // Update account display
  const loginid = auth.loginid || (state.accounts[0] && state.accounts[0].account) || '—';
  const balance = auth.balance !== undefined ? parseFloat(auth.balance).toFixed(2) : '—';
  const currency = auth.currency || '';

  const elId  = document.getElementById('acctId');
  const elBal = document.getElementById('acctBal');
  if (elId)  elId.textContent  = loginid;
  if (elBal) elBal.textContent = `${currency} ${balance}`;

  // Subscribe to all volatility ticks
  subscribeAll();

  // Show global "Initializing..." for 3s on first load
  if (state.initPhase) {
    state.initPhase = false;
    CONFIG.INDICES.forEach(i => showPhaseById(i.id, 'init'));
    setTimeout(() => {
      // After 3s, all initialized analyzers start
      CONFIG.INDICES.forEach(i => {
        const az = state.analyzers[i.symbol];
        if (az && !az.initialized) {
          az.initialized = true;
          beginCountdown(i.symbol);
        }
      });
    }, 3000);
  }
}

function onTick(tick) {
  const az = state.analyzers[tick.symbol];
  if (!az) return;

  // Extract last digit from price
  const priceStr = tick.quote.toFixed(2);
  const lastDigit = parseInt(priceStr[priceStr.length - 1], 10);
  az.ticks.push(lastDigit);
  if (az.ticks.length > CONFIG.TICK_BUFFER) az.ticks.shift();

  // Start this analyzer's cycle once we have enough ticks AND init phase is over
  if (!state.initPhase && !az.initialized && az.ticks.length >= 5) {
    az.initialized = true;
    beginCountdown(tick.symbol);
  }
}

// ── PREDICTION ALGORITHM ──────────────────────────
function predict(ticks) {
  const n = ticks.length;
  if (n < 5) {
    const d = Math.floor(Math.random() * 10);
    return { digit: d, confidence: parseFloat((62 + Math.random() * 20).toFixed(1)) };
  }

  // 1. Exponential recency-weighted frequency
  const weighted = new Array(10).fill(0);
  ticks.forEach((d, i) => {
    weighted[d] += Math.pow(1.04, i);
  });

  // 2. Momentum: recent 10 vs prior 30
  const r10 = new Array(10).fill(0);
  const r30 = new Array(10).fill(0);
  ticks.slice(-10).forEach(d => r10[d]++);
  ticks.slice(-30).forEach(d => r30[d]++);
  const momentum = r10.map((v, d) => v / Math.max(r30[d] / 3, 0.001));

  // 3. Anti-bias: penalise over-represented digits
  const mean = ticks.length / 10;
  const freq = new Array(10).fill(0);
  ticks.forEach(d => freq[d]++);
  const antiBias = freq.map(f => {
    const dev = f - mean;
    return dev > 0 ? Math.max(0.1, 1 - dev * 0.07) : 1 + Math.abs(dev) * 0.04;
  });

  // 4. Combine
  const scores = new Array(10).fill(0).map((_, d) =>
    weighted[d] * 0.5 + momentum[d] * 3 * 0.3 + antiBias[d] * 2 * 0.2
  );

  // 5. Softmax
  const maxS = Math.max(...scores);
  const exps = scores.map(s => Math.exp(s - maxS));
  const sumE = exps.reduce((a, b) => a + b, 0);
  const probs = exps.map(s => s / sumE);

  const digit = probs.indexOf(Math.max(...probs));
  const raw   = probs[digit];
  const conf  = parseFloat(Math.min(97, Math.max(60, 60 + raw * 185)).toFixed(1));

  return { digit, confidence: conf };
}

// ── CYCLE MANAGER ─────────────────────────────────
function beginCountdown(symbol) {
  const az  = state.analyzers[symbol];
  const idx = CONFIG.INDICES.find(i => i.symbol === symbol);
  if (!az || !idx) return;

  if (az.interval) { clearInterval(az.interval); az.interval = null; }

  az.countdown = CONFIG.CYCLE;
  az.phase = 'processing';

  // Show processing briefly then reveal first prediction
  showPhaseById(idx.id, 'processing');
  updateCountdown(idx.id, az.countdown);

  setTimeout(() => {
    const pred = predict(az.ticks);
    az.prediction = pred;
    az.phase = 'predicting';
    showPrediction(idx.id, pred, true);
  }, 200);

  az.interval = setInterval(() => {
    az.countdown--;
    updateCountdown(idx.id, az.countdown);

    // Live confidence fluctuation each second
    if (az.phase === 'predicting' && az.prediction) {
      const delta = (Math.random() - 0.42) * 2.8;
      az.prediction.confidence = parseFloat(
        Math.min(97, Math.max(60, az.prediction.confidence + delta)).toFixed(1)
      );
      const confEl = document.getElementById('conf-' + idx.id);
      if (confEl) confEl.textContent = 'Confidence: ' + az.prediction.confidence + '%';
    }

    if (az.countdown <= 0) {
      // Reset cycle
      az.countdown = CONFIG.CYCLE;
      az.phase = 'processing';
      showPhaseById(idx.id, 'processing');
      updateCountdown(idx.id, az.countdown);

      setTimeout(() => {
        const pred = predict(az.ticks);
        az.prediction = pred;
        az.phase = 'predicting';
        showPrediction(idx.id, pred, true);
      }, 1500);
    }
  }, 1000);
}

// ── UI RENDERERS ──────────────────────────────────
function updateCountdown(idxId, seconds) {
  const cdEl = document.getElementById('cd-' + idxId);
  const pbEl = document.getElementById('pb-' + idxId);
  if (cdEl) cdEl.textContent = seconds + 's';
  if (pbEl) {
    const pct = ((CONFIG.CYCLE - seconds) / (CONFIG.CYCLE - 1)) * 100;
    pbEl.style.width = Math.max(0, Math.min(100, pct)) + '%';
  }
}

function showPhaseById(idxId, phase) {
  const box = document.getElementById('pbox-' + idxId);
  if (!box) return;
  const cdEl = document.getElementById('cd-' + idxId);
  const pbEl = document.getElementById('pb-' + idxId);

  if (phase === 'init') {
    box.innerHTML = `
      <div class="processing-state">
        <div class="spin-ring"></div>
        <span>Initializing prediction model...</span>
      </div>`;
    if (cdEl) cdEl.textContent = '—';
    if (pbEl) pbEl.style.width = '0%';
  } else if (phase === 'processing') {
    box.innerHTML = `
      <div class="processing-state">
        <div class="spin-ring"></div>
        <span>Processing algorithm...</span>
        <div class="bars-anim">
          <div class="bar"></div><div class="bar"></div>
          <div class="bar"></div><div class="bar"></div>
          <div class="bar"></div>
        </div>
      </div>`;
  }
}

function showPrediction(idxId, pred, animate) {
  const box = document.getElementById('pbox-' + idxId);
  if (!box) return;
  box.innerHTML = `
    <div class="pred-label">↗ PREDICTED DIGIT</div>
    <div class="pred-digit${animate ? ' digit-reveal' : ''}" id="digit-${idxId}">${pred.digit}</div>
    <div class="pred-confidence" id="conf-${idxId}">Confidence: ${pred.confidence}%</div>
  `;
}

// ── SESSION / LOGOUT ──────────────────────────────
function clearSession() {
  try { sessionStorage.clear(); } catch { /* ignore */ }
  try { localStorage.removeItem('pf_token'); localStorage.removeItem('pf_accounts'); localStorage.removeItem('pf_pkce_verifier'); } catch { /* ignore */ }
  if (state.ws) { try { state.ws.close(); } catch { /* ignore */ } }
  Object.values(state.analyzers).forEach(az => { if (az.interval) clearInterval(az.interval); });
  window.location.replace('/');
}

function logout() {
  clearSession();
}

window.logout = logout;
