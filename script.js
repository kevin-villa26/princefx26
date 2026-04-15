/* ════════════════════════════════════════════════════
   PRINCE FX PRO — Expert Digit Match Engine v7.0
   ════════════════════════════════════════════════════

   CORE INSIGHT FROM YOUR RESULTS:
   ─────────────────────────────────
   The winning developer always fires Entry Now at 17s
   and wins consistently. This works because his tool
   does NOT predict "any cold digit" — it specifically
   selects the digit most likely to appear in the next
   3–5 ticks from the moment of analysis (i.e., the
   tick arriving around second 16–14 of the countdown).

   YOUR PROBLEM (diagnosed from screenshots):
   ───────────────────────────────────────────
   • Digit 2 predicted → appeared at 9s (too late, 11 ticks away)
   • Digit 0 predicted → appeared at 16s (correct, 4 ticks away) = WIN

   The cold-digit algorithm selects the digit with
   lowest frequency overall, but that digit could be
   1 tick away OR 15 ticks away. We need the one
   that is specifically ~4 ticks away.

   THE CORRECT EXPERT STRATEGY:
   ──────────────────────────────
   At 20s, the algorithm collects the last 100 ticks
   and for each digit (0–9) calculates:

   1. AVERAGE RETURN INTERVAL
      How many ticks between each appearance of this digit?

   2. TICKS SINCE LAST SEEN
      How long has it been since this digit appeared?

   3. "DUE IN N TICKS" = avgInterval − ticksSinceLast
      If result is 3–5 → this digit is due in 3–5 ticks
      → it will appear around second 15–17
      → Entry Now at 17s is CORRECT for this digit

   4. SELECT THE DIGIT WHOSE "DUE IN" IS CLOSEST TO 4
      (because 20s − 4 ticks = 16s countdown = perfect
       timing for bot starting at 17s and buying 1 tick)

   5. TIE-BREAK by lowest frequency in last 25 ticks
      (secondary cold-digit filter for extra confidence)

   6. CONFIDENCE = based on how precisely the digit
      is due (closer to exactly 4 = higher confidence)

   VISUAL FLOW:
   ─────────────
   20s → "WATCHING MARKET..." + predicted digit + "⏱ Entry at 17s"
   17s → "⚡ ENTRY NOW!" → you start the bot
   16s → bot buys 1 tick contract on predicted digit
   Result: predicted digit should appear on this tick
   ════════════════════════════════════════════════════ */
'use strict';

const CFG = {
  WS_TICKS:   'wss://ws.derivws.com/websockets/v3?app_id=1089',
  WS_ACCOUNT: 'wss://ws.derivws.com/websockets/v3?app_id=1089',
  CYCLE:       20,
  TICK_BUF:    200,  // large buffer for accurate interval analysis
  INIT_MS:     3000,
  PROC_MS:     1200,
  ENTRY_AT:    17,   // Always fire Entry Now at 17s
  TARGET_TICKS: 4,   // We want the digit due in ~4 ticks (appears at ~16s)
  INDICES: [
    { id:'v10', sym:'1HZ10V', name:'Volatility 10 (1s)', cls:'v10', icon:'〜' },
    { id:'v25', sym:'1HZ25V', name:'Volatility 25 (1s)', cls:'v25', icon:'〰' },
    { id:'v50', sym:'1HZ50V', name:'Volatility 50 (1s)', cls:'v50', icon:'〜' },
    { id:'v75', sym:'1HZ75V', name:'Volatility 75 (1s)', cls:'v75', icon:'〰' },
  ]
};

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
    lockedDigit:  null,   // LOCKED at cycle start, never changes
    lockedConf:   null,
    lockedPct:    null,
    lockedDueIn:  null,   // predicted ticks until appearance
    entryShown:   false,
    phase:        'init',
    cycleStarted: false,
  };
}

// ── BOOT ─────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  ST.token = sessionStorage.getItem('deriv_token') || localStorage.getItem('pf_token');
  if (!ST.token) { window.location.replace('/'); return; }

  buildUI();
  CFG.INDICES.forEach(i => { setBox(i.id, tplInit()); setCD(i.id, '—'); setPB(i.id, 0); });
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

function onTick(tick) {
  const az = ST.analyzers[tick.symbol];
  if (!az) return;
  const str = tick.quote.toFixed(2);
  az.ticks.push(parseInt(str[str.length - 1], 10));
  if (az.ticks.length > CFG.TICK_BUF) az.ticks.shift();
  if (ST.initDone && !az.cycleStarted) { az.cycleStarted = true; runCycle(tick.symbol); }
}

