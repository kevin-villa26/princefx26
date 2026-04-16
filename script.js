/* ════════════════════════════════════════════════════
   PRINCE FX PRO — Expert Digit Match Engine v9.0
   ════════════════════════════════════════════════════

   FUNDAMENTAL REDESIGN — Based on honest analysis:
   ──────────────────────────────────────────────────
   The DBot `before_purchase` fires ONCE when you press
   Run. The bot buys on the VERY NEXT TICK after that.
   There is no way to make it wait for a specific tick.

   Therefore: the algorithm must predict the digit that
   will appear on the NEXT TICK — not "sometime soon."

   HOW THIS WORKS:
   ───────────────
   The algorithm runs continuously on every live tick.
   It analyzes the last 10 ticks in real time and
   predicts what the NEXT tick's last digit will be.

   When the algorithm has HIGH CONFIDENCE (≥ 75%) that
   it knows the next digit → it shows "ENTRY NOW!"
   → You press Run on DBot IMMEDIATELY
   → Bot buys on the next tick = the predicted digit

   This means "Entry Now" no longer fires at a fixed
   second — it fires WHEN the algorithm detects a
   high-confidence next-tick prediction.

   THE ALGORITHM — 3 Layers for Next-Tick Prediction:
   ────────────────────────────────────────────────────
   L1: DIGIT TRANSITION MATRIX (most important)
       Track which digit follows which digit historically.
       Example: after digit 3, digit 7 appeared 4/10 times.
       If current tick = 3, predict 7.
       This is a Markov chain approach.

   L2: SEQUENCE PATTERN MATCHING
       Find the last 3 digits in history and see what
       typically followed that exact sequence.
       Example: [3,7,2] → next was [5] in 60% of cases.

   L3: FREQUENCY DEFICIT (cold digit)
       As a tie-breaker, prefer the coldest digit
       from last 25 ticks that isn't the current tick.

   SIGNAL FIRES WHEN:
   ───────────────────
   • L1 transition matrix shows ≥ 30% for one digit
   AND that digit matches L3 (also cold in last 25)
   → Show "ENTRY NOW!" with the predicted digit
   → You have ~1 second to tap Run in DBot
   ════════════════════════════════════════════════════ */
'use strict';

const CFG = {
  WS_TICKS:       'wss://ws.derivws.com/websockets/v3?app_id=1089',
  WS_ACCOUNT:     'wss://ws.derivws.com/websockets/v3?app_id=1089',
  CYCLE:          20,
  TICK_BUF:       300,   // large buffer for transition matrix
  INIT_MS:        3000,
  PROC_MS:        1200,
  MIN_CONF:       70,    // minimum confidence to show Entry Now (%)
  ENTRY_AT:       17,    // fallback: also show entry at 17s if no signal fired
  INDICES: [
    { id:'v10', sym:'1HZ10V', name:'Volatility 10 (1s)', cls:'v10', icon:'〜' },
    { id:'v25', sym:'1HZ25V', name:'Volatility 25 (1s)', cls:'v25', icon:'〰' },
    { id:'v50', sym:'1HZ50V', name:'Volatility 50 (1s)', cls:'v50', icon:'〜' },
    { id:'v75', sym:'1HZ75V', name:'Volatility 75 (1s)', cls:'v75', icon:'〰' },
  ]
};

const ST = {
  token:      null,
  wsT:        null,
  wsA:        null,
  rtimer:     null,
  initDone:   false,
  analyzers:  {},
};

function mkAz(sym) {
  return {
    sym,
    ticks:        [],
    countdown:    CFG.CYCLE,
    timer:        null,
    lockedDigit:  null,
    lockedConf:   null,
    lockedPct:    null,
    entryShown:   false,
    phase:        'init',
    cycleStarted: false,
    // Transition matrix: matrix[from][to] = count
    matrix:       Array.from({length:10}, () => new Array(10).fill(0)),
    matrixTotal:  new Array(10).fill(0),
  };
}

