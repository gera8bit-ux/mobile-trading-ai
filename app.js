
const btn = document.getElementById("scanBtn");
const results = document.getElementById("results");
const state = document.getElementById("scanState");
const count = document.getElementById("signalCount");

const TICKERS_API =
  "https://api.bybit.com/v5/market/tickers?category=linear";

const KLINE_API =
  "https://api.bybit.com/v5/market/kline?category=linear";

const TIMEFRAMES = [
  { interval: "5", label: "5m", weight: 0.15, duration: 5 * 60 * 1000 },
  { interval: "15", label: "15m", weight: 0.25, duration: 15 * 60 * 1000 },
  { interval: "60", label: "1h", weight: 0.30, duration: 60 * 60 * 1000 },
  { interval: "240", label: "4h", weight: 0.30, duration: 240 * 60 * 1000 }
];

const SIGNAL_THRESHOLD = 85;

const fmt = value => {
  const number = Number(value);

  if (!Number.isFinite(number)) return "—";

  return number.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 8
  });
};

const compact = value => {
  const number = Number(value);

  if (!Number.isFinite(number)) return "—";

  if (number >= 1e9) return (number / 1e9).toFixed(2) + "B";
  if (number >= 1e6) return (number / 1e6).toFixed(2) + "M";
  if (number >= 1e3) return (number / 1e3).toFixed(2) + "K";

  return number.toFixed(2);
};

async function getJSON(url) {
  const response = await fetch(url, {
    cache: "no-store"
  });

  if (!response.ok) {
    throw Error("HTTP " + response.status);
  }

  const data = await response.json();

  if (data.retCode !== 0) {
    throw Error(data.retMsg || "Ошибка Bybit");
  }

  return data.result;
}

// Экспоненциальная скользящая средняя
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

// RSI по методу Уайлдера
function calculateRSI(values, period = 14) {
  if (values.length <= period) return null;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const difference = values[i] - values[i - 1];

    if (difference > 0) gains += difference;
    else losses -= difference;
  }

  let averageGain = gains / period;
  let averageLoss = losses / period;

  for (let i = period + 1; i < values.length; i++) {
    const difference = values[i] - values[i - 1];

    averageGain =
      (averageGain * (period - 1) +
        Math.max(difference, 0)) / period;

    averageLoss =
      (averageLoss * (period - 1) +
        Math.max(-difference, 0)) / period;
  }

  if (averageLoss === 0) return 100;

  const rs = averageGain / averageLoss;

  return 100 - 100 / (1 + rs);
}

// MACD 12 / 26 / 9
function calculateMACD(values) {
  if (values.length < 40) return null;

  const fast = calculateEMAArray(values, 12);
  const slow = calculateEMAArray(values, 26);

  const macd = [];

  for (let i = 0; i < values.length; i++) {
    if (fast[i] === null || slow[i] === null) continue;

    macd.push(fast[i] - slow[i]);
  }

  if (macd.length < 9) return null;

  const signalArray = calculateEMAArray(macd, 9);

  const macdValue = macd[macd.length - 1];
  const signalValue = signalArray[signalArray.length - 1];

  return {
    value: macdValue,
    signal: signalValue,
    histogram: macdValue - signalValue
  };
}

// ATR 14
function calculateATR(candles, period = 14) {
  if (candles.length <= period) return null;

  const trueRanges = [];

  for (let i = 1; i < candles.length; i++) {
    const current = candles[i];
    const previous = candles[i - 1];

    const trueRange = Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close)
    );

    trueRanges.push(trueRange);
  }

  let atr = trueRanges
    .slice(0, period)
    .reduce((sum, value) => sum + value, 0) / period;

  for (let i = period; i < trueRanges.length; i++) {
    atr = (atr * (period - 1) + trueRanges[i]) / period;
  }

  return atr;
}

// Относительный объём по обороту
function calculateRelativeVolume(candles, period = 20) {
  if (candles.length <= period) return null;

  const previous = candles.slice(
    -(period + 1),
    -1
  );

  const average = previous.reduce(
    (sum, candle) => sum + candle.turnover,
    0
  ) / period;

  const current = candles[candles.length - 1].turnover;

  if (average <= 0) return null;

  return current / average;
}

// Локальные уровни за последние 50 свечей
function calculateLevels(candles) {
  const recent = candles.slice(-50);

  return {
    support: Math.min(...recent.map(c => c.low)),
    resistance: Math.max(...recent.map(c => c.high))
  };
}

// Оценка направления на одном таймфрейме
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