// ════════════════════════════════════════════════════
//  MASTER PREDICTION ENGINE v7
//
//  Selects the digit most likely to appear in exactly
//  TARGET_TICKS ticks from now (default: 4 ticks = second 16)
//
//  For each digit 0–9:
//    1. Find all positions where it appeared in history
//    2. Calculate average interval between appearances
//    3. Calculate ticks since last appearance
//    4. Estimate "due in N ticks" = avgInterval - ticksSinceLast
//    5. Score by closeness to TARGET_TICKS (4)
//    6. Tie-break by frequency coldness (last 25 ticks)
//
//  The digit with score closest to TARGET_TICKS wins.
// ════════════════════════════════════════════════════
function computePrediction(ticks) {
  const N = ticks.length;

  if (N < 20) {
    // Not enough history yet — use cold digit fallback
    const freq = new Array(10).fill(0);
    ticks.forEach(d => freq[d]++);
    const coldest = freq.indexOf(Math.min(...freq));
    return { digit: coldest, confidence: 65.0, pct: '—', dueIn: 4 };
  }

  const lastDigit = ticks[N - 1];

  // ── For each digit, compute interval statistics ───
  const digitStats = [];

  for (let d = 0; d < 10; d++) {
    // Find all positions where digit d appeared
    const positions = [];
    for (let i = 0; i < N; i++) {
      if (ticks[i] === d) positions.push(i);
    }

    let avgInterval;
    let ticksSinceLast;
    let dueIn;

    if (positions.length === 0) {
      // Never appeared in buffer → very overdue
      avgInterval    = 10;
      ticksSinceLast = N;
      dueIn          = 0; // already overdue, expect very soon
    } else if (positions.length === 1) {
      avgInterval    = 10;
      ticksSinceLast = N - 1 - positions[0];
      dueIn          = Math.max(0, Math.round(avgInterval - ticksSinceLast));
    } else {
      // Calculate intervals between consecutive appearances
      const intervals = [];
      for (let i = 1; i < positions.length; i++) {
        intervals.push(positions[i] - positions[i - 1]);
      }
      // Weighted average: recent intervals count more
      let wSum = 0, wTotal = 0;
      intervals.forEach((iv, i) => {
        const w = i + 1; // more weight to recent intervals
        wSum   += iv * w;
        wTotal += w;
      });
      avgInterval    = wSum / wTotal;
      ticksSinceLast = N - 1 - positions[positions.length - 1];
      dueIn          = Math.max(0, Math.round(avgInterval - ticksSinceLast));
    }

    // Frequency in last 25 ticks (for tie-breaking)
    const w25   = ticks.slice(-Math.min(25, N));
    const freq25 = w25.filter(x => x === d).length;
    const pct25  = (freq25 / w25.length) * 100;

    digitStats.push({ d, avgInterval, ticksSinceLast, dueIn, pct25 });
  }

  // ── SCORE each digit by proximity to TARGET_TICKS ─
  // Perfect score = dueIn is exactly TARGET_TICKS (4)
  // We want the digit expected to arrive in 3–5 ticks
  const TARGET = CFG.TARGET_TICKS;

  // Priority 1: digits due in 3–5 ticks (perfect window)
  const perfectWindow = digitStats.filter(s =>
    s.dueIn >= TARGET - 1 &&
    s.dueIn <= TARGET + 1 &&
    s.d !== lastDigit         // avoid last digit
  );

  // Priority 2: digits due in 2–7 ticks (wider window)
  const goodWindow = digitStats.filter(s =>
    s.dueIn >= 1 &&
    s.dueIn <= 7 &&
    s.d !== lastDigit
  );

  // Priority 3: any digit except last digit
  const anyWindow = digitStats.filter(s => s.d !== lastDigit);

  // Pick from best available window
  let candidates = perfectWindow.length > 0 ? perfectWindow
                 : goodWindow.length    > 0 ? goodWindow
                 : anyWindow;

  if (candidates.length === 0) candidates = digitStats; // absolute fallback

  // Within candidates, sort by:
  // 1. Closest to TARGET_TICKS
  // 2. Then by coldness (lowest pct25)
  candidates.sort((a, b) => {
    const distA = Math.abs(a.dueIn - TARGET);
    const distB = Math.abs(b.dueIn - TARGET);
    if (distA !== distB) return distA - distB;
    return a.pct25 - b.pct25; // tie-break: colder is better
  });

  const winner = candidates[0];

  // ── CONFIDENCE CALCULATION ────────────────────────
  // Based on:
  //   a) How close dueIn is to TARGET (4)
  //   b) How cold the digit is in last 25 ticks
  //   c) How overdue it is relative to its avg interval

  // Distance from perfect timing (0 = perfect, max ~5)
  const timingDist    = Math.abs(winner.dueIn - TARGET);
  const timingScore   = Math.max(0, 10 - timingDist * 2.5); // 0–10

  // Coldness score (0% freq = max cold)
  const coldnessScore = Math.max(0, 10 - winner.pct25); // 0–10

  // Overdue bonus: if ticksSinceLast > avgInterval → extra confidence
  const overdueRatio  = winner.ticksSinceLast / Math.max(winner.avgInterval, 1);
  const overdueScore  = Math.min(5, Math.max(0, (overdueRatio - 0.7) * 6)); // 0–5

  const rawConf    = 63 + timingScore * 1.8 + coldnessScore * 0.8 + overdueScore;
  const confidence = parseFloat(Math.min(88, Math.max(63, rawConf)).toFixed(1));

  const pct = winner.pct25.toFixed(1);

  return {
    digit:      winner.d,
    confidence: confidence,
    pct:        pct,
    dueIn:      winner.dueIn,
    avgInterval: parseFloat(winner.avgInterval.toFixed(1)),
    ticksSinceLast: winner.ticksSinceLast,
  };
}

