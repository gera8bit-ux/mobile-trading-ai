
const btn = document.getElementById("scanBtn");
const results = document.getElementById("results");
const state = document.getElementById("scanState");
const count = document.getElementById("signalCount");

const TICKERS_API =
  "https://api.bybit.com/v5/market/tickers?category=linear";

const KLINE_API =
  "https://api.bybit.com/v5/market/kline?category=linear";

const TIMEFRAMES = [
  { interval: "5", label: "5m", weight: 0.15, duration: 300000 },
  { interval: "15", label: "15m", weight: 0.25, duration: 900000 },
  { interval: "60", label: "1h", weight: 0.30, duration: 3600000 },
  { interval: "240", label: "4h", weight: 0.30, duration: 14400000 }
];

const SIGNAL_THRESHOLD = 85;

const fmt = value => {
  const n = Number(value);

  if (!Number.isFinite(n)) return "—";

  return n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 8
  });
};

const compact = value => {
  const n = Number(value);

  if (!Number.isFinite(n)) return "—";

  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(2) + "K";

  return n.toFixed(2);
};

async function getJSON(url) {
  const response = await fetch(url, { cache: "no-store" });

  if (!response.ok) {
    throw Error("HTTP " + response.status);
  }

  const data = await response.json();

  if (data.retCode !== 0) {
    throw Error(data.retMsg || "Ошибка Bybit");
  }

  return data.result;
}

// EMA
function calculateEMA(values, period) {
  if (values.length < period) return null;

  const multiplier = 2 / (period + 1);

  let ema = values
    .slice(0, period)
    .reduce((sum, value) => sum + value, 0) / period;

  for (let i = period; i < values.length; i++) {
    ema = (values[i] - ema) * multiplier + ema;
  }

  return ema;
}

// Массив EMA для MACD
function calculateEMAArray(values, period) {
  if (values.length < period) return [];

  const multiplier = 2 / (period + 1);

  let ema = values
    .slice(0, period)
    .reduce((sum, value) => sum + value, 0) / period;

  const result = Array(period - 1).fill(null);
  result.push(ema);

  for (let i = period; i < values.length; i++) {
    ema = (values[i] - ema) * multiplier + ema;
    result.push(ema);
  }

  return result;
}

// RSI
function calculateRSI(values, period = 14) {
  if (values.length <= period) return null;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];

    if (change > 0) gains += change;
    else losses -= change;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];

    avgGain =
      (avgGain * (period - 1) + Math.max(change, 0)) / period;

    avgLoss =
      (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
  }

  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;

  return 100 - 100 / (1 + rs);
}

// MACD 12 / 26 / 9
function calculateMACD(values) {
  const fast = calculateEMAArray(values, 12);
  const slow = calculateEMAArray(values, 26);

  const macd = [];

  for (let i = 0; i < values.length; i++) {
    if (fast[i] !== null && slow[i] !== null) {
      macd.push(fast[i] - slow[i]);
    }
  }

  if (macd.length < 9) return null;

  const signalArray = calculateEMAArray(macd, 9);

  const value = macd[macd.length - 1];
  const signal = signalArray[signalArray.length - 1];

  return {
    value,
    signal,
    histogram: value - signal
  };
}

// ATR
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

  let atr = ranges
    .slice(0, period)
    .reduce((sum, value) => sum + value, 0) / period;

  for (let i = period; i < ranges.length; i++) {
    atr = (atr * (period - 1) + ranges[i]) / period;
  }

  return atr;
}

// Относительный объём
function calculateRelativeVolume(candles, period = 20) {
  if (candles.length <= period) return null;

  const previous = candles.slice(-(period + 1), -1);

  const average = previous.reduce(
    (sum, candle) => sum + candle.turnover,
    0
  ) / period;

  const current = candles[candles.length - 1].turnover;

  if (average <= 0) return null;

  return current / average;
}

// Поддержка и сопротивление
function calculateLevels(candles) {
  const recent = candles.slice(-50);

  return {
    support: Math.min(...recent.map(c => c.low)),
    resistance: Math.max(...recent.map(c => c.high))
  };
}

