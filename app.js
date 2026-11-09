
const BYBIT_URL = "https://api.bybit.com/v5/market";
const WORKER_URL = "https://crimson-sea-06c2.gera8bit.workers.dev";

const SIGNAL_THRESHOLD = 85;
const MAX_LEVERAGE = 10;
const RISK_PER_TRADE = 0.005;
const ANALYSIS_STORAGE_KEY = "mobileTradingAI_previousAnalysis_v2";

const TIMEFRAMES = [
  { label: "5m", interval: "5", duration: 5 * 60 * 1000 },
  { label: "15m", interval: "15", duration: 15 * 60 * 1000 },
  { label: "1h", interval: "60", duration: 60 * 60 * 1000 },
  { label: "4h", interval: "240", duration: 4 * 60 * 60 * 1000 }
];

const ALLOWED_STRATEGIES = [
  "MACD + EMA200",
  "Momentum",
  "Momentum + Funding",
  "Multi-Indicator Confluence",
  "Funding / Cash-and-Carry",
  "Low-Leverage Trend Following",
  "Range Trading",
  "Mean Reversion",
  "Conservative Momentum"
];

const btn = document.getElementById("scanBtn");
const results = document.getElementById("results");
const state = document.getElementById("scanState");
const count = document.getElementById("signalCount");
const modeSelect = document.getElementById("strategyMode");

let isScanning = false;
let nextScanTimer = null;
let lastMarketData = [];
let lastDecisions = [];

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function number(value) {
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function formatPrice(value) {
  const n = number(value);
  if (n === null) return "—";

  if (n >= 1000) {
    return n.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  if (n >= 1) return n.toFixed(4);
  if (n >= 0.01) return n.toFixed(5);
  return n.toFixed(8);
}

function formatPercent(value) {
  const n = number(value);
  return n === null ? "—" : `${(n * 100).toFixed(2)}%`;
}

function formatNumber(value, digits = 2) {
  const n = number(value);
  return n === null ? "—" : n.toFixed(digits);
}

async function getJSON(url) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const data = await response.json();

  if (data.retCode !== 0) {
    throw new Error(data.retMsg || "Ошибка API");
  }

  return data;
}

function ema(values, period) {
  if (!values.length) return null;

  const multiplier = 2 / (period + 1);
  let result = values[0];

  for (let i = 1; i < values.length; i++) {
    result = values[i] * multiplier + result * (1 - multiplier);
  }

  return result;
}

function emaArray(values, period) {
  const result = [];
  const multiplier = 2 / (period + 1);
  let current = values[0];

  result.push(current);

  for (let i = 1; i < values.length; i++) {
    current = values[i] * multiplier + current * (1 - multiplier);
    result.push(current);
  }

  return result;
}

function calculateRSI(values, period = 14) {
  if (values.length <= period) return null;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];

    if (change > 0) gains += change;
    else losses -= change;
  }

  let averageGain = gains / period;
  let averageLoss = losses / period;

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];

    averageGain = (averageGain * (period - 1) + Math.max(change, 0)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(-change, 0)) / period;
  }

  if (averageLoss === 0) return 100;

  const rs = averageGain / averageLoss;
  return 100 - 100 / (1 + rs);
}

function calculateMACD(values) {
  if (values.length < 35) return null;

  const fast = emaArray(values, 12);
  const slow = emaArray(values, 26);
  const macdLine = values.map((_, i) => fast[i] - slow[i]);
  const signalLine = emaArray(macdLine, 9);

  const last = macdLine.length - 1;

  return {
    value: macdLine[last],
    signal: signalLine[last],
    histogram: macdLine[last] - signalLine[last]
  };
}

function calculateATR(candles, period = 14) {
  if (candles.length <= period) return null;

  const ranges = [];

  for (let i = 1; i < candles.length; i++) {
    const current = candles[i];
    const previous = candles[i - 1];

    ranges.push(Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close)
    ));
  }

  const recent = ranges.slice(-period);
  return recent.reduce((sum, value) => sum + value, 0) / recent.length;
}

function calculateRelativeVolume(candles) {
  if (candles.length < 21) return null;

  const previous = candles.slice(-21, -1);
  const average = previous.reduce((sum, candle) => sum + candle.volume, 0) / previous.length;

  if (!average) return null;

  return candles[candles.length - 1].volume / average;
}

function calculateLevels(candles) {
  const recent = candles.slice(-20);

  return {
    support: Math.min(...recent.map(c => c.low)),
    resistance: Math.max(...recent.map(c => c.high))
  };
}