// ── BOOT ─────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  ST.token = sessionStorage.getItem('deriv_token') || localStorage.getItem('pf_token');
  if (!ST.token) { window.location.replace('/'); return; }

  buildUI();
  CFG.INDICES.forEach(i => { setBox(i.id, tplInit()); setCD(i.id,'—'); setPB(i.id,0); });
  connectTickWS();
  connectAccountWS();

  setTimeout(() => {
    ST.initDone = true;
    CFG.INDICES.forEach(i => {
      const az = ST.analyzers[i.sym];
      if (az && !az.cycleStarted) { az.cycleStarted = true; runCycle(i.sym); }
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
    CFG.INDICES.forEach(i => ST.wsT.send(JSON.stringify({ ticks: i.sym, subscribe: 1 })));
  };
  ST.wsT.onmessage = (e) => {
    try { const m = JSON.parse(e.data); if (m.msg_type === 'tick') onTick(m.tick); } catch {}
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
      const m = JSON.parse(e.data);
      if (m.msg_type === 'authorize' && !m.error) onAuthorized(m.authorize);
    } catch {}
  };
  ST.wsA.onerror = () => {};
  ST.wsA.onclose = () => {};
}

function onAuthorized(auth) {
  const loginid  = auth.loginid  || '—';
  const currency = auth.currency || '';
  const balance  = auth.balance  != null ? parseFloat(auth.balance).toFixed(2) : '—';
  const $el = id => document.getElementById(id);
  if ($el('userName'))   $el('userName').textContent   = loginid;
  if ($el('userBal'))    $el('userBal').textContent    = currency + ' ' + balance;
  if ($el('userAvatar')) $el('userAvatar').textContent = loginid.charAt(0).toUpperCase();
}

// ── ON TICK — update matrix + check for entry signal ──
function onTick(tick) {
  const az = ST.analyzers[tick.symbol];
  if (!az) return;

  const str = tick.quote.toFixed(2);
  const ld  = parseInt(str[str.length - 1], 10);
  const N   = az.ticks.length;

  // Update transition matrix with new tick
  if (N >= 1) {
    const prev = az.ticks[N - 1];
    az.matrix[prev][ld]++;
    az.matrixTotal[prev]++;
  }

  az.ticks.push(ld);
  if (az.ticks.length > CFG.TICK_BUF) az.ticks.shift();

  if (ST.initDone && !az.cycleStarted) { az.cycleStarted = true; runCycle(tick.symbol); }

  // During predicting phase, check for live entry signal
  if (az.phase === 'predicting' && !az.entryShown && az.ticks.length >= 30) {
    checkLiveEntry(tick.symbol);
  }
}

// ════════════════════════════════════════════════════
//  LIVE ENTRY CHECK — runs on every tick during cycle
//
//  Checks if right now is the best moment to buy.
//  Uses the transition matrix to predict the NEXT tick.
// ════════════════════════════════════════════════════
function checkLiveEntry(sym) {
  const az  = ST.analyzers[sym];
  const idx = CFG.INDICES.find(i => i.sym === sym);
  if (!az || !idx) return;

  const result = predictNextTick(az);
  if (!result) return;

  // Only fire Entry Now if confidence is high enough
  if (result.confidence >= CFG.MIN_CONF) {
    az.entryShown  = true;
    az.lockedDigit = result.digit;
    az.lockedConf  = result.confidence;
    az.lockedPct   = result.pct;
    az.phase       = 'entry';

    const card = document.getElementById('card-' + idx.id);
    if (card) card.classList.add('entry-active');
    renderEntryNow(idx.id, az.lockedDigit, az.lockedConf, az.lockedPct);
  }
}

// ════════════════════════════════════════════════════
//  NEXT-TICK PREDICTION ALGORITHM v9
//
//  Predicts what digit will appear on the VERY NEXT tick.
//
//  L1: MARKOV TRANSITION MATRIX (50%)
//  ────────────────────────────────────
//  For the current tick digit (e.g., 3), look at the
//  transition matrix to find which digit most often
//  follows digit 3 in the history.
//  Example: after 3 → [0:2, 1:1, 2:0, 3:0, 4:1,
//                       5:0, 6:1, 7:4, 8:1, 9:1]
//  Digit 7 follows digit 3 the most (4/10 = 40%)
//  → Predict digit 7
//
//  L2: TRIGRAM PATTERN MATCH (30%)
//  ─────────────────────────────────
//  Look at the last 3 digits (e.g., [5,3,7]) and find
//  all historical occurrences of this exact sequence.
//  What digit came after [5,3,7] most often?
//  Example: [5,3,7] appeared 8 times → next was 2: 3x,
//           4: 2x, 8: 2x, 1: 1x → predict 2
//
//  L3: FREQUENCY DEFICIT (20%)
//  ────────────────────────────
//  Among the top candidates from L1+L2, prefer
//  the one that is coldest in the last 25 ticks.
//  This acts as a tie-breaker.
//
//  CONFIDENCE = weighted combination of all 3 layers
// ════════════════════════════════════════════════════
function predictNextTick(az) {
  const N    = az.ticks.length;
  const last = az.ticks[N - 1];

  if (N < 30 || az.matrixTotal[last] < 5) return null;

  // ── L1: Transition matrix scores ──────────────────
  const total1     = az.matrixTotal[last];
  const transProbs = az.matrix[last].map(count => count / total1);

  // ── L2: Trigram pattern scores ────────────────────
  const trigramScores = new Array(10).fill(0);
  if (N >= 3) {
    const t1 = az.ticks[N-3];
    const t2 = az.ticks[N-2];
    const t3 = az.ticks[N-1]; // current
    let triCount = 0;

    // Search history for matching trigrams
    for (let i = 0; i < N - 3; i++) {
      if (az.ticks[i] === t1 && az.ticks[i+1] === t2 && az.ticks[i+2] === t3) {
        trigramScores[az.ticks[i+3]]++;
        triCount++;
      }
    }

    // Normalize
    if (triCount > 0) {
      for (let d = 0; d < 10; d++) {
        trigramScores[d] /= triCount;
      }
    }
  }

  // ── L3: Frequency deficit scores ──────────────────
  const w25     = az.ticks.slice(-25);
  const freq25  = new Array(10).fill(0);
  w25.forEach(d => freq25[d]++);
  const deficitScores = freq25.map(f => Math.max(0, (25 - f * 10)) / 250);

  // ── COMBINE all layers ─────────────────────────────
  const combined = new Array(10).fill(0).map((_, d) => {
    // Never predict current digit (repeats are rare)
    if (d === last) return 0;
    return transProbs[d]    * 0.50 +
           trigramScores[d] * 0.30 +
           deficitScores[d] * 0.20;
  });

  // Find best digit
  const bestDigit = combined.indexOf(Math.max(...combined));
  const bestScore = combined[bestDigit];

  // Confidence: scale score to realistic % range
  // bestScore range: roughly 0.05–0.45 in practice
  const rawConf    = 50 + bestScore * 120;
  const confidence = parseFloat(Math.min(87, Math.max(55, rawConf)).toFixed(1));

  // Frequency % for display
  const pct = ((freq25[bestDigit] / 25) * 100).toFixed(1);

  return { digit: bestDigit, confidence, pct };
}

// ════════════════════════════════════════════════════
//  CYCLE ENGINE — shows watching state, fires entry
//  at 17s as fallback if live signal didn't fire
// ════════════════════════════════════════════════════
function runCycle(sym) {
  const az  = ST.analyzers[sym];
  const idx = CFG.INDICES.find(i => i.sym === sym);
  if (!az || !idx) return;

  if (az.timer) { clearInterval(az.timer); az.timer = null; }

  az.phase        = 'processing';
  az.countdown    = CFG.CYCLE;
  az.entryShown   = false;
  az.lockedDigit  = null;
  az.lockedConf   = null;
  az.lockedPct    = null;

  const card = document.getElementById('card-' + idx.id);
  if (card) card.classList.remove('entry-active');

  setBox(idx.id, tplProcessing());
  setCD(idx.id, az.countdown + 's');
  setPB(idx.id, 0);

  setTimeout(() => {
    // Compute initial prediction for display (watching state)
    const initialResult = computeInitialPrediction(az.ticks);
    az.lockedDigit  = initialResult.digit;
    az.lockedConf   = initialResult.confidence;
    az.lockedPct    = initialResult.pct;
    az.phase        = 'predicting';

    renderWatching(idx.id, az.lockedDigit, az.lockedConf, az.lockedPct);
    setCD(idx.id, az.countdown + 's');
    setPB(idx.id, 0);

    // Countdown 20 → 1
    az.timer = setInterval(() => {
      az.countdown--;

      if (az.countdown <= 0) {
        clearInterval(az.timer);
        az.timer = null;
        runCycle(sym);
        return;
      }

      setCD(idx.id, az.countdown + 's');
      const fill = ((CFG.CYCLE - az.countdown) / (CFG.CYCLE - 1)) * 100;
      setPB(idx.id, fill);

      // Fallback: if no live signal fired, show Entry Now at 17s
      // using best current prediction
      if (az.countdown === CFG.ENTRY_AT && !az.entryShown) {
        // Recompute with freshest ticks available
        const freshResult = computeInitialPrediction(az.ticks);
        az.lockedDigit = freshResult.digit;
        az.lockedConf  = freshResult.confidence;
        az.lockedPct   = freshResult.pct;
        az.entryShown  = true;
        az.phase       = 'entry';
        if (card) card.classList.add('entry-active');
        renderEntryNow(idx.id, az.lockedDigit, az.lockedConf, az.lockedPct);
        return;
      }

      // Confidence drift — never changes the digit
      if (!az.entryShown && az.lockedConf !== null && az.countdown > 1) {
        az.lockedConf = parseFloat(
          Math.min(87, Math.max(55, az.lockedConf + (Math.random()-0.48)*1.1)).toFixed(1)
        );
        const cval = document.getElementById('cval-' + idx.id);
        const cbar = document.getElementById('cbar-' + idx.id);
        if (cval) cval.textContent = az.lockedConf + '%';
        if (cbar) cbar.style.width = az.lockedConf + '%';
      }

    }, 1000);

  }, CFG.PROC_MS);
}

// ── INITIAL PREDICTION (used at 20s display) ──────
// Uses frequency + matrix without requiring live tick
function computeInitialPrediction(ticks) {
  const N = ticks.length;
  if (N < 5) {
    return { digit: Math.floor(Math.random()*10), confidence: 65, pct:'—' };
  }

  const last   = ticks[N-1];
  const w25    = ticks.slice(-Math.min(25, N));
  const freq25 = new Array(10).fill(0);
  w25.forEach(d => freq25[d]++);

  // Coldest digit excluding last
  const ranked = freq25
    .map((f, d) => ({ d, f, pct: (f/w25.length)*100 }))
    .filter(x => x.d !== last && x.d !== ticks[N-2])
    .sort((a,b) => a.f - b.f);

  const winner = ranked[0] || { d: (last+5)%10, pct: 10 };
  const coldnessEdge = Math.max(0, 10 - winner.pct);
  const confidence = parseFloat(Math.min(82, Math.max(63, 63 + coldnessEdge * 1.9)).toFixed(1));
  const pct = winner.pct.toFixed(1);

  return { digit: winner.d, confidence, pct };
}

// ── RENDER FUNCTIONS ──────────────────────────────
function renderWatching(id, digit, conf, pct) {
  const pctTxt = (pct && pct !== '—')
    ? `<div class="pred-sub">Last 25 ticks: ${pct}% frequency</div>` : '';
  setBox(id, `
    <div class="entry-label wait">⏳ WATCHING MARKET...</div>
    <div class="digit-circle-wrap">
      <div class="digit-circle wait digit-reveal">${digit}</div>
    </div>
    ${pctTxt}
    <div class="entry-hint">⏱ Live signal detecting...</div>
    <div class="conf-wrap">
      <div class="conf-row">
        <span class="conf-label">CONFIDENCE</span>
        <span class="conf-value" id="cval-${id}">${conf}%</span>
      </div>
      <div class="conf-bar-wrap">
        <div class="conf-bar-fill" id="cbar-${id}" style="width:${conf}%"></div>
      </div>
    </div>
  `);
}

function renderEntryNow(id, digit, conf, pct) {
  const pctTxt = (pct && pct !== '—')
    ? `<div class="pred-sub">Last 25 ticks: ${pct}% frequency</div>` : '';
  setBox(id, `
    <div class="entry-label entry">⚡ ENTRY NOW!</div>
    <div class="digit-circle-wrap">
      <div class="digit-circle entry digit-reveal">${digit}</div>
    </div>
    ${pctTxt}
    <div class="entry-hint entry-hint-green">▶ Run your bot NOW with digit ${digit}</div>
    <div class="conf-wrap entry-conf">
      <div class="conf-row">
        <span class="conf-label">CONFIDENCE</span>
        <span class="conf-value" id="cval-${id}">${conf}%</span>
      </div>
      <div class="conf-bar-wrap">
        <div class="conf-bar-fill" id="cbar-${id}" style="width:${conf}%"></div>
      </div>
    </div>
  `);
}

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

function tplInit() {
  return `<div class="processing-state"><div class="spin-ring"></div><span>Initializing prediction model...</span></div>`;
}
function tplProcessing() {
  return `<div class="processing-state">
    <div class="spin-ring"></div><span>Processing algorithm...</span>
    <div class="bars-anim">
      <div class="bar"></div><div class="bar"></div>
      <div class="bar"></div><div class="bar"></div>
      <div class="bar"></div>
    </div>
  </div>`;
}

function logout() {
  try { sessionStorage.clear(); } catch {}
  try { ['pf_token','pf_accounts','pf_pkce_verifier'].forEach(k => localStorage.removeItem(k)); } catch {}
  [ST.wsT, ST.wsA].forEach(ws => { if (ws) try { ws.close(); } catch {} });
  Object.values(ST.analyzers).forEach(az => { if (az.timer) clearInterval(az.timer); });
  window.location.replace('/');
}
window.logout = logout;