// Загрузка и анализ одного таймфрейма
async function analyzeTimeframe(symbol, timeframe) {
  const url =
    `${KLINE_API}&symbol=${encodeURIComponent(symbol)}` +
    `&interval=${timeframe.interval}&limit=200`;

  const result = await getJSON(url);

  const now = Date.now();

  // Преобразуем свечи Bybit
  // и исключаем ещё не закрытую свечу.
  const candles = result.list
    .map(candle => ({
      time: Number(candle[0]),
      open: Number(candle[1]),
      high: Number(candle[2]),
      low: Number(candle[3]),
      close: Number(candle[4]),
      volume: Number(candle[5]),
      turnover: Number(candle[6])
    }))
    .filter(candle =>
      Number.isFinite(candle.time) &&
      Number.isFinite(candle.open) &&
      Number.isFinite(candle.high) &&
      Number.isFinite(candle.low) &&
      Number.isFinite(candle.close) &&
      Number.isFinite(candle.turnover) &&
      candle.close > 0 &&
      candle.high >= candle.low &&
      candle.time + timeframe.duration <= now
    )
    .sort((a, b) => a.time - b.time);

  if (candles.length < 60) {
    throw Error("Недостаточно закрытых свечей");
  }

  const closes = candles.map(c => c.close);

  const price = closes[closes.length - 1];

  const ema20 = calculateEMA(closes, 20);
  const ema50 = calculateEMA(closes, 50);

  const rsi = calculateRSI(closes, 14);
  const macd = calculateMACD(closes);
  const atr = calculateATR(candles, 14);

  const relativeVolume = calculateRelativeVolume(candles, 20);

  const levels = calculateLevels(candles);

  if (
    ema20 === null ||
    ema50 === null ||
    rsi === null ||
    macd === null ||
    atr === null
  ) {
    throw Error("Не удалось рассчитать индикаторы");
  }

  let trend = "Нейтральный";

  if (ema20 > ema50 && price > ema20) {
    trend = "Восходящий";
  }

  if (ema20 < ema50 && price < ema20) {
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

// Анализ одной монеты
async function analyzeCoin(symbol) {
  const analyses = await Promise.all(
    TIMEFRAMES.map(timeframe =>
      analyzeTimeframe(symbol, timeframe)
    )
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

  const higherTimeframesAgree =
    direction === "LONG"
      ? h4.bullish >= 75 && h1.bullish >= 75
      : h4.bearish >= 75 && h1.bearish >= 75;

  const lowerTimeframesAgree =
    direction === "LONG"
      ? m15.bullish >= 50 && m5.bullish >= 50
      : m15.bearish >= 50 && m5.bearish >= 50;

  const volumeConfirmed =
    m5.relativeVolume !== null &&
    m5.relativeVolume >= 1.1;

  const strongSignal =
    score >= SIGNAL_THRESHOLD &&
    higherTimeframesAgree &&
    lowerTimeframesAgree &&
    volumeConfirmed;

  // Расчёт предварительных уровней сделки
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
    strongSignal,
    bullishScore: Math.round(bullishScore),
    bearishScore: Math.round(bearishScore),
    volumeConfirmed,
    trade
  };
}

// Ограничение количества одновременных запросов
async function runWithLimit(items, limit, callback) {
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex++;

      if (index >= items.length) return;

      await callback(items[index], index);
    }
  }

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    () => worker()
  );

  await Promise.all(workers);
}

// Отображение монеты
function renderCoin(coin, index) {
  const change = Number(coin.price24hPcnt) * 100;

  const safeSymbol = coin.symbol.replace(/[^A-Z0-9]/g, "");

  return `
    <article class="market-row">
      <div class="market-rank">${index + 1}</div>

      <div class="market-name">
        <strong>${safeSymbol.replace("USDT", "")}</strong>
        <small>${safeSymbol}</small>
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

    <div class="coin-analysis" id="analysis-${safeSymbol}">
      <span>Выполняется анализ ${safeSymbol}…</span>
    </div>
  `;
}

// Отображение результатов анализа
function renderAnalysis(symbol, result) {
  const safeSymbol = symbol.replace(/[^A-Z0-9]/g, "");

  const element = document.getElementById(
    `analysis-${safeSymbol}`
  );

  if (!element) return;

  const rows = result.analyses.map(item => `
    <div class="analysis-timeframe">
      <span>${item.label}</span>
      <span>${item.trend}</span>
      <span>RSI ${item.rsi.toFixed(1)}</span>
    </div>
  `).join("");

  const signalClass =
    result.strongSignal
      ? result.direction === "LONG" ? "positive" : "negative"
      : "";

  const signalText = result.strongSignal
    ? `${result.direction} · ${result.score}/100`
    : `Нет сильного сигнала · ${result.score}/100`;

  const m5 = result.analyses.find(x => x.label === "5m");

  const volumeText = m5.relativeVolume === null
    ? "Нет данных"
    : `${m5.relativeVolume.toFixed(2)}x`;

  const tradeHtml = result.strongSignal
    ? `
      <div class="analysis-note">
        **Предварительный план сделки**
      </div>

      <div class="analysis-timeframe">
        <span>Вход</span>
        <span>$${fmt(result.trade.entry)}</span>
        <span></span>
      </div>

      <div class="analysis-timeframe">
        <span>Stop Loss</span>
        <span>$${fmt(result.trade.stopLoss)}</span>
        <span></span>
      </div>

      <div class="analysis-timeframe">
        <span>Take Profit</span>
        <span>$${fmt(result.trade.takeProfit)}</span>
        <span></span>
      </div>
    `
    : "";

  element.innerHTML = `
    <div class="analysis-heading">
      <strong>Технический анализ</strong>
      <span class="${signalClass}">${signalText}</span>
    </div>

    ${rows}

    <div class="analysis-note">
      MACD: ${m5.macd.histogram > 0 ? "Положительный" : "Отрицательный"}
      · ATR: ${fmt(m5.atr)}
      · Объём 5m: ${volumeText}
    </div>

    <div class="analysis-note">
      Поддержка: $${fmt(m5.levels.support)}
      · Сопротивление: $${fmt(m5.levels.resistance)}
    </div>

    ${tradeHtml}
  `;
}

// Загрузка Top 20 рынка
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
      .map((coin, index) => renderCoin(coin, index))
      .join("");

    let completed = 0;
    let strongSignals = 0;

    state.textContent =
      `Анализ закрытых свечей: 0/${coins.length}`;

    await runWithLimit(coins, 3, async coin => {
      try {
        const analysis = await analyzeCoin(coin.symbol);

        if (analysis.strongSignal) {
          strongSignals++;
        }

        renderAnalysis(coin.symbol, analysis);

      } catch (error) {
        const safeSymbol =
          coin.symbol.replace(/[^A-Z0-9]/g, "");

        const element = document.getElementById(
          `analysis-${safeSymbol}`
        );

        if (element) {
          element.textContent =
            "Не удалось выполнить анализ: " + error.message;
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