async function analyzeTimeframe(symbol, timeframe) {
  const url =
    `${BYBIT_URL}/kline?category=linear` +
    `&symbol=${encodeURIComponent(symbol)}` +
    `&interval=${timeframe.interval}&limit=200`;

  const response = await getJSON(url);

  const raw = response.result?.list || [];

  const candles = raw
    .map(item => ({
      time: Number(item[0]),
      open: Number(item[1]),
      high: Number(item[2]),
      low: Number(item[3]),
      close: Number(item[4]),
      volume: Number(item[5])
    }))
    .filter(c =>
      Number.isFinite(c.close) &&
      Number.isFinite(c.high) &&
      Number.isFinite(c.low) &&
      c.close > 0 &&
      c.time + timeframe.duration <= Date.now()
    )
    .sort((a, b) => a.time - b.time);

  if (candles.length < 60) {
    throw new Error(`Недостаточно свечей ${timeframe.label}`);
  }

  const closes = candles.map(c => c.close);
  const last = candles[candles.length - 1];

  const ema20 = ema(closes.slice(-100), 20);
  const ema50 = ema(closes.slice(-150), 50);
  const rsi = calculateRSI(closes);
  const macd = calculateMACD(closes);
  const atr = calculateATR(candles);
  const relativeVolume = calculateRelativeVolume(candles);
  const levels = calculateLevels(candles);

  let trend = "NEUTRAL";

  if (ema20 !== null && ema50 !== null) {
    if (last.close > ema20 && ema20 > ema50) trend = "BULLISH";
    if (last.close < ema20 && ema20 < ema50) trend = "BEARISH";
  }

  return {
    timeframe: timeframe.label,
    price: last.close,
    ema20,
    ema50,
    rsi,
    macd,
    atr,
    atrPercent: atr && last.close ? atr / last.close : null,
    relativeVolume,
    support: levels.support,
    resistance: levels.resistance,
    trend,
    candleTime: last.time,
    candlesCount: candles.length
  };
}

async function runWithLimit(items, limit, callback) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex++;

      if (index >= items.length) return;

      try {
        results[index] = await callback(items[index], index);
      } catch (error) {
        results[index] = {
          error: error.message || "Ошибка анализа"
        };
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    () => worker()
  );

  await Promise.all(workers);
  return results;
}

async function analyzeCoin(ticker) {
  const timeframes = await Promise.all(
    TIMEFRAMES.map(async timeframe => {
      try {
        return await analyzeTimeframe(ticker.symbol, timeframe);
      } catch (error) {
        return {
          timeframe: timeframe.label,
          error: error.message
        };
      }
    })
  );

  const successful = timeframes.filter(item => !item.error);
  const missing = timeframes
    .filter(item => item.error)
    .map(item => item.timeframe);

  return {
    symbol: ticker.symbol,
    price: number(ticker.lastPrice),
    markPrice: number(ticker.markPrice),
    indexPrice: number(ticker.indexPrice),
    price24hChange: number(ticker.price24hPcnt),
    turnover24h: number(ticker.turnover24h),
    volume24h: number(ticker.volume24h),
    fundingRate: number(ticker.fundingRate),
    nextFundingTime: ticker.nextFundingTime || null,
    bidPrice: number(ticker.bid1Price),
    askPrice: number(ticker.ask1Price),
    spreadPercent:
      number(ticker.bid1Price) && number(ticker.ask1Price)
        ? (number(ticker.ask1Price) - number(ticker.bid1Price)) /
          number(ticker.lastPrice)
        : null,
    timeframes,
    successfulTimeframes: successful.length,
    missingTimeframes: missing,
    dataQuality: missing.length === 0 ? "COMPLETE" : "PARTIAL"
  };
}

async function loadMarketTickers() {
  const response = await getJSON(
    `${BYBIT_URL}/tickers?category=linear`
  );

  const tickers = response.result?.list || [];

  return tickers
    .filter(item =>
      item.symbol.endsWith("USDT") &&
      number(item.lastPrice) > 0 &&
      number(item.turnover24h) > 0
    )
    .sort((a, b) =>
      Number(b.turnover24h) - Number(a.turnover24h)
    )
    .slice(0, 20);
}

function getStrategyMode() {
  const value = modeSelect?.value || "balanced";

  return ["aggressive", "balanced", "conservative"].includes(value)
    ? value
    : "balanced";
}

