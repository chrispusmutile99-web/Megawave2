import React, { useState, useEffect, useRef, useCallback } from "react";
import { RefreshCw, User, BarChart3, ChevronDown, Play, Square } from "lucide-react";
import { isLiveConfigured } from "./lib/derivApi";

// ─────────────────────────────────────────────────────────────────────────
// SIMULATION MODE: everything below runs on fake data (random-walk ticks,
// simulated win/loss). When we go live, useTickFeed's random walk gets
// replaced with subscribeToTicks() from ./lib/derivApi, and the win/loss
// math in the bot + manual trade handlers gets replaced with real
// getProposal()/buyContract() calls. Search this file for "SIMULATED" to
// find every spot that needs to change.
// ─────────────────────────────────────────────────────────────────────────

const DERIV_LOGIN_URL = "https://oauth.deriv.com/oauth2/authorize?app_id=34hTH0v223shdj971TKtV&l=EN&brand=deriv";

const INDICES = [
  
  { id: "v10", name: "Volatility 10 Index", base: 8739.22 },
  { id: "v10s", name: "Volatility 10 (1s)", base: 8422.05 },
  { id: "v25", name: "Volatility 25 Index", base: 3011.4 },
  { id: "v25s", name: "Volatility 25 (1s)", base: 2984.7 },
  { id: "v50", name: "Volatility 50 Index", base: 15120.9 },
  { id: "v75", name: "Volatility 75 Index", base: 91480.3 },
  { id: "v75s", name: "Volatility 75 (1s)", base: 90210.6 },
  { id: "v100", name: "Volatility 100 Index", base: 6120.15 },
];

const STRATEGIES = ["Even / Odd", "Matches / Differs", "Over / Under", "Higher / Lower", "Rise / Fall"];
const DIGIT_STRATEGIES = ["Matches / Differs", "Over / Under"];

function stdDev(arr) {
  if (arr.length < 2) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance = arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
}

// Combine multiple weighted factors into one probability + a readable breakdown.
function combine(factors) {
  const totalWeight = factors.reduce((s, f) => s + f.weight, 0) || 1;
  const score = factors.reduce((s, f) => s + f.value * f.weight, 0) / totalWeight;
  return score;
}

function computeSignal(strategy, subType, predictionDigit, digitCounts, digitHistory, feed) {
  const total = digitCounts.reduce((a, b) => a + b, 0) || 1;
  const recent = digitHistory.slice(-20);
  const recentTotal = recent.length || 1;

  if (strategy === "Even / Odd") {
    const evenCount = [0, 2, 4, 6, 8].reduce((s, d) => s + digitCounts[d], 0);
    const overallEvenPct = evenCount / total;
    const recentEvenCount = recent.filter((d) => d % 2 === 0).length;
    const recentEvenPct = recentEvenCount / recentTotal;

    const combined = combine([
      { value: overallEvenPct, weight: 0.4 },
      { value: recentEvenPct, weight: 0.6 },
    ]);
    const pick = combined >= 0.5 ? "Even" : "Odd";
    const prob = Math.max(combined, 1 - combined);
    return {
      pick,
      prob,
      factors: [
        { label: "Overall bias", detail: `${fmtPct(overallEvenPct)} even` },
        { label: "Recent 20 ticks", detail: `${fmtPct(recentEvenPct)} even` },
      ],
    };
  }

  if (strategy === "Matches / Differs") {
    const overallMatchPct = digitCounts[predictionDigit] / total;
    const recentMatchCount = recent.filter((d) => d === predictionDigit).length;
    const recentMatchPct = recentMatchCount / recentTotal;
    // streak-reversion nudge: if the digit hit very recently, differ becomes slightly favored
    const justHit = digitHistory.slice(-3).includes(predictionDigit);

    const combinedMatch = combine([
      { value: overallMatchPct, weight: 0.55 },
      { value: recentMatchPct, weight: 0.45 },
    ]);
    let differPct = 1 - combinedMatch;
    if (justHit) differPct = Math.min(0.95, differPct + 0.04);
    const pick = differPct >= 0.5 ? "Differs" : "Matches";
    return {
      pick,
      prob: Math.max(differPct, 1 - differPct),
      factors: [
        { label: "Digit frequency", detail: `${fmtPct(overallMatchPct)} match rate` },
        { label: "Recent streak", detail: justHit ? "hit in last 3 ticks" : "no recent hit" },
      ],
    };
  }

  if (strategy === "Over / Under") {
    let overCount = 0;
    let underCount = 0;
    digitCounts.forEach((c, d) => {
      if (d > predictionDigit) overCount += c;
      if (d < predictionDigit) underCount += c;
    });
    const denom = overCount + underCount || 1;
    const overallOverPct = overCount / denom;

    let recentOver = 0;
    let recentUnder = 0;
    recent.forEach((d) => {
      if (d > predictionDigit) recentOver++;
      if (d < predictionDigit) recentUnder++;
    });
    const recentDenom = recentOver + recentUnder || 1;
    const recentOverPct = recentOver / recentDenom;

    const combined = combine([
      { value: overallOverPct, weight: 0.6 },
      { value: recentOverPct, weight: 0.4 },
    ]);
    const pick = combined >= 0.5 ? "Over" : "Under";
    return {
      pick,
      prob: Math.max(combined, 1 - combined),
      factors: [
        { label: "Overall split", detail: `${fmtPct(overallOverPct)} over` },
        { label: "Recent 20 ticks", detail: `${fmtPct(recentOverPct)} over` },
      ],
    };
  }

  // Higher/Lower and Rise/Fall: momentum + volatility read
  const shortSample = feed.slice(-12);
  const longSample = feed.slice(-40);
  const upRatio = (sample) => {
    let ups = 0;
    for (let i = 1; i < sample.length; i++) if (sample[i] >= sample[i - 1]) ups++;
    return sample.length > 1 ? ups / (sample.length - 1) : 0.5;
  };
  const shortUpPct = upRatio(shortSample);
  const longUpPct = upRatio(longSample);
  const vol = stdDev(longSample.length > 2 ? longSample : shortSample);
  const meanPrice = (longSample.reduce((a, b) => a + b, 0) / (longSample.length || 1)) || 1;
  const volRatio = vol / Math.abs(meanPrice || 1); // relative volatility

  let combined = combine([
    { value: shortUpPct, weight: 0.65 },
    { value: longUpPct, weight: 0.35 },
  ]);
  // high relative volatility = choppier market = pull probability toward 0.5 (less confident)
  const noisePenalty = Math.min(0.15, volRatio * 400);
  combined = combined >= 0.5 ? combined - noisePenalty : combined + noisePenalty;

  const volLabel = volRatio > 0.0006 ? "High" : volRatio > 0.0002 ? "Moderate" : "Low";
  const factors = [
    { label: "Short-term momentum (12 ticks)", detail: `${fmtPct(shortUpPct)} up` },
    { label: "Longer trend (40 ticks)", detail: `${fmtPct(longUpPct)} up` },
    { label: "Volatility", detail: `${volLabel}` },
  ];

  if (strategy === "Rise / Fall") {
    const pick = combined >= 0.5 ? "Rise" : "Fall";
    return { pick, prob: Math.max(combined, 1 - combined), factors };
  }
  const pick = combined >= 0.5 ? "Higher" : "Lower";
  return { pick, prob: Math.max(combined, 1 - combined), factors };
}

