const btn = document.getElementById("scanBtn");
const results = document.getElementById("results");
const state = document.getElementById("scanState");
const count = document.getElementById("signalCount");

const TICKERS_API =
  "https://api.bybit.com/v5/market/tickers?category=linear";

const KLINE_API =
  "https://api.bybit.com/v5/market/kline?category=linear";

const TIMEFRAMES = [
  { interval: "5", label: "5m" },
  { interval: "15", label: "15m" },
  { interval: "60", label: "1h" },
  { interval: "240", label: "4h" }
];

const fmt = n => Number(n).toLocaleString("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 6
});

const compact = n => {
  n = Number(n);

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

// Расчёт экспоненциальной скользящей средней
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

// Расчёт RSI
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

    const gain = Math.max(difference, 0);
    const loss = Math.max(-difference, 0);

    averageGain =
      (averageGain * (period - 1) + gain) / period;

    averageLoss =
      (averageLoss * (period - 1) + loss) / period;
  }

  if (averageLoss === 0) return 100;

  const rs = averageGain / averageLoss;

  return 100 - (100 / (1 + rs));
}

// Загрузка и анализ свечей одного таймфрейма
async function analyzeTimeframe(symbol, timeframe) {
  const url =
    `${KLINE_API}&symbol=${encodeURIComponent(symbol)}` +
    `&interval=${timeframe.interval}&limit=100`;

  const result = await getJSON(url);

  // Bybit возвращает свечи от новых к старым.
  const candles = result.list
    .map(candle => ({
      time: Number(candle[0]),
      close: Number(candle[4])
    }))
    .filter(candle =>
      Number.isFinite(candle.time) &&
      Number.isFinite(candle.close) &&
      candle.close > 0
    )
    .sort((a, b) => a.time - b.time);

  const closes = candles.map(candle => candle.close);

  if (closes.length < 50) {
    throw Error("Недостаточно свечей");
  }

  const ema20 = calculateEMA(closes, 20);
  const ema50 = calculateEMA(closes, 50);
  const rsi = calculateRSI(closes);

  const price = closes[closes.length - 1];

  let trend = "Нейтральный";

  if (ema20 > ema50 && price > ema20) {
    trend = "Восходящий";
  } else if (ema20 < ema50 && price < ema20) {
    trend = "Нисходящий";
  }

  return {
    label: timeframe.label,
    trend,
    ema20,
    ema50,
    rsi,
    price
  };
}

// Анализ одной монеты на четырёх таймфреймах
async function analyzeCoin(symbol) {
  const analyses = await Promise.all(
    TIMEFRAMES.map(timeframe =>
      analyzeTimeframe(symbol, timeframe)
    )
  );

  const bullish = analyses.filter(
    item => item.trend === "Восходящий"
  ).length;

  const bearish = analyses.filter(
    item => item.trend === "Нисходящий"
  ).length;

  let direction = "Смешанный";

  if (bullish >= 3) direction = "Преимущественно вверх";
  if (bearish >= 3) direction = "Преимущественно вниз";

  return {
    analyses,
    direction,
    bullish,
    bearish
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
      <span>Анализ свечей ${safeSymbol}…</span>
    </div>
  `;
}

function renderAnalysis(symbol, result) {
  const safeSymbol = symbol.replace(/[^A-Z0-9]/g, "");
  const element = document.getElementById(
    `analysis-${safeSymbol}`
  );

  if (!element) return;

  const rows = result.analyses.map(item => {
    const rsiText = item.rsi === null
      ? "—"
      : item.rsi.toFixed(1);

    return `
      <div class="analysis-timeframe">
        <span>${item.label}</span>
        <span>${item.trend}</span>
        <span>RSI ${rsiText}</span>
      </div>
    `;
  }).join("");

  element.innerHTML = `
    <div class="analysis-heading">
      <strong>Технический анализ</strong>
      <span>${result.direction}</span>
    </div>

    ${rows}

    <small class="analysis-note">
      Вверх: ${result.bullish}/4 · Вниз: ${result.bearish}/4
    </small>
  `;
}

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

    state.textContent = "Анализ свечей: 0/20";

    await runWithLimit(coins, 3, async coin => {
      try {
        const analysis = await analyzeCoin(coin.symbol);
        renderAnalysis(coin.symbol, analysis);
      } catch (error) {
        const safeSymbol = coin.symbol.replace(/[^A-Z0-9]/g, "");
        const element = document.getElementById(
          `analysis-${safeSymbol}`
        );

        if (element) {
          element.textContent =
            "Не удалось получить данные свечей";
        }
      }

      completed++;
      state.textContent =
        `Анализ свечей: ${completed}/${coins.length}`;
    });

    state.textContent =
      "Обновлено " +
      new Date().toLocaleTimeString("ru-RU", {
        hour: "2-digit",
        minute: "2-digit"
      });

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