function loadPreviousAnalysis() {
  try {
    const stored = localStorage.getItem(ANALYSIS_STORAGE_KEY);
    if (!stored) return [];

    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];

    return parsed.slice(0, 20).filter(item =>
      item &&
      typeof item.symbol === "string" &&
      typeof item.selectedStrategy === "string"
    );
  } catch {
    return [];
  }
}

function savePreviousAnalysis(decisions) {
  try {
    const compact = decisions.map(item => ({
      symbol: item.symbol,
      selectedStrategy: item.selectedStrategy,
      direction: item.direction,
      marketRegime: item.marketRegime,
      confidence: item.confidence,
      strategyAction: item.strategyAction,
      reason: item.reason
    }));

    localStorage.setItem(
      ANALYSIS_STORAGE_KEY,
      JSON.stringify(compact)
    );
  } catch (error) {
    console.warn("Не удалось сохранить предыдущий анализ", error);
  }
}

function normalizeGeminiResponse(response) {
  let analysis = response?.analysis;

  if (typeof analysis === "string") {
    try {
      analysis = JSON.parse(analysis);
    } catch {
      throw new Error("Gemini вернул некорректный JSON");
    }
  }

  if (analysis?.analysis && !analysis.decisions) {
    analysis = analysis.analysis;
  }

  const decisions = analysis?.decisions;

  if (!Array.isArray(decisions)) {
    throw new Error("В ответе Gemini отсутствует список решений");
  }

  return decisions;
}


