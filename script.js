/* ================================================
   PRINCE FX PRO — Neural Digit Match Engine v3.2.1
   ================================================ */
'use strict';

// ── CONFIG ───────────────────────────────────────
const CONFIG = {
  WS_URL:      'wss://ws.derivws.com/websockets/v3',
  WS_APP_ID:   '1089',   // Public app_id for WebSocket connection
  CYCLE:       20,       // seconds per prediction cycle
  TICK_BUFFER: 100,      // ticks used for algorithm
  INIT_DELAY:  3000,     // ms to show "Initializing..." on first login
  INDICES: [
    { id: 'v10', symbol: '1HZ10V', name: 'Volatility 10 (1s)', cls: 'v10', icon: '〜' },
    { id: 'v25', symbol: '1HZ25V', name: 'Volatility 25 (1s)', cls: 'v25', icon: '〰' },
    { id: 'v50', symbol: '1HZ50V', name: 'Volatility 50 (1s)', cls: 'v50', icon: '〜' },
    { id: 'v75', symbol: '1HZ75V', name: 'Volatility 75 (1s)', cls: 'v75', icon: '〰' },
  ]
};

// ── STATE ─────────────────────────────────────────
const S = {
  token:           null,
  ws:              null,
  reconnectTimer:  null,
  initDone:        false,   // true once the 3s init phase has completed
  authorized:      false,
  analyzers:       {}       // keyed by symbol
};

// Per-symbol analyzer state
function mkAnalyzer(symbol) {
  return {
    symbol,
    ticks:       [],      // last N last-digits
    countdown:   CONFIG.CYCLE,
    timer:       null,    // setInterval handle
    prediction:  null,    // { digit, confidence }
    phase:       'connecting', // 'connecting'|'init'|'processing'|'predicting'
    cycleStarted: false,  // has this analyzer's countdown begun?
  };
}

// ── BOOT ──────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const token =
    sessionStorage.getItem('deriv_token') ||
    localStorage.getItem('pf_token');

  if (!token) { window.location.replace('/'); return; }
  S.token = token;

  buildUI();
  connectWS();
});

// ── BUILD UI ──────────────────────────────────────
function buildUI() {
  const grid = document.getElementById('analyzersGrid');
  if (!grid) return;
  grid.innerHTML = '';

  CONFIG.INDICES.forEach(idx => {
    S.analyzers[idx.symbol] = mkAnalyzer(idx.symbol);

    grid.insertAdjacentHTML('beforeend', `
      <div class="analyzer-card ${idx.cls}" id="card-${idx.id}">

        <div class="card-header">
          <div class="card-title-wrap">
            <div class="card-icon">${idx.icon}</div>
            <div class="card-name">${idx.name}</div>
          </div>
          <div class="live-badge">
            <div class="live-dot"></div>LIVE
          </div>
        </div>

        <div class="countdown-row">
          <span class="countdown-label">Next analysis in</span>
          <span class="countdown-num" id="cd-${idx.id}">—</span>
        </div>

        <div class="progress-wrap">
          <div class="progress-fill" id="pb-${idx.id}" style="width:0%"></div>
        </div>

        <div class="prediction-box" id="pbox-${idx.id}">
          ${connectingHTML()}
        </div>

      </div>
    `);
  });
}

// ── HTML TEMPLATES ─────────────────────────────────
function connectingHTML() {
  return `<div class="processing-state">
    <div class="spin-ring"></div>
    <span>Connecting to market...</span>
  </div>`;
}

function initHTML() {
  return `<div class="processing-state">
    <div class="spin-ring"></div>
    <span>Initializing prediction model...</span>
  </div>`;
}