// Оценка одного таймфрейма
function calculateDirectionalScores(data) {
  let bullish = 0;
  let bearish = 0;

  if (data.price > data.ema20) bullish += 25;
  if (data.price < data.ema20) bearish += 25;

  if (data.ema20 > data.ema50) bullish += 25;
  if (data.ema20 < data.ema50) bearish += 25;

  if (data.macd.histogram > 0) bullish += 25;
  if (data.macd.histogram < 0) bearish += 25;

  if (data.rsi >= 50 && data.rsi <= 70) {
    bullish += 25;
  } else if (data.rsi > 70) {
    bullish += 10;
  }

  if (data.rsi >= 30 && data.rsi <= 50) {
    bearish += 25;
  } else if (data.rsi < 30) {
    bearish += 10;
  }

  return { bullish, bearish };
}

// Анализ таймфрейма
async function analyzeTimeframe(symbol, timeframe) {
  const url =
    `${KLINE_API}&symbol=${encodeURIComponent(symbol)}` +
    `&interval=${timeframe.interval}&limit=200`;

  const result = await getJSON(url);

  const now = Date.now();

  const candles = result.list
    .map(c => ({
      time: Number(c[0]),
      open: Number(c[1]),
      high: Number(c[2]),
      low: Number(c[3]),
      close: Number(c[4]),
      volume: Number(c[5]),
      turnover: Number(c[6])
    }))
    .filter(c =>
      Number.isFinite(c.time) &&
      Number.isFinite(c.open) &&
      Number.isFinite(c.high) &&
      Number.isFinite(c.low) &&
      Number.isFinite(c.close) &&
      Number.isFinite(c.turnover) &&
      c.close > 0 &&
      c.high >= c.low &&
      c.time + timeframe.duration <= now
    )
    .sort((a, b) => a.time - b.time);

  if (candles.length < 60) {
    throw Error("Недостаточно закрытых свечей");
  }

  const closes = candles.map(c => c.close);
  const price = closes[closes.length - 1];

  const ema20 = calculateEMA(closes, 20);
  const ema50 = calculateEMA(closes, 50);
  const rsi = calculateRSI(closes);
  const macd = calculateMACD(closes);
  const atr = calculateATR(candles);
  const relativeVolume = calculateRelativeVolume(candles);
  const levels = calculateLevels(candles);

  if (
    ema20 === null ||
    ema50 === null ||
    rsi === null ||
    macd === null ||
    atr === null
  ) {
    throw Error("Ошибка расчёта индикаторов");
  }

  let trend = "Нейтральный";

  if (ema20 > ema50 && price > ema20) {
    trend = "Восходящий";
  } else if (ema20 < ema50 && price < ema20) {
    trend = "Нисходящий";
  }

  const scores = calculateDirectionalScores({
    price,
    ema20,
    ema50,
    rsi,
    macd
  });

  return {
    label: timeframe.label,
    weight: timeframe.weight,
    price,
    ema20,
    ema50,
    rsi,
    macd,
    atr,
    relativeVolume,
    levels,
    trend,
    bullish: scores.bullish,
    bearish: scores.bearish
  };
}