async function requestGeminiAnalysis(marketData, triggerReason) {
  const BATCH_SIZE = 5;
  const allDecisions = [];
  const previousAnalysis = loadPreviousAnalysis();

  for (let start = 0; start < marketData.length; start += BATCH_SIZE) {
    const batch = marketData.slice(start, start + BATCH_SIZE);
    const batchNumber = Math.floor(start / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(marketData.length / BATCH_SIZE);

    console.log(
      `Gemini: пакет ${batchNumber}/${totalBatches}, монет: ${batch.length}`
    );

    const payload = {
      marketData: batch,
      strategyMode: getStrategyMode(),
      previousAnalysis,
      openPositions: [],
      triggerReason
    };

    const response = await fetch(`${WORKER_URL}/analyze`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const responseBody = await response.text();

    let data;

    try {
      data = JSON.parse(responseBody);
    } catch {
      throw new Error(
        `Пакет ${batchNumber}/${totalBatches}: Worker вернул не-JSON. ` +
        `HTTP ${response.status}: ${responseBody.slice(0, 500)}`
      );
    }

    if (!response.ok || data.ok === false) {
      const details = typeof data.details === "string"
        ? data.details
        : JSON.stringify(data.details || data);

      throw new Error(
        `Пакет ${batchNumber}/${totalBatches}: ` +
        `${data.error || "Ошибка Worker"}: ${details}`
      );
    }

    const decisions = normalizeGeminiResponse(data);

    if (decisions.length !== batch.length) {
      throw new Error(
        `Пакет ${batchNumber}: получено ${decisions.length} решений ` +
        `вместо ${batch.length}. Анализ отклонён.`
      );
    }

    const symbols = new Set(batch.map(item => item.symbol));
    const received = new Set();

    for (const decision of decisions) {
      if (!decision || !symbols.has(decision.symbol)) {
        throw new Error(
          `Пакет ${batchNumber}: Gemini вернул неизвестный символ`
        );
      }

      if (received.has(decision.symbol)) {
        throw new Error(
          `Пакет ${batchNumber}: повторяющийся символ ${decision.symbol}`
        );
      }

      received.add(decision.symbol);
    }

    allDecisions.push(...decisions);
  }

  if (allDecisions.length !== marketData.length) {
    throw new Error(
      "Общий анализ неполный. Все решения не получены."
    );
  }

  const finalSymbols = new Set(allDecisions.map(item => item.symbol));

  if (finalSymbols.size !== marketData.length) {
    throw new Error(
      "Общий анализ содержит повторяющиеся символы."
    );
  }

  console.log(
    `Gemini: успешно получено ${allDecisions.length} решений`
  );

  return allDecisions;
}


function validateDecision(decision, marketData) {
  const market = marketData.find(item => item.symbol === decision.symbol);

  const direction = String(decision.direction || "NONE").toUpperCase();
  const confidence = number(decision.confidence);
  const strategy = decision.selectedStrategy;

  const validDirection = ["LONG", "SHORT", "NONE"].includes(direction);
  const validStrategy = ALLOWED_STRATEGIES.includes(strategy);

  const atr5m = market?.timeframes?.find(
    item => item.timeframe === "5m" && !item.error
  )?.atr;

  const hasValidATR = number(atr5m) > 0;
  const completeData = market?.dataQuality === "COMPLETE";

  const allowed =
    validDirection &&
    direction !== "NONE" &&
    validStrategy &&
    confidence !== null &&
    confidence >= SIGNAL_THRESHOLD &&
    decision.tradeAllowed === true &&
    hasValidATR &&
    completeData;

  return {
    ...decision,
    direction: validDirection ? direction : "NONE",
    confidence: confidence === null ? 0 : Math.max(0, Math.min(100, confidence)),
    selectedStrategy: validStrategy ? strategy : "None",
    appTradeAllowed: allowed,
    market
  };
}

function calculateProvisionalLevels(decision) {
  const market = decision.market;

  const timeframe = market?.timeframes?.find(
    item => item.timeframe === "5m" && !item.error
  );

  const entry = number(market?.price);
  const atr = number(timeframe?.atr);

  if (!entry || !atr || atr <= 0) return null;

  const distance = atr * 1.5;
  const targetDistance = atr * 3;

  if (decision.direction === "LONG") {
    return {
      entry,
      stopLoss: entry - distance,
      takeProfit: entry + targetDistance
    };
  }

  if (decision.direction === "SHORT") {
    return {
      entry,
      stopLoss: entry + distance,
      takeProfit: entry - targetDistance
    };
  }

  return null;
}

function renderMarketList(coins) {
  const rows = coins.map((coin, index) => {
    const change = number(coin.price24hPcnt) || 0;
    const changeClass = change >= 0 ? "positive" : "negative";

    return `
      <div class="market-row">
        <span class="market-rank">${index + 1}</span>

        <div class="market-name">
          <strong>${escapeHTML(coin.symbol.replace("USDT", ""))}</strong>
          <small>USDT Perpetual</small>
        </div>

        <div class="market-price">
          <strong>${formatPrice(coin.price)}</strong>
          <small>Оборот: ${formatNumber(coin.turnover24h / 1000000, 2)}M USDT</small>
        </div>

        <div class="market-change ${changeClass}">
          ${change >= 0 ? "+" : ""}${(change * 100).toFixed(2)}%
        </div>
      </div>
    `;
  }).join("");

  return `<div class="market-list">${rows}</div>`;
}

function renderTimeframe(item) {
  if (item.error) {
    return `
      <div class="analysis-timeframe">
        <strong>${escapeHTML(item.timeframe)}</strong>
        <span>Нет данных</span>
        <span>—</span>
      </div>
    `;
  }

  const trendClass =
    item.trend === "BULLISH" ? "positive" :
    item.trend === "BEARISH" ? "negative" : "";

  const trendText =
    item.trend === "BULLISH" ? "Рост" :
    item.trend === "BEARISH" ? "Падение" : "Боковой";

  return `
    <div class="analysis-timeframe">
      <strong>${escapeHTML(item.timeframe)}</strong>
      <span class="${trendClass}">${trendText}</span>
      <span>${formatPrice(item.price)}</span>
    </div>
  `;
}

function renderTechnicalAnalysis(market) {
  const successful = market.timeframes.filter(item => !item.error);

  const timeframeRows = market.timeframes
    .map(renderTimeframe)
    .join("");

  const fiveMinute = successful.find(item => item.timeframe === "5m");

  const indicators = fiveMinute ? `
    <div class="analysis-indicators">
      <div class="analysis-indicator">
        <span>RSI · 5m</span>
        <strong>${formatNumber(fiveMinute.rsi)}</strong>
      </div>

      <div class="analysis-indicator">
        <span>ATR · 5m</span>
        <strong>${formatPrice(fiveMinute.atr)}</strong>
      </div>

      <div class="analysis-indicator">
        <span>EMA 20 · 5m</span>
        <strong>${formatPrice(fiveMinute.ema20)}</strong>
      </div>

      <div class="analysis-indicator">
        <span>Объём · 5m</span>
        <strong>${formatNumber(fiveMinute.relativeVolume)}x</strong>
      </div>

      <div class="analysis-indicator">
        <span>Funding Rate</span>
        <strong>${formatPercent(market.fundingRate)}</strong>
      </div>

      <div class="analysis-indicator">
        <span>Спред</span>
        <strong>${formatPercent(market.spreadPercent)}</strong>
      </div>
    </div>
  ` : `<p class="reason">Нет достаточных данных для технических показателей.</p>`;

  return `
    <div class="coin-analysis">
      <div class="analysis-heading">
        <strong>Технический контекст</strong>
        <span class="analysis-score neutral">
          ${successful.length}/4 таймфрейма
        </span>
      </div>

      <div class="analysis-grid analysis-grid-header">
        <span>ТФ</span>
        <span>Состояние</span>
        <span>Цена</span>
      </div>

      ${timeframeRows}
      ${indicators}
    </div>
  `;
}

function renderGeminiDecision(decision) {
  const direction = decision.direction;
  const isLong = direction === "LONG";
  const isShort = direction === "SHORT";

  const directionClass = isLong ? "long" : isShort ? "short" : "";
  const directionText = isLong ? "LONG" : isShort ? "SHORT" : "NO TRADE";

  const confidence = Math.round(decision.confidence);
  const marketRegime = decision.marketRegime || "Не определён";
  const strategy = decision.selectedStrategy || "Не выбрана";

  const reason = decision.reason || decision.strategyReason || "Обоснование не предоставлено.";
  const strategyReason = decision.strategyReason || "";
  const risks = Array.isArray(decision.risks)
    ? decision.risks.join("; ")
    : decision.risks || "";

  const alternatives = Array.isArray(decision.alternatives)
    ? decision.alternatives.join(", ")
    : decision.alternatives || "";

  const levels = decision.appTradeAllowed
    ? calculateProvisionalLevels(decision)
    : null;

  const tradeStatus = decision.appTradeAllowed
    ? "Аналитическая идея — проверка риска ещё не выполнена"
    : "Нет подтверждённой торговой идеи";

  return `
    <div class="signal">
      <div class="signal-top">
        <span class="coin">${escapeHTML(decision.symbol)}</span>
        <span class="direction ${directionClass}">
          ${directionText}
        </span>
      </div>

      <div class="score">${confidence}/100</div>
      <div class="score-label">Оценка уверенности Gemini, не вероятность прибыли</div>

      <div class="analysis-indicators">
        <div class="analysis-indicator">
          <span>Стратегия Gemini</span>
          <strong>${escapeHTML(strategy)}</strong>
        </div>

        <div class="analysis-indicator">
          <span>Режим рынка</span>
          <strong>${escapeHTML(marketRegime)}</strong>
        </div>

        <div class="analysis-indicator">
          <span>Действие со стратегией</span>
          <strong>${escapeHTML(decision.strategyAction || "—")}</strong>
        </div>

        <div class="analysis-indicator">
          <span>Следующая проверка</span>
          <strong>${escapeHTML(decision.nextCheckMinutes ?? "—")} мин.</strong>
        </div>
      </div>

      <div class="analysis-reason">
        <strong>Почему выбрана эта стратегия</strong><br>
        ${escapeHTML(strategyReason || reason)}
      </div>

      ${strategyReason && reason !== strategyReason ? `
        <p class="reason">${escapeHTML(reason)}</p>
      ` : ""}

      ${risks ? `
        <p class="reason">
          <strong>Риски:</strong> ${escapeHTML(risks)}
        </p>
      ` : ""}

      ${alternatives ? `
        <p class="reason">
          <strong>Альтернативы:</strong> ${escapeHTML(alternatives)}
        </p>
      ` : ""}

      ${levels ? `
        <div class="analysis-trade">
          <div class="analysis-trade-title">Предварительные уровни · не для исполнения</div>

          <div class="analysis-trade-row">
            <span>Вход</span>
            <strong>${formatPrice(levels.entry)}</strong>
          </div>

          <div class="analysis-trade-row">
            <span>Stop Loss</span>
            <strong>${formatPrice(levels.stopLoss)}</strong>
          </div>

          <div class="analysis-trade-row">
            <span>Take Profit</span>
            <strong>${formatPrice(levels.takeProfit)}</strong>
          </div>
        </div>
      ` : ""}

      <p class="demo-note">${escapeHTML(tradeStatus)}</p>
    </div>
  `;
}

function renderCoin(market, decision) {
  return `
    <div class="coin-card">
      ${renderGeminiDecision(decision)}
      ${renderTechnicalAnalysis(market)}
    </div>
  `;
}

function renderResults(marketData, decisions) {
  const decisionMap = new Map(
    decisions.map(item => [item.symbol, validateDecision(item, marketData)])
  );

  const cards = marketData.map(market => {
    const decision = decisionMap.get(market.symbol);

    if (!decision) {
      return `
        <div class="signal">
          <strong>${escapeHTML(market.symbol)}</strong>
          <p class="reason">Gemini не вернул решение по этой монете.</p>
        </div>
      `;
    }

    return renderCoin(market, decision);
  }).join("");

  results.className = "";
  results.innerHTML = `
    ${renderMarketList(marketData)}
    <div class="analysis-reason">
      <strong>Анализ Gemini</strong><br>
      Все монеты оцениваются отдельно. Технические индикаторы служат контекстом,
      а не главным источником торгового решения.
    </div>
    ${cards}
  `;

  lastDecisions = decisions;
  savePreviousAnalysis(decisions);

  count.textContent = String(marketData.length);
}

function getNextScanDelay(decisions) {
  const intervals = decisions
    .map(item => {
      const urgency = item.reviewUrgency;
      const minutes = number(item.nextCheckMinutes);

      if (minutes !== null) {
        return Math.max(1, Math.min(30, minutes));
      }

      if (urgency === "immediate") return 3;
      if (urgency === "soon") return 10;
      return 20;
    })
    .filter(value => Number.isFinite(value));

  if (!intervals.length) return 15;

  return Math.max(1, Math.min(...intervals));
}

function scheduleNextScan(decisions) {
  if (nextScanTimer) {
    clearTimeout(nextScanTimer);
  }

  const minutes = getNextScanDelay(decisions);

  state.textContent = `Следующая проверка: ~${minutes} мин.`;

  nextScanTimer = setTimeout(() => {
    loadMarket("scheduled_check");
  }, minutes * 60 * 1000);
}

async function loadMarket(triggerReason = "manual_scan") {
  if (isScanning) return;

  isScanning = true;
  btn.disabled = true;
  btn.textContent = "Анализ рынка...";
  state.textContent = "Загрузка Bybit...";
  results.className = "empty";
  results.innerHTML = `
    <div class="empty-icon">⌁</div>
    <strong>Загружаем рыночные данные</strong>
    <p>Получаем котировки и анализируем четыре таймфрейма для каждой монеты.</p>
  `;

  try {
    const tickers = await loadMarketTickers();

    if (!tickers.length) {
      throw new Error("Bybit не вернул список монет");
    }

    state.textContent = `Анализ ${tickers.length} монет...`;

    const analyzed = await runWithLimit(tickers, 3, analyzeCoin);

    const marketData = analyzed.filter(item =>
      item &&
      !item.error &&
      item.symbol &&
      number(item.price) > 0
    );

    if (!marketData.length) {
      throw new Error("Не удалось получить данные таймфреймов");
    }

    lastMarketData = marketData;

    state.textContent = "Gemini анализирует рынок...";

    const decisions = await requestGeminiAnalysis(
      marketData,
      triggerReason
    );

    renderResults(marketData, decisions);

    const candidateCount = decisions.filter(item => {
  const checked = validateDecision(item, marketData);
  return checked.appTradeAllowed === true;
}).length;

    state.textContent =
      `Готово · ${marketData.length} монет · ${candidateCount} идей`;

    scheduleNextScan(decisions);

  } catch (error) {
    console.error("Ошибка сканирования:", error);

    state.textContent = "Ошибка анализа";

    results.className = "empty";
    results.innerHTML = `
      <div class="empty-icon">!</div>
      <strong>Не удалось завершить анализ</strong>
      <p>${escapeHTML(error.message || "Неизвестная ошибка")}</p>
      <p>Проверь подключение к интернету и доступность Bybit и Cloudflare Worker.</p>
    `;

  } finally {
    isScanning = false;
    btn.disabled = false;
    btn.textContent = "Обновить рынок Bybit";
  }
}

btn.addEventListener("click", () => {
  if (nextScanTimer) {
    clearTimeout(nextScanTimer);
    nextScanTimer = null;
  }

  loadMarket("manual_scan");
});

if (modeSelect) {
  modeSelect.addEventListener("change", () => {
    if (nextScanTimer) {
      clearTimeout(nextScanTimer);
      nextScanTimer = null;
    }

    state.textContent = "Режим изменён · нажми обновить рынок";
  });
}

loadMarket("initial_scan");