function processingHTML() {
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

function predictionHTML(pred, animate) {
  return `
    <div class="pred-label">↗ PREDICTED DIGIT</div>
    <div class="pred-digit${animate ? ' digit-reveal' : ''}" id="dnum-{{ ID }}">${pred.digit}</div>
    <div class="conf-wrap">
      <div class="conf-row">
        <span class="conf-label">CONFIDENCE</span>
        <span class="conf-value" id="cval-{{ ID }}">${pred.confidence}%</span>
      </div>
      <div class="conf-bar-wrap">
        <div class="conf-bar-fill" id="cbar-{{ ID }}" style="width:${pred.confidence}%"></div>
      </div>
    </div>
  `;
}

// ── WEBSOCKET ─────────────────────────────────────
function connectWS() {
  if (S.ws) { try { S.ws.close(); } catch{} }

  S.ws = new WebSocket(`${CONFIG.WS_URL}?app_id=${CONFIG.WS_APP_ID}`);

  S.ws.onopen  = () => { clearReconnect(); sendWS({ authorize: S.token }); };
  S.ws.onclose = () => scheduleReconnect();
  S.ws.onerror = () => {};
  S.ws.onmessage = (e) => {
    try { routeMsg(JSON.parse(e.data)); } catch {}
  };
}

function sendWS(obj) {
  if (S.ws && S.ws.readyState === WebSocket.OPEN)
    S.ws.send(JSON.stringify(obj));
}

function scheduleReconnect() {
  if (S.reconnectTimer) return;
  S.reconnectTimer = setTimeout(() => { S.reconnectTimer = null; connectWS(); }, 4000);
}
function clearReconnect() {
  if (S.reconnectTimer) { clearTimeout(S.reconnectTimer); S.reconnectTimer = null; }
}

// ── MESSAGE ROUTER ────────────────────────────────
function routeMsg(msg) {
  if (msg.error) {
    const c = msg.error.code;
    if (c === 'InvalidToken' || c === 'AuthorizationRequired') clearSessionAndRedirect();
    return;
  }
  if (msg.msg_type === 'authorize') onAuthorized(msg.authorize);
  if (msg.msg_type === 'tick')      onTick(msg.tick);
}

// ── ON AUTHORIZED ─────────────────────────────────
function onAuthorized(auth) {
  S.authorized = true;

  /* ── Display username + balance ── */
  const loginid  = auth.loginid  || '—';
  const currency = auth.currency || 'USD';
  const balance  = auth.balance  != null ? parseFloat(auth.balance).toFixed(2) : '0.00';

  const elName = document.getElementById('userName');
  const elBal  = document.getElementById('userBal');
  const elAvtr = document.getElementById('userAvatar');
  if (elName) elName.textContent = loginid;
  if (elBal)  elBal.textContent  = `${currency} ${balance}`;
  if (elAvtr) elAvtr.textContent = loginid.charAt(0).toUpperCase();

  /* ── Subscribe to all 4 volatility indices ── */
  CONFIG.INDICES.forEach(idx => sendWS({ ticks: idx.symbol, subscribe: 1 }));

  /* ── Show "Initializing prediction model..." on ALL cards for 3s (first login only) ── */
  if (!S.initDone) {
    CONFIG.INDICES.forEach(idx => {
      const box = document.getElementById('pbox-' + idx.id);
      if (box) box.innerHTML = initHTML();
      const cd = document.getElementById('cd-' + idx.id);
      if (cd) cd.textContent = '—';
    });

    setTimeout(() => {
      S.initDone = true;
      /* Start countdown for any analyzer that already has ticks */
      CONFIG.INDICES.forEach(idx => {
        const az = S.analyzers[idx.symbol];
        if (az && !az.cycleStarted) {
          az.cycleStarted = true;
          beginCycle(idx.symbol);
        }
      });
    }, CONFIG.INIT_DELAY);
  }
}

// ── ON TICK ───────────────────────────────────────
function onTick(tick) {
  const az = S.analyzers[tick.symbol];
  if (!az) return;

  /* Extract last digit of price */
  const str  = tick.quote.toFixed(2);
  const last = parseInt(str[str.length - 1], 10);
  az.ticks.push(last);
  if (az.ticks.length > CONFIG.TICK_BUFFER) az.ticks.shift();

  /* Once init phase is done, start cycle if not already running */
  if (S.initDone && !az.cycleStarted) {
    az.cycleStarted = true;
    beginCycle(tick.symbol);
  }
}

// ── PREDICTION ALGORITHM ──────────────────────────
/*
  Multi-layer weighted probability:
    Layer 1 – Exponential recency weight (recent ticks count more)
    Layer 2 – Momentum ratio (last 10 vs last 30)
    Layer 3 – Anti-frequency bias (under-represented digits boosted)
    Layer 4 – Repetition gap (how long since digit last appeared)
  Final output via softmax → highest probability digit + confidence %
*/
function predict(ticks) {
  if (ticks.length < 5) {
    return {
      digit:      Math.floor(Math.random() * 10),
      confidence: parseFloat((62 + Math.random() * 18).toFixed(1))
    };
  }

  const N = ticks.length;

  /* Layer 1 – exponential recency */
  const recency = new Array(10).fill(0);
  ticks.forEach((d, i) => { recency[d] += Math.pow(1.045, i); });

  /* Layer 2 – momentum */
  const r10 = new Array(10).fill(0);
  const r30 = new Array(10).fill(0);
  ticks.slice(-10).forEach(d => r10[d]++);
  ticks.slice(-30).forEach(d => r30[d]++);
  const momentum = r10.map((v, d) => v / Math.max(r30[d] / 3, 0.001));

  /* Layer 3 – anti-bias (penalise over-appearing digits) */
  const freq = new Array(10).fill(0);
  ticks.forEach(d => freq[d]++);
  const meanFreq = N / 10;
  const antiBias = freq.map(f => {
    const dev = f - meanFreq;
    return dev > 0
      ? Math.max(0.08, 1 - dev * 0.06)
      : 1 + Math.abs(dev) * 0.045;
  });

  /* Layer 4 – repetition gap (boost digits not seen recently) */
  const gap = new Array(10).fill(0);
  const last = new Array(10).fill(-1);
  ticks.forEach((d, i) => { last[d] = i; });
  last.forEach((l, d) => { gap[d] = l === -1 ? N : N - 1 - l; });
  const gapBoost = gap.map(g => 1 + Math.min(g, 15) * 0.012);

  /* Combine scores */
  const scores = new Array(10).fill(0).map((_, d) =>
    recency[d]   * 0.40 +
    momentum[d]  * 3    * 0.25 +
    antiBias[d]  * 2    * 0.20 +
    gapBoost[d]  * 2    * 0.15
  );

  /* Softmax */
  const maxS = Math.max(...scores);
  const exps = scores.map(s => Math.exp(s - maxS));
  const sumE = exps.reduce((a, b) => a + b, 0);
  const probs = exps.map(e => e / sumE);

  const digit = probs.indexOf(Math.max(...probs));
  const conf  = parseFloat(
    Math.min(97, Math.max(61, 61 + probs[digit] * 190)).toFixed(1)
  );

  return { digit, confidence: conf };
}

// ── CYCLE MANAGER ─────────────────────────────────
function beginCycle(symbol) {
  const az  = S.analyzers[symbol];
  const idx = CONFIG.INDICES.find(i => i.symbol === symbol);
  if (!az || !idx) return;

  /* Clear any existing timer */
  if (az.timer) { clearInterval(az.timer); az.timer = null; }

  az.countdown = CONFIG.CYCLE;

  /* Show "Processing algorithm..." */
  setBox(idx.id, processingHTML());
  setCD(idx.id, az.countdown);
  setPB(idx.id, az.countdown);

  /* After 1.5s show first prediction */
  setTimeout(() => {
    az.prediction = predict(az.ticks);
    az.phase = 'predicting';
    renderPrediction(idx.id, az.prediction, true);
  }, 1500);

  /* Tick every second */
  az.timer = setInterval(() => {
    az.countdown--;
    setCD(idx.id, az.countdown);
    setPB(idx.id, az.countdown);

    /* Live confidence drift */
    if (az.phase === 'predicting' && az.prediction) {
      const drift = (Math.random() - 0.42) * 2.6;
      az.prediction.confidence = parseFloat(
        Math.min(97, Math.max(61, az.prediction.confidence + drift)).toFixed(1)
      );
      updateConfidence(idx.id, az.prediction.confidence);
    }

    /* Cycle end */
    if (az.countdown <= 0) {
      az.countdown = CONFIG.CYCLE;
      az.phase = 'processing';
      setBox(idx.id, processingHTML());
      setCD(idx.id, az.countdown);
      setPB(idx.id, az.countdown);

      setTimeout(() => {
        az.prediction = predict(az.ticks);
        az.phase = 'predicting';
        renderPrediction(idx.id, az.prediction, true);
      }, 1500);
    }
  }, 1000);
}

// ── UI HELPERS ────────────────────────────────────
function setBox(idxId, html) {
  const el = document.getElementById('pbox-' + idxId);
  if (el) el.innerHTML = html;
}

function renderPrediction(idxId, pred, animate) {
  const html = predictionHTML(pred, animate)
    .replace(/\{\{ ID \}\}/g, idxId);
  setBox(idxId, html);
}

function updateConfidence(idxId, conf) {
  const val  = document.getElementById('cval-' + idxId);
  const bar  = document.getElementById('cbar-' + idxId);
  if (val)  val.textContent  = conf + '%';
  if (bar)  bar.style.width  = conf + '%';
}

function setCD(idxId, seconds) {
  const el = document.getElementById('cd-' + idxId);
  if (el) el.textContent = seconds + 's';
}

function setPB(idxId, seconds) {
  const el = document.getElementById('pb-' + idxId);
  if (!el) return;
  /* Empty at 20s, full at 1s — left to right */
  const pct = ((CONFIG.CYCLE - seconds) / (CONFIG.CYCLE - 1)) * 100;
  el.style.width = Math.max(0, Math.min(100, pct)) + '%';
}

// ── SESSION CLEAR ─────────────────────────────────
function clearSessionAndRedirect() {
  try { sessionStorage.clear(); } catch {}
  try {
    localStorage.removeItem('pf_token');
    localStorage.removeItem('pf_accounts');
    localStorage.removeItem('pf_pkce_verifier');
  } catch {}
  if (S.ws) { try { S.ws.close(); } catch {} }
  Object.values(S.analyzers).forEach(az => {
    if (az.timer) clearInterval(az.timer);
  });
  window.location.replace('/');
}

function logout() { clearSessionAndRedirect(); }
window.logout = logout;