// Полный анализ монеты
async function analyzeCoin(symbol) {
  const analyses = await Promise.all(
    TIMEFRAMES.map(tf => analyzeTimeframe(symbol, tf))
  );

  let bullishScore = 0;
  let bearishScore = 0;

  analyses.forEach(item => {
    bullishScore += item.bullish * item.weight;
    bearishScore += item.bearish * item.weight;
  });

  const direction =
    bullishScore >= bearishScore ? "LONG" : "SHORT";

  const score = Math.round(
    direction === "LONG" ? bullishScore : bearishScore
  );

  const h4 = analyses.find(x => x.label === "4h");
  const h1 = analyses.find(x => x.label === "1h");
  const m15 = analyses.find(x => x.label === "15m");
  const m5 = analyses.find(x => x.label === "5m");

  const higherAgree = direction === "LONG"
    ? h4.bullish >= 75 && h1.bullish >= 75
    : h4.bearish >= 75 && h1.bearish >= 75;

  const lowerAgree = direction === "LONG"
    ? m15.bullish >= 50 && m5.bullish >= 50
    : m15.bearish >= 50 && m5.bearish >= 50;

  const volumeConfirmed =
    m5.relativeVolume !== null &&
    m5.relativeVolume >= 1.1;

  const reasons = [];

  if (score < SIGNAL_THRESHOLD) {
    reasons.push(
      `Оценка ${score}/100 ниже необходимого порога ${SIGNAL_THRESHOLD}`
    );
  }

  if (!higherAgree) {
    reasons.push(
      "Нет подтверждения направления на старших таймфреймах 1h и 4h"
    );
  }

  if (!lowerAgree) {
    reasons.push(
      "Таймфреймы 5m и 15m не подтверждают направление одновременно"
    );
  }

  if (!volumeConfirmed) {
    reasons.push(
      m5.relativeVolume === null
        ? "Недостаточно данных об объёме"
        : `Объём 5m слабый: ${m5.relativeVolume.toFixed(2)}x от среднего`
    );
  }

  const strongSignal = reasons.length === 0;

  const entry = m5.price;
  const stopDistance = m5.atr * 1.5;
  const targetDistance = m5.atr * 3;

  const trade = direction === "LONG"
    ? {
        entry,
        stopLoss: entry - stopDistance,
        takeProfit: entry + targetDistance
      }
    : {
        entry,
        stopLoss: entry + stopDistance,
        takeProfit: entry - targetDistance
      };

  return {
    analyses,
    direction,
    score,
    bullishScore: Math.round(bullishScore),
    bearishScore: Math.round(bearishScore),
    strongSignal,
    reasons,
    trade
  };
}

// Ограничение запросов
async function runWithLimit(items, limit, callback) {
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex++;

      if (index >= items.length) return;

      await callback(items[index], index);
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(limit, items.length) },
      () => worker()
    )
  );
}

// Строка таймфрейма
function renderTimeframe(item) {
  return `
    <div class="analysis-timeframe">
      <span>${item.label}</span>
      <span>${item.trend}</span>
      <span>RSI ${item.rsi.toFixed(1)}</span>
    </div>
  `;
}

// Карточка монеты
function renderCoin(coin, index) {
  const change = Number(coin.price24hPcnt) * 100;
  const symbol = coin.symbol.replace(/[^A-Z0-9]/g, "");

  return `
    <article class="market-row">
      <div class="market-rank">${index + 1}</div>

      <div class="market-name">
        <strong>${symbol.replace("USDT", "")}</strong>
        <small>${symbol}</small>
      </div>

      <div class="market-price">
        <strong>$${fmt(coin.lastPrice)}</strong>
        <small>Оборот $${compact(coin.turnover24h)}</small>
      </div>

      <div class="market-change ${
        change >= 0 ? "positive" : "negative"
      }">
        ${change > 0 ? "+" : ""}${change.toFixed(2)}%
      </div>
    </article>

    <div class="coin-analysis" id="analysis-${symbol}">
      <span>Анализ ${symbol}…</span>
    </div>
  `;
}