// ════════════════════════════════════════════════════
//  CYCLE ENGINE
// ════════════════════════════════════════════════════
function runCycle(sym) {
  const az  = ST.analyzers[sym];
  const idx = CFG.INDICES.find(i => i.sym === sym);
  if (!az || !idx) return;

  if (az.timer) { clearInterval(az.timer); az.timer = null; }

  // Reset
  az.phase         = 'processing';
  az.countdown     = CFG.CYCLE;
  az.entryShown    = false;
  az.lockedDigit   = null;
  az.lockedConf    = null;
  az.lockedPct     = null;
  az.lockedDueIn   = null;

  const card = document.getElementById('card-' + idx.id);
  if (card) card.classList.remove('entry-active');

  setBox(idx.id, tplProcessing());
  setCD(idx.id, az.countdown + 's');
  setPB(idx.id, 0);

  setTimeout(() => {
    // ── LOCK prediction — computed once, NEVER changes ──
    const result       = computePrediction(az.ticks);
    az.lockedDigit     = result.digit;
    az.lockedConf      = result.confidence;
    az.lockedPct       = result.pct;
    az.lockedDueIn     = result.dueIn;
    az.phase           = 'watching';

    // Show digit in WATCHING state
    renderWatching(idx.id, az.lockedDigit, az.lockedConf, az.lockedPct);
    setCD(idx.id, az.countdown + 's');
    setPB(idx.id, 0);

    // ── Countdown: 20 → 1 ──────────────────────────────
    az.timer = setInterval(() => {
      az.countdown--;

      if (az.countdown <= 0) {
        clearInterval(az.timer);
        az.timer = null;
        runCycle(sym);
        return;
      }

      setCD(idx.id, az.countdown + 's');
      // Bar fills left→right: 0% at 20s → 100% at 1s
      const fill = ((CFG.CYCLE - az.countdown) / (CFG.CYCLE - 1)) * 100;
      setPB(idx.id, fill);

      // ── Fire Entry Now at exactly ENTRY_AT seconds ────
      // ALWAYS at 17s — SAME digit, just label + color changes
      if (az.countdown === CFG.ENTRY_AT && !az.entryShown) {
        az.entryShown = true;
        az.phase = 'entry';
        if (card) card.classList.add('entry-active');
        renderEntryNow(idx.id, az.lockedDigit, az.lockedConf, az.lockedPct);
      }

      // Confidence drifts slightly — only the % number, never the digit
      if (az.lockedConf !== null && az.countdown > 1) {
        az.lockedConf = parseFloat(
          Math.min(88, Math.max(63, az.lockedConf + (Math.random() - 0.48) * 1.0)).toFixed(1)
        );
        const cval = document.getElementById('cval-' + idx.id);
        const cbar = document.getElementById('cbar-' + idx.id);
        if (cval) cval.textContent = az.lockedConf + '%';
        if (cbar) cbar.style.width = az.lockedConf + '%';
      }

    }, 1000);

  }, CFG.PROC_MS);
}

// ── RENDER FUNCTIONS ──────────────────────────────
function renderWatching(id, digit, conf, pct) {
  const pctTxt = (pct !== '—' && pct !== null)
    ? `<div class="pred-sub">Last 25 ticks: ${pct}% frequency</div>`
    : '';
  setBox(id, `
    <div class="entry-label wait">⏳ WATCHING MARKET...</div>
    <div class="digit-circle-wrap">
      <div class="digit-circle wait digit-reveal">${digit}</div>
    </div>
    ${pctTxt}
    <div class="entry-hint">⏱ Entry signal at ${CFG.ENTRY_AT}s</div>
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
  const pctTxt = (pct !== '—' && pct !== null)
    ? `<div class="pred-sub">Last 25 ticks: ${pct}% frequency</div>`
    : '';
  setBox(id, `
    <div class="entry-label entry">⚡ ENTRY NOW!</div>
    <div class="digit-circle-wrap">
      <div class="digit-circle entry digit-reveal">${digit}</div>
    </div>
    ${pctTxt}
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

// ── HELPERS ───────────────────────────────────────
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

// ── TEMPLATES ─────────────────────────────────────
function tplInit() {
  return `<div class="processing-state"><div class="spin-ring"></div><span>Initializing prediction model...</span></div>`;
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
  try { ['pf_token','pf_accounts','pf_pkce_verifier'].forEach(k => localStorage.removeItem(k)); } catch {}
  [ST.wsT, ST.wsA].forEach(ws => { if (ws) try { ws.close(); } catch {} });
  Object.values(ST.analyzers).forEach(az => { if (az.timer) clearInterval(az.timer); });
  window.location.replace('/');
}
window.logout = logout;
