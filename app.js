const btn = document.getElementById("scanBtn");
const results = document.getElementById("results");
const state = document.getElementById("scanState");
const count = document.getElementById("signalCount");

const API = "https://api.bybit.com/v5/market/tickers?category=linear";

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

async function loadMarket() {
  btn.disabled = true;
  btn.textContent = "Загружаем котировки…";
  state.textContent = "Запрос к Bybit";

  try {
    const response = await fetch(API, { cache: "no-store" });

    if (!response.ok) throw Error("HTTP " + response.status);

    const data = await response.json();

    if (data.retCode !== 0) {
      throw Error(data.retMsg || "Ошибка Bybit");
    }

    const coins = data.result.list
      .filter(x => x.symbol.endsWith("USDT") && Number(x.lastPrice) > 0)
      .sort((a, b) => Number(b.turnover24h) - Number(a.turnover24h))
      .slice(0, 20);

    if (!coins.length) throw Error("Нет подходящих монет");

    count.textContent = coins.length;
    results.className = "market-list";

    results.innerHTML = coins.map((x, i) => {
      const change = Number(x.price24hPcnt) * 100;

      return `
        <article class="market-row">
          <div class="market-rank">${i + 1}</div>
          <div class="market-name">
            <strong>${x.symbol.replace("USDT", "")}</strong>
            <small>${x.symbol}</small>
          </div>
          <div class="market-price">
            <strong>$${fmt(x.lastPrice)}</strong>
            <small>Оборот $${compact(x.turnover24h)}</small>
          </div>
          <div class="market-change ${change >= 0 ? "positive" : "negative"}">
            ${change > 0 ? "+" : ""}${change.toFixed(2)}%
          </div>
        </article>
      `;
    }).join("");

    state.textContent = "Обновлено " +
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