// Отображение анализа
function renderAnalysis(symbol, result) {
  const safeSymbol = symbol.replace(/[^A-Z0-9]/g, "");

  const element = document.getElementById(
    `analysis-${safeSymbol}`
  );

  if (!element) return;

  const m5 = result.analyses.find(x => x.label === "5m");

  const scoreClass = result.strongSignal
    ? result.direction.toLowerCase()
    : "neutral";

  const rows = result.analyses
    .map(renderTimeframe)
    .join("");

  const reasonsHtml = result.strongSignal
    ? `
      <div class="analysis-reason positive">
        Все условия стратегии выполнены. Сигнал прошёл фильтры.
      </div>
    `
    : `
      <div class="analysis-reason">
        <strong>Почему сигнал отклонён:</strong>
        <ul>
          ${result.reasons.map(reason => `<li>${reason}</li>`).join("")}
        </ul>
      </div>
    `;

  const tradeHtml = result.strongSignal
    ? `
      <div class="analysis-trade">
        <div class="analysis-trade-title">
          Предварительный план сделки ${result.direction}
        </div>

        <div class="analysis-trade-row">
          <span>Вход</span>
          <strong>$${fmt(result.trade.entry)}</strong>
        </div>

        <div class="analysis-trade-row">
          <span>Stop Loss</span>
          <strong>$${fmt(result.trade.stopLoss)}</strong>
        </div>

        <div class="analysis-trade-row">
          <span>Take Profit</span>
          <strong>$${fmt(result.trade.takeProfit)}</strong>
        </div>
      </div>
    `
    : "";

  element.innerHTML = `
    <div class="analysis-heading">
      <strong>Технический анализ</strong>

      <span class="analysis-score ${scoreClass}">
        ${result.direction} · ${result.score}/100
      </span>
    </div>

    <div class="analysis-note">
      LONG: ${result.bullishScore}/100
      · SHORT: ${result.bearishScore}/100
    </div>

    <div class="analysis-grid analysis-grid-header">
      <span>ТФ</span>
      <span>Тренд</span>
      <span>RSI</span>
    </div>

    ${rows}

    <div class="analysis-indicators">
      <div class="analysis-indicator">
        <span>MACD 5m</span>
        <strong class="${m5.macd.histogram >= 0 ? "positive" : "negative"}">
          ${m5.macd.histogram >= 0 ? "Положительный" : "Отрицательный"}
        </strong>
      </div>

      <div class="analysis-indicator">
        <span>ATR 5m</span>
        <strong>${fmt(m5.atr)}</strong>
      </div>

      <div class="analysis-indicator">
        <span>Объём 5m</span>
        <strong>
          ${m5.relativeVolume === null
            ? "Нет данных"
            : m5.relativeVolume.toFixed(2) + "x"}
        </strong>
      </div>

      <div class="analysis-indicator">
        <span>Порог сигнала</span>
        <strong>${SIGNAL_THRESHOLD}/100</strong>
      </div>
    </div>

    <div class="analysis-levels">
      Поддержка: $${fmt(m5.levels.support)}
      <br>
      Сопротивление: $${fmt(m5.levels.resistance)}
    </div>

    ${reasonsHtml}
    ${tradeHtml}
  `;
}

// Загрузка рынка
async function loadMarket() {
  btn.disabled = true;
  btn.textContent = "Загружаем рынок…";
  state.textContent = "Запрос к Bybit";

  try {
    const data = await getJSON(TICKERS_API);

    const coins = data.list
      .filter(item =>
        item.symbol.endsWith("USDT") &&
        Number(item.lastPrice) > 0
      )
      .sort((a, b) =>
        Number(b.turnover24h) - Number(a.turnover24h)
      )
      .slice(0, 20);

    if (!coins.length) {
      throw Error("Нет подходящих монет");
    }

    count.textContent = coins.length;
    results.className = "market-list";

    results.innerHTML = coins
      .map(renderCoin)
      .join("");

    let completed = 0;
    let strongSignals = 0;

    state.textContent =
      `Анализ: 0/${coins.length}`;

    await runWithLimit(coins, 3, async coin => {
      try {
        const analysis = await analyzeCoin(coin.symbol);

        if (analysis.strongSignal) {
          strongSignals++;
        }

        renderAnalysis(coin.symbol, analysis);

      } catch (error) {
        const symbol =
          coin.symbol.replace(/[^A-Z0-9]/g, "");

        const element = document.getElementById(
          `analysis-${symbol}`
        );

        if (element) {
          element.textContent =
            "Ошибка анализа: " + error.message;
        }
      }

      completed++;

      state.textContent =
        `Анализ: ${completed}/${coins.length} · Сигналов: ${strongSignals}`;
    });

    state.textContent =
      `Обновлено ${new Date().toLocaleTimeString("ru-RU", {
        hour: "2-digit",
        minute: "2-digit"
      })} · Сильных сигналов: ${strongSignals}`;

  } catch (error) {
    results.className = "empty";

    results.innerHTML = `
      <div class="empty-icon">!</div>
      <strong>Не удалось загрузить рынок</strong>
      <p>${error.message}. Проверь интернет и попробуй ещё раз.</p>
    `;

    state.textContent = "Ошибка загрузки";

  } finally {
    btn.disabled = false;
    btn.textContent = "Обновить рынок Bybit";
  }
}

btn.addEventListener("click", loadMarket);

loadMarket();
