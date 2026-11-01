const btn=document.getElementById("scanBtn");
const results=document.getElementById("results");
const state=document.getElementById("scanState");
const count=document.getElementById("signalCount");
btn.addEventListener("click",()=>{
  btn.disabled=true;btn.textContent="Подготавливаем демонстрацию…";state.textContent="Демо";
  setTimeout(()=>{
    count.textContent="1";
    results.className="";
    results.innerHTML=`
      <article class="signal">
        <div class="signal-top"><span class="coin">BTCUSDT · Perpetual</span><span class="direction long">LONG · ПРИМЕР</span></div>
        <div class="score">88/100</div><div class="score-label">Условный балл качества · не вероятность прибыли</div>
        <div class="levels">
          <div class="level"><small>Вход</small><b>100 000</b></div>
          <div class="level"><small>Stop Loss</small><b>98 800</b></div>
          <div class="level"><small>Take Profit</small><b>103 000</b></div>
        </div>
        <p class="reason">Демонстрационный сценарий: направление старших таймфреймов совпадает, младший таймфрейм условно подтверждает вход.</p>
        <div class="demo-note">⚠ Это вымышленные значения. Реальные данные Bybit, расчёт уровней и ИИ пока не подключены.</div>
      </article>
      <div class="empty" style="padding:18px 8px 4px"><strong>Остальные монеты</strong><p>В рабочей версии здесь появятся только сигналы, прошедшие фильтр 85/100. Отсутствие сигнала — нормальный результат.</p></div>`;
    btn.disabled=false;btn.textContent="Повторить демонстрацию";state.textContent="Пример результата";
  },450);
});