function fmtPct(p) {
  return `${(p * 100).toFixed(0)}%`;
}

// Real, math-based odds for a manual trade — independent of the AI's read,
// since a manual trade is the user's own pick, not the bot's signal.
function trueProbability(strategy, subType, predictionDigit) {
  if (strategy === "Even / Odd") return 0.5;
  if (strategy === "Matches / Differs") {
    return subType === "Matches" ? 0.1 : 0.9;
  }
  if (strategy === "Over / Under") {
    const digitsAbove = 9 - predictionDigit;
    const digitsBelow = predictionDigit;
    const p = subType === "Over" ? digitsAbove / 9 : digitsBelow / 9;
    return Math.min(0.95, Math.max(0.05, p));
  }
  // Higher/Lower, Rise/Fall — roughly fair, small spread baked into payout instead
  return 0.5;
}

function payoutForProbability(stake, prob) {
  const raw = stake * (0.95 / Math.max(0.05, prob));
  return Math.min(raw, stake * 18); // cap absurd multipliers for realism
}

function fmt(n, d = 2) {
  return n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
}

// SIMULATED — replace with a hook that calls subscribeToTicks() from
// ./lib/derivApi and appends real ticks to state instead of random ones.
function useTickFeed(base) {
  const [history, setHistory] = useState(() => {
    let p = base;
    const arr = [];
    for (let i = 0; i < 40; i++) {
      p += (Math.random() - 0.5) * (base * 0.00004);
      arr.push(p);
    }
    return arr;
  });
  const priceRef = useRef(history[history.length - 1]);

  useEffect(() => {
    priceRef.current = base;
    setHistory((h) => {
      let p = base;
      const arr = [];
      for (let i = 0; i < 40; i++) {
        p += (Math.random() - 0.5) * (base * 0.00004);
        arr.push(p);
      }
      return arr;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base]);

  useEffect(() => {
    const id = setInterval(() => {
      priceRef.current += (Math.random() - 0.5) * (base * 0.00005);
      setHistory((h) => [...h.slice(-59), priceRef.current]);
    }, 900);
    return () => clearInterval(id);
  }, [base]);

  return history;
}

function Sparkline({ data, up }) {
  if (data.length < 2) return null;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const w = 640;
  const h = 260;
  const pad = 10;
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * (w - pad * 2) + pad;
    const y = h - pad - ((v - min) / range) * (h - pad * 2);
    return [x, y];
  });
  const path = pts.map((p, i) => (i === 0 ? `M${p[0]},${p[1]}` : `L${p[0]},${p[1]}`)).join(" ");
  const areaPath = `${path} L${pts[pts.length - 1][0]},${h} L${pts[0][0]},${h} Z`;
  const stroke = up ? "#16a34a" : "#4338ca";
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-full" preserveAspectRatio="none">
      <defs>
        <linearGradient id="fillgrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.18" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={areaPath} fill="url(#fillgrad)" stroke="none" />
      <path d={path} fill="none" stroke={stroke} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
export default function MegaWaveDemo() {
  const [tab, setTab] = useState("trade");
  const [engineMode, setEngineMode] = useState("bot");
  const [live, setLive] = useState(true);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [balance, setBalance] = useState(10000.0);
  const [stake, setStake] = useState(10);
  const [strategy, setStrategy] = useState(STRATEGIES[0]);
  const [strategyOpen, setStrategyOpen] = useState(false);
  const [takeProfit, setTakeProfit] = useState(500);
  const [stopLoss, setStopLoss] = useState(100);
  const [martingale, setMartingale] = useState(2.1);
  const [predictionDigit, setPredictionDigit] = useState(5);
  const [subType, setSubType] = useState("Differs");
  const [botRunning, setBotRunning] = useState(false);
  const [botMsg, setBotMsg] = useState("Bot stopped.");
  const [sessionPL, setSessionPL] = useState(0);
  const [signal, setSignal] = useState({ pick: "Even", prob: 0.5 });
  const [botPhase, setBotPhase] = useState("idle"); // idle | analyzing | executing
  const [lastDigits, setLastDigits] = useState(() => Array(10).fill(10));
  const [digitCounts, setDigitCounts] = useState(() => Array(10).fill(0));
  const [history, setHistory] = useState([]);
  const tickCountRef = useRef(0);
  const currentStakeRef = useRef(stake);
  const digitCountsRef = useRef(digitCounts);
  const digitHistoryRef = useRef([]);
  const feedRef = useRef([]);
  const winCountRef = useRef(0);
  const lossCountRef = useRef(0);
  const [accuracy, setAccuracy] = useState({ wins: 0, losses: 0 });

  // Manual trading state
  const [manualStrategy, setManualStrategy] = useState(STRATEGIES[0]);
  const [manualStrategyOpen, setManualStrategyOpen] = useState(false);
  const [manualSubType, setManualSubType] = useState("Even");
  const [manualPredictionDigit, setManualPredictionDigit] = useState(5);
  const [manualStake, setManualStake] = useState(10);
  const [manualDuration, setManualDuration] = useState(5);
  const [manualStatus, setManualStatus] = useState("idle"); // idle | running | won | lost
  const [manualResult, setManualResult] = useState(null);
  const manualTimerRef = useRef(null);

  useEffect(() => {
    if (manualStrategy === "Matches / Differs") setManualSubType("Matches");
    else if (manualStrategy === "Over / Under") setManualSubType("Over");
    else if (manualStrategy === "Higher / Lower") setManualSubType("Higher");
    else if (manualStrategy === "Rise / Fall") setManualSubType("Rise");
    else setManualSubType("Even");
  }, [manualStrategy]);

  const placeManualTrade = (pick) => {
    if (manualStatus === "running") return;
    setManualSubType(pick);
    setManualStatus("running");
    setManualResult(null);
    const prob = trueProbability(manualStrategy, pick, manualPredictionDigit);
    const payout = payoutForProbability(manualStake, prob);
    const durationMs = Math.max(1, manualDuration) * 1000;

    manualTimerRef.current = setTimeout(() => {
      // SIMULATED — replace with getProposal() + buyContract() from ./lib/derivApi,
      // then read the real contract outcome instead of flipping a weighted coin.
      const win = Math.random() < prob;
      setBalance((b) => (win ? b + payout : b - manualStake));
      setSessionPL((pl) => (win ? pl + payout : pl - manualStake));
      setManualStatus(win ? "won" : "lost");
      setManualResult({ win, payout, pick, prob });

      const needsDigit = manualStrategy === "Matches / Differs" || manualStrategy === "Over / Under";
      const singular = { Matches: "MATCH", Differs: "DIFFER" }[pick] || pick.toUpperCase();
      const detailLabel = needsDigit ? `${singular} ${manualPredictionDigit}` : pick.toUpperCase();
      setHistory((h) => [
        {
          id: Math.random().toString(36).slice(2),
          index: index.name,
          type: manualStrategy,
          detail: detailLabel,
          stake: manualStake,
          pl: win ? payout : -manualStake,
          source: "Manual",
        },
        ...h,
      ].slice(0, 30));
    }, durationMs);
  };

  useEffect(() => {
    return () => {
      if (manualTimerRef.current) clearTimeout(manualTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (strategy === "Matches / Differs") setSubType("Differs");
    else if (strategy === "Over / Under") setSubType("Over");
    else if (strategy === "Higher / Lower") setSubType("Higher");
    else if (strategy === "Rise / Fall") setSubType("Rise");
    else setSubType("Even");
  }, [strategy]);

  const index = INDICES[selectedIdx];
  const feed = useTickFeed(index.base);
  useEffect(() => {
    feedRef.current = feed;
  }, [feed]);
  const current = feed[feed.length - 1] ?? index.base;
  const prev = feed[feed.length - 2] ?? current;
  const up = current >= prev;

  // last digit stats derived from feed ticks
  useEffect(() => {
    if (!live) return;
    const last = feed[feed.length - 1];
    if (last == null) return;
    const digit = Math.floor(Math.abs(last) * 100) % 10;
    tickCountRef.current += 1;
    digitHistoryRef.current = [...digitHistoryRef.current.slice(-99), digit];
    setDigitCounts((counts) => {
      const next = [...counts];
      next[digit] += 1;
      digitCountsRef.current = next;
      return next;
    });
  }, [feed, live]);

  const total = digitCounts.reduce((a, b) => a + b, 0) || 1;
  const percents = digitCounts.map((c) => (c / total) * 100);
  const maxPct = Math.max(...percents);
  const minPct = Math.min(...percents.filter((_, i) => digitCounts[i] > 0)) || 0;

  // bot simulation: analyze -> execute -> pause -> repeat
  useEffect(() => {
    if (!botRunning) return;
    currentStakeRef.current = stake;
    let cancelled = false;
    let timer = null;

    const analyzeMessages = [
      "Scanning recent ticks…",
      "Reading last digit distribution…",
      "Checking price momentum…",
      "Weighing strategy odds…",
    ];

    const runCycle = () => {
      if (cancelled) return;
      // 1) Analyze phase
      setBotPhase("analyzing");
      setBotMsg(analyzeMessages[Math.floor(Math.random() * analyzeMessages.length)]);
      const sig = computeSignal(strategy, subType, predictionDigit, digitCountsRef.current, digitHistoryRef.current, feedRef.current);
      setSignal(sig);

      timer = setTimeout(() => {
        if (cancelled) return;
        // 2) Execute phase
        setBotPhase("executing");
        setBotMsg(`Placing ${sig.pick} on ${index.name}…`);

        timer = setTimeout(() => {
          if (cancelled) return;
          // cap kept realistic: confidence never buys a guaranteed edge, house margin stays in
          // SIMULATED — same swap point as the manual trade handler above:
          // real contract purchase + real settlement replaces this.
          const winProb = Math.min(0.75, Math.max(0.25, sig.prob - 0.04));
          const win = Math.random() < winProb;
          const payout = currentStakeRef.current * 0.945;
          const tradeSubType = sig.pick;

          setSessionPL((pl) => (win ? pl + payout : pl - currentStakeRef.current));
          setBalance((b) => (win ? b + payout : b - currentStakeRef.current));

          if (win) winCountRef.current += 1;
          else lossCountRef.current += 1;
          setAccuracy({ wins: winCountRef.current, losses: lossCountRef.current });

          if (win) {
            const p = payout;
            currentStakeRef.current = stake;
            setBotMsg(`Won +$${fmt(p)} · resetting stake`);
          } else {
            const lost = currentStakeRef.current;
            currentStakeRef.current = currentStakeRef.current * martingale;
            setBotMsg(`Lost -$${fmt(lost)} · next stake $${fmt(currentStakeRef.current)}`);
          }

          const needsDigit = strategy === "Matches / Differs" || strategy === "Over / Under";
          const singular = { Matches: "MATCH", Differs: "DIFFER" }[tradeSubType] || tradeSubType.toUpperCase();
          const detailLabel = needsDigit ? `${singular} ${predictionDigit}` : tradeSubType.toUpperCase();
          setHistory((h) => [
            {
              id: Math.random().toString(36).slice(2),
              index: index.name,
              type: strategy,
              detail: detailLabel,
              stake,
              pl: win ? payout : -stake,
              source: "Bot",
            },
            ...h,
          ].slice(0, 30));

          setBotPhase("idle");
          // 3) brief pause before next analysis cycle
          timer = setTimeout(runCycle, 1200);
        }, 900);
      }, 1500);
    };

    runCycle();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [botRunning]);

  useEffect(() => {
    if (!botRunning) return;
    if (sessionPL >= takeProfit) {
      setBotRunning(false);
      setBotMsg(`Take profit hit at +$${fmt(sessionPL)}. Bot stopped.`);
    } else if (sessionPL <= -stopLoss) {
      setBotRunning(false);
      setBotMsg(`Stop loss hit at -$${fmt(Math.abs(sessionPL))}. Bot stopped.`);
    }
  }, [sessionPL, botRunning, takeProfit, stopLoss]);

  const startBot = () => {
    setSessionPL(0);
    winCountRef.current = 0;
    lossCountRef.current = 0;
    setAccuracy({ wins: 0, losses: 0 });
    setBotRunning(true);
    setBotMsg("Bot started · scanning ticks…");
  };
  const stopBot = () => {
    setBotRunning(false);
    setBotPhase("idle");
    setBotMsg("Bot stopped.");
  };

  const digitColor = (i) => {
    if (digitCounts[i] === 0) return "bg-slate-50 text-slate-800 ring-slate-100";
    if (percents[i] === maxPct) return "bg-emerald-50 text-emerald-700 ring-emerald-200";
    if (percents[i] === minPct) return "bg-rose-50 text-rose-600 ring-rose-200";
    return "bg-slate-50 text-slate-800 ring-slate-100";
  };

  return (
    <div className="w-full min-h-screen bg-slate-100 flex justify-center font-sans">
      <div className="w-full max-w-md bg-slate-50 min-h-screen flex flex-col">
        {/* Header */}
        <div className="bg-white px-5 pt-5 pb-4 border-b border-slate-100 flex items-center justify-between gap-2 sticky top-0 z-10">
          <div className="text-lg font-extrabold tracking-tight">
            <span className="text-slate-900">MEGA</span>
            <span className="text-indigo-600">WAVE</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setLive((v) => !v)}
              className={`w-11 h-6 rounded-full transition-colors relative ${live ? "bg-slate-900" : "bg-slate-200"}`}
              aria-label="toggle live feed"
            >
              <span
                className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all ${live ? "left-5" : "left-0.5"}`}
              />
            </button>
            <button
              onClick={() => setHistory((h) => h)}
              className="w-9 h-9 rounded-full bg-white ring-1 ring-slate-200 flex items-center justify-center text-slate-600 active:scale-95 transition-transform"
              aria-label="refresh"
            >
              <RefreshCw size={16} />
            </button>
        
        {/* Balance / Stop control */}
<a
  href={DERIV_LOGIN_URL}
  className="h-9 px-3 rounded-full bg-red-600 text-white font-bold ring-1 ring-red-600 flex items-center justify-center text-xs hover:bg-red-700 transition-colors"
>
  Log in with Deriv
</a>
</div>
</div>
    
          {tab === "history" ? (
            <>
              <div className="bg-white rounded-2xl p-5 ring-1 ring-slate-100">
                {botRunning ? (
                <>
                  <div className="text-[11px] font-semibold text-slate-400 tracking-wide mb-1">
                    BOT IS CURRENTLY RUNNING
                  </div>
                  <div className={`text-2xl font-bold mb-3 ${sessionPL >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                    {sessionPL >= 0 ? "+" : "-"}${fmt(Math.abs(sessionPL))}
                    <span className="text-xs font-semibold text-slate-400 ml-1.5">
                      {sessionPL >= 0 ? "gained" : "lost"} this session
                    </span>
                  </div>
                  <button
                    onClick={stopBot}
                    className="w-full py-3.5 rounded-xl bg-rose-600 text-white font-bold text-base flex items-center justify-center gap-2 active:scale-[0.99] transition-transform"
                  >
                    <Square size={16} fill="currentColor" />
                    Stop Trading Bot
                  </button>
                </>
              ) : (
                <div className="text-center py-2">
                  <div className="text-sm font-semibold text-slate-400">Bot is not running</div>
                  <div className="text-xs text-slate-400 mt-1">Start it from the Trade tab.</div>
                  {sessionPL !== 0 && (
                    <div className={`text-sm font-bold mt-2 ${sessionPL >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                      Last session: {sessionPL >= 0 ? "+" : "-"}${fmt(Math.abs(sessionPL))}
                    </div>
                  )}
                </div>
              )}
              </div>

              <div className="bg-white rounded-2xl p-5 ring-1 ring-slate-100">
                <div className="text-[11px] font-semibold text-slate-400 tracking-wide">ACCOUNT BALANCE</div>
                <div className="text-3xl font-bold text-slate-900 mt-1">${fmt(balance)}</div>
                <div className={`text-sm mt-1 font-medium ${sessionPL >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                  {sessionPL >= 0 ? "+" : "-"}${fmt(Math.abs(sessionPL))} {sessionPL >= 0 ? "gained" : "lost"} this session
                </div>
              </div>
            </>
          ) : (
            <div className="bg-white rounded-2xl p-5 ring-1 ring-slate-100">
              <div className="text-[11px] font-semibold text-slate-400 tracking-wide">ACCOUNT BALANCE</div>
              <div className="text-3xl font-bold text-slate-900 mt-1">${fmt(balance)}</div>
              <div className={`text-sm mt-1 font-medium ${sessionPL >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                {sessionPL >= 0 ? "+" : "-"}${fmt(Math.abs(sessionPL))} this session
              </div>
            </div>
          )}
        </div>
        {tab === "trade" && (
          <>
            {/* Index tabs */}
            <div className="px-5 pt-5">
              <div className="text-[11px] font-semibold text-slate-400 tracking-wide mb-2">DERIV VOLATILITY INDICES</div>
              <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1 scrollbar-none">
                {INDICES.map((idx, i) => (
                  <button
                    key={idx.id}
                    onClick={() => setSelectedIdx(i)}
                    className={`shrink-0 px-4 py-2 rounded-full text-sm font-semibold whitespace-nowrap transition-colors ${
                      i === selectedIdx ? "bg-slate-900 text-white" : "bg-white text-slate-600 ring-1 ring-slate-200"
                    }`}
                  >
                    {idx.name}
                  </button>
                ))}
              </div>
            </div>

            {/* Chart */}
            <div className="px-5 pt-4">
              <div className="bg-white rounded-2xl p-5 ring-1 ring-slate-100">
                <div className="flex items-center justify-between mb-3">
                  <div className="font-bold text-slate-900">{index.name}</div>
                  <div className={`font-bold ${up ? "text-emerald-600" : "text-indigo-600"}`}>{fmt(current)}</div>
                </div>
                <div className="h-40">
                  <Sparkline data={feed} up={up} />
                </div>
              </div>
            </div>

            {/* Last digit stats */}
            <div className="px-5 pt-4">
              <div className="bg-white rounded-2xl p-5 ring-1 ring-slate-100">
                <div className="text-[11px] font-semibold text-slate-400 tracking-wide mb-3">LAST DIGIT STATS (0-9)</div>
                <div className="grid grid-cols-5 gap-2.5">
                  {digitCounts.map((_, i) => (
                    <div
                      key={i}
                      className={`aspect-square rounded-full ring-1 flex flex-col items-center justify-center ${digitColor(i)}`}
                    >
                      <div className="text-base font-bold">{i}</div>
                      <div className="text-[10px] font-medium opacity-80">{fmt(percents[i], 1)}%</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Trading engine */}
            <div className="px-5 pt-4 pb-6">
              <div className="bg-white rounded-2xl p-5 ring-1 ring-slate-100">
                <div className="flex items-center justify-between mb-4">
                  <div className="font-bold text-slate-900 text-lg">Trading Engine</div>
                  <div className="flex items-center gap-1.5 bg-indigo-50 text-indigo-600 text-xs font-bold px-2.5 py-1 rounded-full">
                    <span className={`w-1.5 h-1.5 rounded-full ${botRunning ? "bg-emerald-500 animate-pulse" : "bg-indigo-400"}`} />
                    {botRunning ? "LIVE" : "IDLE"}
                  </div>
                </div>

                <div className="flex bg-slate-100 rounded-xl p-1 mb-4">
                  <button
                    onClick={() => setEngineMode("bot")}
                    className={`flex-1 py-2 rounded-lg text-sm font-semibold transition-colors ${
                      engineMode === "bot" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"
                    }`}
                  >
                    AI Bot
                  </button>
                  <button
                    onClick={() => setEngineMode("manual")}
                    className={`flex-1 py-2 rounded-lg text-sm font-semibold transition-colors ${
                      engineMode === "manual" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"
                    }`}
                  >
                    Manual
                  </button>
                </div>

                {engineMode === "bot" ? (
                  <>
                    <div className="bg-slate-50 rounded-xl p-5 mb-4 text-center">
                      <div className="text-sm font-semibold text-slate-500 mb-2">{index.name}</div>
                      <div className="text-2xl font-bold text-slate-800 mb-2">
                        {botRunning ? fmt(current) : "—"}
                      </div>
                      <div className="text-sm text-indigo-600 font-medium flex items-center justify-center gap-2">
                        {botPhase === "analyzing" && (
                          <span className="flex gap-0.5">
                            <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 animate-bounce [animation-delay:-0.3s]" />
                            <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 animate-bounce [animation-delay:-0.15s]" />
                            <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 animate-bounce" />
                          </span>
                        )}
                        {botPhase === "executing" && (
                          <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
                        )}
                        {botMsg}
                      </div>
                      {botRunning && (
                        <div className="mt-3 pt-3 border-t border-slate-200">
                          <div className="flex items-center justify-center gap-4 text-xs mb-2">
                            <div className="text-slate-500">
                              AI signal: <span className="font-bold text-slate-800">{signal.pick}</span>
                            </div>
                            <div className="text-slate-500">
                              Confidence: <span className="font-bold text-slate-800">{fmt(signal.prob * 100, 1)}%</span>
                            </div>
                          </div>
                          {signal.factors && signal.factors.length > 0 && (
                            <div className="space-y-1 mb-2">
                              {signal.factors.map((f, i) => (
                                <div key={i} className="flex items-center justify-between text-[11px] text-slate-400">
                                  <span>{f.label}</span>
                                  <span className="font-semibold text-slate-600">{f.detail}</span>
                                </div>
                              ))}
                            </div>
                          )}
                          {(accuracy.wins + accuracy.losses) > 0 && (
                            <div className="text-[11px] text-slate-500 pt-2 border-t border-slate-100">
                              Session accuracy:{" "}
                              <span className="font-bold text-slate-800">
                                {fmt((accuracy.wins / (accuracy.wins + accuracy.losses)) * 100, 1)}%
                              </span>{" "}
                              <span className="text-slate-400">
                                ({accuracy.wins}W / {accuracy.losses}L)
                              </span>
                            </div>
                          )}
                        </div>
                      )}
                    </div>

                    <label className="block bg-slate-50 rounded-xl p-4 mb-3">
                      <div className="text-[11px] font-semibold text-slate-400 tracking-wide mb-1">
                        STAKE ($) <span className="text-indigo-500 font-medium normal-case">(Minimum stake 0.35)</span>
                      </div>
                      <input
                        type="number"
                        value={stake}
                        onChange={(e) => setStake(Math.max(0.35, Number(e.target.value)))}
                        disabled={botRunning}
                        className="w-full bg-transparent text-xl font-bold text-slate-900 outline-none disabled:opacity-60"
                      />
                    </label>

                    <div className="relative mb-3">
                      <button
                        onClick={() => setStrategyOpen((v) => !v)}
                        disabled={botRunning}
                        className="w-full text-left bg-slate-50 rounded-xl p-4 disabled:opacity-60"
                      >
                        <div className="text-[11px] font-semibold text-slate-400 tracking-wide mb-1">STRATEGY</div>
                        <div className="flex items-center justify-between">
                          <span className="text-lg font-bold text-slate-900">{strategy}</span>
                          <ChevronDown size={18} className="text-slate-400" />
                        </div>
                      </button>
                      {strategyOpen && (
                        <div className="absolute left-0 right-0 mt-1 bg-white rounded-xl ring-1 ring-slate-200 shadow-lg overflow-hidden z-20">
                          {STRATEGIES.map((s) => (
                            <button
                              key={s}
                              onClick={() => {
                                setStrategy(s);
                                setStrategyOpen(false);
                              }}
                              className={`w-full text-left px-4 py-3 text-sm font-medium hover:bg-slate-50 ${
                                s === strategy ? "text-indigo-600" : "text-slate-700"
                              }`}
                            >
                              {s}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>

                    {(strategy === "Matches / Differs" || strategy === "Over / Under" || strategy === "Higher / Lower" || strategy === "Rise / Fall") && (
                      <div className="grid grid-cols-2 gap-3 mb-3">
                        <div className="bg-slate-50 rounded-xl p-4">
                          <div className="text-[11px] font-semibold text-slate-400 tracking-wide mb-1">
                            {strategy === "Matches / Differs" && "PREDICTION"}
                            {strategy === "Over / Under" && "CONDITION"}
                            {strategy === "Higher / Lower" && "DIRECTION"}
                            {strategy === "Rise / Fall" && "DIRECTION"}
                          </div>
                          <div className="flex bg-white rounded-lg p-1 ring-1 ring-slate-200">
                            {(strategy === "Matches / Differs" ? ["Matches", "Differs"] :
                              strategy === "Over / Under" ? ["Over", "Under"] :
                              strategy === "Higher / Lower" ? ["Higher", "Lower"] :
                              ["Rise", "Fall"]
                            ).map((opt) => (
                              <button
                                key={opt}
                                onClick={() => setSubType(opt)}
                                disabled={botRunning}
                                className={`flex-1 py-1.5 rounded-md text-xs font-bold transition-colors disabled:opacity-60 ${
                                  subType === opt ? "bg-indigo-600 text-white" : "text-slate-500"
                                }`}
                              >
                                {opt}
                              </button>
                            ))}
                          </div>
                        </div>
                        {(strategy === "Matches / Differs" || strategy === "Over / Under") && (
                          <label className="block bg-slate-50 rounded-xl p-4">
                            <div className="text-[11px] font-semibold text-slate-400 tracking-wide mb-1">
                              {strategy === "Matches / Differs" ? "DIGIT" : "BARRIER"}
                            </div>
                            <input
                              type="number"
                              min={0}
                              max={9}
                              value={predictionDigit}
                              onChange={(e) => setPredictionDigit(Math.min(9, Math.max(0, Number(e.target.value))))}
                              disabled={botRunning}
                              className="w-full bg-transparent text-lg font-bold text-slate-900 outline-none disabled:opacity-60"
                            />
                          </label>
                        )}
                      </div>
                    )}

                    <div className="grid grid-cols-2 gap-3 mb-3">
                      <label className="block bg-slate-50 rounded-xl p-4">
                        <div className="text-[11px] font-semibold text-slate-400 tracking-wide mb-1">TAKE PROFIT ($)</div>
                        <input
                          type="number"
                          value={takeProfit}
                          onChange={(e) => setTakeProfit(Number(e.target.value))}
                          disabled={botRunning}
                          className="w-full bg-transparent text-lg font-bold text-slate-900 outline-none disabled:opacity-60"
                        />
                      </label>
                      <label className="block bg-slate-50 rounded-xl p-4">
                        <div className="text-[11px] font-semibold text-slate-400 tracking-wide mb-1">STOP LOSS ($)</div>
                        <input
                          type="number"
                          value={stopLoss}
                          onChange={(e) => setStopLoss(Number(e.target.value))}
                          disabled={botRunning}
                          className="w-full bg-transparent text-lg font-bold text-slate-900 outline-none disabled:opacity-60"
                        />
                      </label>
                    </div>

                    <label className="block bg-slate-50 rounded-xl p-4 mb-5">
                      <div className="text-[11px] font-semibold text-slate-400 tracking-wide mb-1">MARTINGALE MULTIPLIER</div>
                      <input
                        type="number"
                        step="0.1"
                        value={martingale}
                        onChange={(e) => setMartingale(Number(e.target.value))}
                        disabled={botRunning}
                        className="w-full bg-transparent text-lg font-bold text-slate-900 outline-none disabled:opacity-60"
                      />
                    </label>

                    {!botRunning ? (
                      <button
                        onClick={startBot}
                        className="w-full py-4 rounded-xl bg-indigo-600 text-white font-bold text-base flex items-center justify-center gap-2 active:scale-[0.99] transition-transform"
                      >
                        <Play size={18} fill="currentColor" />
                        Start Trading Bot
                      </button>
                    ) : (
                      <button
                        onClick={stopBot}
                        className="w-full py-4 rounded-xl bg-rose-600 text-white font-bold text-base flex items-center justify-center gap-2 active:scale-[0.99] transition-transform"
                      >
                        <Square size={16} fill="currentColor" />
                        Stop Trading Bot
                      </button>
                    )}
                    <div className="text-center text-[11px] text-slate-400 mt-3">
                      Simulated demo — no real trades are placed.
                    </div>
                  </>
                ) : (
                  <div className="space-y-3">
                    <div className="bg-slate-50 rounded-xl p-5 text-center">
                      <div className="text-sm font-semibold text-slate-500 mb-2">{index.name}</div>
                      <div className={`text-2xl font-bold mb-2 ${up ? "text-emerald-600" : "text-indigo-600"}`}>
                        {fmt(current)}
                      </div>
                      {manualStatus === "running" && (
                        <div className="text-sm text-amber-600 font-medium flex items-center justify-center gap-2">
                          <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
                          Trade running · {manualDuration}s contract
                        </div>
                      )}
                      {manualStatus === "won" && manualResult && (
                        <div className="text-sm text-emerald-600 font-bold">
                          Won +${fmt(manualResult.payout)}
                        </div>
                      )}
                      {manualStatus === "lost" && manualResult && (
                        <div className="text-sm text-rose-600 font-bold">
                          Lost -${fmt(manualStake)}
                        </div>
                      )}
                      {manualStatus === "idle" && (
                        <div className="text-sm text-slate-400">Pick a direction to place a trade</div>
                      )}
                    </div>

                    <div className="relative">
                      <button
                        onClick={() => setManualStrategyOpen((v) => !v)}
                        disabled={manualStatus === "running"}
                        className="w-full text-left bg-slate-50 rounded-xl p-4 disabled:opacity-60"
                      >
                        <div className="text-[11px] font-semibold text-slate-400 tracking-wide mb-1">STRATEGY</div>
                        <div className="flex items-center justify-between">
                          <span className="text-lg font-bold text-slate-900">{manualStrategy}</span>
                          <ChevronDown size={18} className="text-slate-400" />
                        </div>
                      </button>
                      {manualStrategyOpen && (
                        <div className="absolute left-0 right-0 mt-1 bg-white rounded-xl ring-1 ring-slate-200 shadow-lg overflow-hidden z-20">
                          {STRATEGIES.map((s) => (
                            <button
                              key={s}
                              onClick={() => {
                                setManualStrategy(s);
                                setManualStrategyOpen(false);
                              }}
                              className={`w-full text-left px-4 py-3 text-sm font-medium hover:bg-slate-50 ${
                                s === manualStrategy ? "text-indigo-600" : "text-slate-700"
                              }`}
                            >
                              {s}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <label className="block bg-slate-50 rounded-xl p-4">
                        <div className="text-[11px] font-semibold text-slate-400 tracking-wide mb-1">
                          STAKE ($) <span className="text-indigo-500 font-medium normal-case">min 0.35</span>
                        </div>
                        <input
                          type="number"
                          value={manualStake}
                          onChange={(e) => setManualStake(Math.max(0.35, Number(e.target.value)))}
                          disabled={manualStatus === "running"}
                          className="w-full bg-transparent text-lg font-bold text-slate-900 outline-none disabled:opacity-60"
                        />
                      </label>
                      <label className="block bg-slate-50 rounded-xl p-4">
                        <div className="text-[11px] font-semibold text-slate-400 tracking-wide mb-1">DURATION (TICKS)</div>
                        <input
                          type="number"
                          min={1}
                          max={10}
                          value={manualDuration}
                          onChange={(e) => setManualDuration(Math.min(10, Math.max(1, Number(e.target.value))))}
                          disabled={manualStatus === "running"}
                          className="w-full bg-transparent text-lg font-bold text-slate-900 outline-none disabled:opacity-60"
                        />
                      </label>
                    </div>

                    {(manualStrategy === "Matches / Differs" || manualStrategy === "Over / Under") && (
                      <label className="block bg-slate-50 rounded-xl p-4">
                        <div className="text-[11px] font-semibold text-slate-400 tracking-wide mb-1">
                          {manualStrategy === "Matches / Differs" ? "DIGIT" : "BARRIER"}
                        </div>
                        <input
                          type="number"
                          min={0}
                          max={9}
                          value={manualPredictionDigit}
                          onChange={(e) => setManualPredictionDigit(Math.min(9, Math.max(0, Number(e.target.value))))}
                          disabled={manualStatus === "running"}
                          className="w-full bg-transparent text-lg font-bold text-slate-900 outline-none disabled:opacity-60"
                        />
                      </label>
                    )}

                    <div className="pt-1">
                      <div className="text-[11px] font-semibold text-slate-400 tracking-wide mb-2">
                        PAYOUT PREVIEW
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        {(manualStrategy === "Even / Odd" ? ["Even", "Odd"] :
                          manualStrategy === "Matches / Differs" ? ["Matches", "Differs"] :
                          manualStrategy === "Over / Under" ? ["Over", "Under"] :
                          manualStrategy === "Higher / Lower" ? ["Higher", "Lower"] :
                          ["Rise", "Fall"]
                        ).map((opt) => {
                          const p = trueProbability(manualStrategy, opt, manualPredictionDigit);
                          const payout = payoutForProbability(manualStake, p);
                          const isUp = opt === "Rise" || opt === "Higher" || opt === "Even" || opt === "Over" || opt === "Matches";
                          return (
                            <button
                              key={opt}
                              onClick={() => placeManualTrade(opt)}
                              disabled={manualStatus === "running"}
                              className={`rounded-xl p-4 text-left ring-1 transition-transform active:scale-[0.98] disabled:opacity-50 ${
                                isUp
                                  ? "bg-emerald-50 ring-emerald-200"
                                  : "bg-rose-50 ring-rose-200"
                              }`}
                            >
                              <div className={`text-sm font-bold ${isUp ? "text-emerald-700" : "text-rose-700"}`}>
                                {opt}
                              </div>
                              <div className="text-xs text-slate-500 mt-0.5">Payout ${fmt(payout)}</div>
                              <div className="text-[10px] text-slate-400 mt-0.5">{fmtPct(p)} odds</div>
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    <div className="text-center text-[11px] text-slate-400 pt-1">
                      Simulated demo — odds shown reflect real Deriv contract math.
                    </div>
                  </div>
                )}
              </div>
            </div>
          </>
        )}
        {tab === "history" && (
          <div className="px-5 pt-5 pb-6 flex-1">
            <div className="text-[11px] font-semibold text-slate-400 tracking-wide mb-3">TRADE HISTORY</div>
            {history.length === 0 ? (
              <div className="bg-white rounded-2xl p-8 ring-1 ring-slate-100 text-center text-slate-400 text-sm">
                No trades yet. Start the bot or place a manual trade to see results here.
              </div>
            ) : (
              <div className="space-y-2.5">
                {history.map((h) => (
                  <div key={h.id} className="bg-white rounded-2xl p-4 ring-1 ring-slate-100 flex items-center justify-between">
                    <div>
                      <div className="font-bold text-slate-900 text-sm flex items-center gap-1.5">
                        {h.index}
                        <span
                          className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${
                            h.source === "Manual" ? "bg-slate-100 text-slate-500" : "bg-indigo-50 text-indigo-600"
                          }`}
                        >
                          {h.source === "Manual" ? "MANUAL" : "AI BOT"}
                        </span>
                      </div>
                      <div className="text-xs text-slate-400 mt-0.5">
                        {h.type} | {h.detail} | Stake: ${fmt(h.stake)}
                      </div>
                    </div>
                    <div className={`font-bold ${h.pl >= 0 ? "text-emerald-600" : "text-slate-900"}`}>
                      {h.pl >= 0 ? "+" : ""}${fmt(h.pl)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {tab === "profile" && (
          <div className="px-5 pt-5 pb-6 flex-1">
            <div className="bg-white rounded-2xl p-6 ring-1 ring-slate-100 text-center">
              <div className="w-16 h-16 rounded-full bg-indigo-50 text-indigo-600 flex items-center justify-center mx-auto mb-3">
                <User size={28} />
              </div>
              <div className="font-bold text-slate-900">Demo Account</div>
              <div className="text-sm text-slate-400 mt-1">Trading on a simulated balance</div>
            </div>
          </div>
        )}

        {/* Bottom nav */}
        <div className="mt-auto bg-white border-t border-slate-100 flex items-center justify-around py-3 sticky bottom-0">
          <button onClick={() => setTab("trade")} className={`flex flex-col items-center gap-1 ${tab === "trade" ? "text-indigo-600" : "text-slate-400"}`}>
            <div className={`w-6 h-6 rounded-md ${tab === "trade" ? "bg-indigo-600" : "bg-slate-300"}`} style={{clipPath: "polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%)"}} />
            <span className="text-[11px] font-semibold">Trade</span>
          </button>
          <button onClick={() => setTab("history")} className={`flex flex-col items-center gap-1 ${tab === "history" ? "text-indigo-600" : "text-slate-400"}`}>
            <BarChart3 size={22} />
            <span className="text-[11px] font-semibold">History</span>
          </button>
          <button onClick={() => setTab("profile")} className={`flex flex-col items-center gap-1 ${tab === "profile" ? "text-indigo-600" : "text-slate-400"}`}>
            <User size={22} />
            <span className="text-[11px] font-semibold">Profile</span>
          </button>
        </div>
      </div>
    </div>
  );
}
