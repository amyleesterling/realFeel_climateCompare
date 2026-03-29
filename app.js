(function () {
  "use strict";

  // ---- State ----
  const state = { loc1: null, loc2: null };

  // ---- DOM ----
  const $ = (sel) => document.querySelector(sel);
  const search1 = $("#search1");
  const search2 = $("#search2");
  const dropdown1 = $("#dropdown1");
  const dropdown2 = $("#dropdown2");
  const selected1 = $("#selected1");
  const selected2 = $("#selected2");
  const compareBtn = $("#compareBtn");
  const loadingEl = $("#loading");
  const errorEl = $("#error");
  const resultsEl = $("#results");
  const h2hGrid = $("#h2hGrid");
  const scoreBars = $("#scoreBars");

  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const CHART_IDS = ["chartTemp", "chartRealFeel", "chartPrecip", "chartSunshine", "chartWind"];
  const chartInstances = {};

  // Ideal comfortable temperature for humans (~72F)
  const IDEAL_TEMP = 72;

  // ---- Debounce ----
  function debounce(fn, ms) {
    let timer;
    return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
  }

  // ---- Geocoding ----
  async function geocode(query) {
    const res = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=5&language=en`);
    if (!res.ok) throw new Error("Geocoding failed");
    const data = await res.json();
    return data.results || [];
  }

  function renderDropdown(items, dropdown, locKey, input, selectedEl) {
    dropdown.innerHTML = "";
    if (!items.length) { dropdown.classList.remove("open"); return; }
    items.forEach((item) => {
      const div = document.createElement("div");
      div.className = "dropdown-item";
      const region = [item.admin1, item.country].filter(Boolean).join(", ");
      div.innerHTML = `<span class="city">${item.name}</span> <span class="region">${region}</span>`;
      div.addEventListener("mousedown", (e) => {
        e.preventDefault();
        state[locKey] = { name: item.name, lat: item.latitude, lon: item.longitude, fullName: `${item.name}, ${region}` };
        input.value = item.name;
        selectedEl.textContent = state[locKey].fullName;
        dropdown.classList.remove("open");
        updateCompareBtn();
      });
      dropdown.appendChild(div);
    });
    dropdown.classList.add("open");
  }

  function setupSearch(input, dropdown, locKey, selectedEl) {
    const search = debounce(async () => {
      const q = input.value.trim();
      if (q.length < 2) { dropdown.classList.remove("open"); return; }
      try {
        const results = await geocode(q);
        renderDropdown(results, dropdown, locKey, input, selectedEl);
      } catch { dropdown.classList.remove("open"); }
    }, 300);

    input.addEventListener("input", () => {
      state[locKey] = null;
      selectedEl.textContent = "";
      updateCompareBtn();
      search();
    });
    input.addEventListener("blur", () => setTimeout(() => dropdown.classList.remove("open"), 150));
    input.addEventListener("focus", () => { if (dropdown.children.length) dropdown.classList.add("open"); });
  }

  function updateCompareBtn() {
    compareBtn.disabled = !(state.loc1 && state.loc2);
  }

  // ---- Data Fetching ----
  async function fetchClimate(lat, lon) {
    const params = new URLSearchParams({
      latitude: lat,
      longitude: lon,
      start_date: "2006-03-29",
      end_date: "2026-03-29",
      daily: [
        "temperature_2m_max", "temperature_2m_min",
        "apparent_temperature_max", "apparent_temperature_min",
        "wind_speed_10m_max", "sunshine_duration", "precipitation_sum",
      ].join(","),
      temperature_unit: "fahrenheit",
      wind_speed_unit: "mph",
      precipitation_unit: "inch",
      timezone: "auto",
    });
    const res = await fetch(`https://archive-api.open-meteo.com/v1/archive?${params}`);
    if (!res.ok) throw new Error(`API error (${res.status})`);
    return res.json();
  }

  // ---- Data Processing ----
  function processData(raw) {
    const d = raw.daily;
    const buckets = Array.from({ length: 12 }, () => ({
      tempMax: [], tempMin: [], feelMax: [], feelMin: [], wind: [], sunshine: [], precip: [],
    }));

    for (let i = 0; i < d.time.length; i++) {
      const month = new Date(d.time[i] + "T00:00").getMonth();
      const push = (arr, val) => { if (val != null) arr.push(val); };
      push(buckets[month].tempMax, d.temperature_2m_max[i]);
      push(buckets[month].tempMin, d.temperature_2m_min[i]);
      push(buckets[month].feelMax, d.apparent_temperature_max[i]);
      push(buckets[month].feelMin, d.apparent_temperature_min[i]);
      push(buckets[month].wind, d.wind_speed_10m_max[i]);
      if (d.sunshine_duration[i] != null) buckets[month].sunshine.push(d.sunshine_duration[i] / 3600);
      push(buckets[month].precip, d.precipitation_sum[i]);
    }

    const avg = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

    const monthly = buckets.map((b) => ({
      tempAvg: avg(b.tempMax.map((v, j) => (v + b.tempMin[j]) / 2)),
      tempMax: avg(b.tempMax),
      tempMin: avg(b.tempMin),
      feelAvg: avg(b.feelMax.map((v, j) => (v + b.feelMin[j]) / 2)),
      feelMax: avg(b.feelMax),
      feelMin: avg(b.feelMin),
      wind: avg(b.wind),
      sunshine: avg(b.sunshine),
      precip: avg(b.precip),
    }));

    const overall = {
      tempAvg: avg(monthly.map((m) => m.tempAvg)),
      tempMax: avg(monthly.map((m) => m.tempMax)),
      tempMin: avg(monthly.map((m) => m.tempMin)),
      feelAvg: avg(monthly.map((m) => m.feelAvg)),
      feelMax: avg(monthly.map((m) => m.feelMax)),
      feelMin: avg(monthly.map((m) => m.feelMin)),
      wind: avg(monthly.map((m) => m.wind)),
      sunshine: avg(monthly.map((m) => m.sunshine)),
      precip: avg(monthly.map((m) => m.precip)),
    };

    return { monthly, overall };
  }

  // ---- Comfort Score ----
  // Higher = more pleasant for humans
  // Factors: closeness to 72F, low wind, more sun, less rain, real feel closeness to 72F
  function comfortScore(overall) {
    // Temperature pleasantness: 0-100, peaks at 72F
    const tempDeviation = Math.abs(overall.feelAvg - IDEAL_TEMP);
    const tempScore = Math.max(0, 100 - (tempDeviation * 2.5));

    // Wind: lower is better. 0 mph = 100, 30+ mph = 0
    const windScore = Math.max(0, 100 - (overall.wind * 3.3));

    // Sunshine: more is better. 0 hrs = 0, 12+ hrs = 100
    const sunScore = Math.min(100, (overall.sunshine / 12) * 100);

    // Precipitation: less is better. 0 in = 100, 0.2+ in/day = 0
    const precipScore = Math.max(0, 100 - (overall.precip * 500));

    // Real feel range: smaller daily swing is more pleasant
    const feelRange = overall.feelMax - overall.feelMin;
    const rangeScore = Math.max(0, 100 - (feelRange * 3));

    // Weighted composite
    const score = (
      tempScore * 0.35 +
      windScore * 0.15 +
      sunScore * 0.20 +
      precipScore * 0.15 +
      rangeScore * 0.15
    );

    return {
      total: Math.round(score),
      breakdown: {
        "Feel Temp": Math.round(tempScore),
        "Low Wind": Math.round(windScore),
        "Sunshine": Math.round(sunScore),
        "Low Precip": Math.round(precipScore),
        "Stable Temps": Math.round(rangeScore),
      },
    };
  }

  // ---- Confetti ----
  function spawnConfetti() {
    const container = $("#confetti");
    container.innerHTML = "";
    const colors = ["#ffd700", "#ff6b3d", "#00c8ff", "#39ff14", "#ff2d78", "#fff"];
    for (let i = 0; i < 50; i++) {
      const piece = document.createElement("div");
      piece.className = "confetti-piece";
      piece.style.left = Math.random() * 100 + "%";
      piece.style.backgroundColor = colors[Math.floor(Math.random() * colors.length)];
      piece.style.animationDuration = (2 + Math.random() * 3) + "s";
      piece.style.animationDelay = Math.random() * 2 + "s";
      piece.style.width = (4 + Math.random() * 8) + "px";
      piece.style.height = (4 + Math.random() * 8) + "px";
      piece.style.borderRadius = Math.random() > 0.5 ? "50%" : "0";
      container.appendChild(piece);
    }
  }

  // ---- Render Winner Banner ----
  function renderWinner(score1, score2, name1, name2) {
    const winnerName = $("#winnerName");
    const winnerScore = $("#winnerScore");

    if (score1.total > score2.total) {
      winnerName.textContent = name1;
      winnerName.className = "winner-name p1-winner";
      winnerScore.textContent = score1.total;
    } else if (score2.total > score1.total) {
      winnerName.textContent = name2;
      winnerName.className = "winner-name p2-winner";
      winnerScore.textContent = score2.total;
    } else {
      winnerName.textContent = "TIE!";
      winnerName.className = "winner-name";
      winnerScore.textContent = score1.total;
    }
    spawnConfetti();
  }

  // ---- Render Score Bars ----
  function renderScoreBars(score1, score2, name1, name2) {
    scoreBars.innerHTML = "";
    const max = 100;

    // Overall score
    const categories = [
      { label: "OVERALL COMFORT", v1: score1.total, v2: score2.total },
    ];

    // Individual breakdowns
    const keys = Object.keys(score1.breakdown);
    keys.forEach((key) => {
      categories.push({ label: key.toUpperCase(), v1: score1.breakdown[key], v2: score2.breakdown[key] });
    });

    categories.forEach((cat, idx) => {
      const isOverall = idx === 0;

      // Player 1 bar
      const row1 = document.createElement("div");
      row1.className = "score-bar-row";
      if (idx === 0) row1.style.marginBottom = "0.3rem";
      const nameSpan1 = document.createElement("span");
      nameSpan1.className = "score-bar-name p1";
      nameSpan1.textContent = idx === 0 ? name1 : "";

      const track1 = document.createElement("div");
      track1.className = "score-bar-track";
      const fill1 = document.createElement("div");
      fill1.className = "score-bar-fill p1" + (cat.v1 >= cat.v2 ? " winner-bar" : "");
      fill1.style.width = "0%";
      fill1.textContent = cat.v1;
      if (isOverall) {
        fill1.style.height = "40px";
        fill1.style.fontSize = "1rem";
        track1.style.height = "40px";
      }
      track1.appendChild(fill1);

      row1.appendChild(nameSpan1);
      row1.appendChild(track1);

      // Player 2 bar
      const row2 = document.createElement("div");
      row2.className = "score-bar-row";
      const nameSpan2 = document.createElement("span");
      nameSpan2.className = "score-bar-name p2";
      nameSpan2.textContent = idx === 0 ? name2 : "";

      const track2 = document.createElement("div");
      track2.className = "score-bar-track";
      const fill2 = document.createElement("div");
      fill2.className = "score-bar-fill p2" + (cat.v2 >= cat.v1 ? " winner-bar" : "");
      fill2.style.width = "0%";
      fill2.textContent = cat.v2;
      if (isOverall) {
        fill2.style.height = "40px";
        fill2.style.fontSize = "1rem";
        track2.style.height = "40px";
      }
      track2.appendChild(fill2);

      row2.appendChild(nameSpan2);
      row2.appendChild(track2);

      // Category label
      if (!isOverall) {
        const labelRow = document.createElement("div");
        labelRow.style.cssText = "text-align:center; margin-top:1rem; margin-bottom:0.2rem;";
        const labelSpan = document.createElement("span");
        labelSpan.style.cssText = "font-family:'Orbitron',monospace; font-size:0.6rem; letter-spacing:3px; color:#6b7a94;";
        labelSpan.textContent = cat.label;
        labelRow.appendChild(labelSpan);
        scoreBars.appendChild(labelRow);
      }

      scoreBars.appendChild(row1);
      scoreBars.appendChild(row2);

      if (isOverall) {
        const divider = document.createElement("div");
        divider.style.cssText = "border-top:1px solid rgba(255,255,255,0.06); margin:1.2rem 0 0.5rem;";
        scoreBars.appendChild(divider);
      }

      // Animate bars
      requestAnimationFrame(() => {
        setTimeout(() => {
          fill1.style.width = (cat.v1 / max) * 100 + "%";
          fill2.style.width = (cat.v2 / max) * 100 + "%";
        }, 100 + idx * 150);
      });
    });
  }

  // ---- Render Head to Head ----
  function renderH2H(data1, data2, name1, name2) {
    h2hGrid.innerHTML = "";

    // "More pleasant" means closer to comfortable for temp metrics
    // For others: less wind = better, more sun = better, less rain = better
    const metrics = [
      {
        label: "AVERAGE TEMPERATURE", key: "tempAvg", unit: "\u00b0F", fmt: 1,
        better: (a, b) => Math.abs(a - IDEAL_TEMP) < Math.abs(b - IDEAL_TEMP) ? -1 : 1,
        winLabel: "MORE PLEASANT",
      },
      {
        label: "REAL FEEL", key: "feelAvg", unit: "\u00b0F", fmt: 1,
        better: (a, b) => Math.abs(a - IDEAL_TEMP) < Math.abs(b - IDEAL_TEMP) ? -1 : 1,
        winLabel: "MORE PLEASANT",
      },
      {
        label: "AVERAGE HIGH", key: "tempMax", unit: "\u00b0F", fmt: 1,
        better: (a, b) => Math.abs(a - 78) < Math.abs(b - 78) ? -1 : 1,
        winLabel: "MORE PLEASANT",
      },
      {
        label: "AVERAGE LOW", key: "tempMin", unit: "\u00b0F", fmt: 1,
        better: (a, b) => Math.abs(a - 60) < Math.abs(b - 60) ? -1 : 1,
        winLabel: "MORE PLEASANT",
      },
      {
        label: "MAX WIND SPEED", key: "wind", unit: " mph", fmt: 1,
        better: (a, b) => a < b ? -1 : 1,
        winLabel: "CALMER",
      },
      {
        label: "SUNSHINE", key: "sunshine", unit: " hrs/day", fmt: 1,
        better: (a, b) => a > b ? -1 : 1,
        winLabel: "SUNNIER",
      },
      {
        label: "PRECIPITATION", key: "precip", unit: " in/day", fmt: 3,
        better: (a, b) => a < b ? -1 : 1,
        winLabel: "DRIER",
      },
    ];

    metrics.forEach((m) => {
      const v1 = data1.overall[m.key];
      const v2 = data2.overall[m.key];
      const cmp = m.better(v1, v2);
      const p1Wins = cmp < 0;
      const tie = v1.toFixed(m.fmt) === v2.toFixed(m.fmt);

      const card = document.createElement("div");
      card.className = "h2h-card" + (tie ? "" : p1Wins ? " p1-wins" : " p2-wins");

      card.innerHTML = `
        <div class="h2h-category">${m.label}</div>
        <div class="h2h-row">
          <div class="h2h-player p1">
            <div class="h2h-loc-label">${name1}</div>
            <div class="h2h-value ${!tie && p1Wins ? 'h2h-winner-value' : ''}">${v1.toFixed(m.fmt)}${m.unit}</div>
            ${!tie && p1Wins ? `<div class="h2h-badge">${m.winLabel}</div>` : ''}
          </div>
          <div class="h2h-vs">VS</div>
          <div class="h2h-player p2">
            <div class="h2h-loc-label">${name2}</div>
            <div class="h2h-value ${!tie && !p1Wins ? 'h2h-winner-value' : ''}">${v2.toFixed(m.fmt)}${m.unit}</div>
            ${!tie && !p1Wins ? `<div class="h2h-badge">${m.winLabel}</div>` : ''}
          </div>
        </div>`;
      h2hGrid.appendChild(card);
    });
  }

  // ---- Charts ----
  function destroyCharts() {
    CHART_IDS.forEach((id) => {
      if (chartInstances[id]) { chartInstances[id].destroy(); delete chartInstances[id]; }
    });
  }

  function makeChart(canvasId, config) {
    const ctx = document.getElementById(canvasId).getContext("2d");
    chartInstances[canvasId] = new Chart(ctx, config);
  }

  function chartColors() {
    return { p1: "#ff6b3d", p1bg: "rgba(255,107,61,0.15)", p2: "#00c8ff", p2bg: "rgba(0,200,255,0.15)" };
  }

  Chart.defaults.color = "#6b7a94";
  Chart.defaults.borderColor = "rgba(255,255,255,0.06)";

  // Custom plugin: shade the area between the two datasets
  const diffFillPlugin = {
    id: "diffFill",
    beforeDatasetsDraw(chart) {
      if (chart.config.type !== "line") return;
      const ds = chart.data.datasets;
      if (ds.length < 2) return;
      // Only draw if both datasets are visible
      const meta0 = chart.getDatasetMeta(0);
      const meta1 = chart.getDatasetMeta(1);
      if (meta0.hidden || meta1.hidden) return;

      const ctx = chart.ctx;
      const pts0 = meta0.data;
      const pts1 = meta1.data;
      if (!pts0.length || !pts1.length) return;

      ctx.save();
      ctx.beginPath();
      // Trace dataset 0 forward
      pts0.forEach((pt, i) => { i === 0 ? ctx.moveTo(pt.x, pt.y) : ctx.lineTo(pt.x, pt.y); });
      // Trace dataset 1 backward
      for (let i = pts1.length - 1; i >= 0; i--) ctx.lineTo(pts1[i].x, pts1[i].y);
      ctx.closePath();
      ctx.fillStyle = "rgba(255, 215, 0, 0.08)";
      ctx.fill();
      ctx.restore();
    },
  };

  Chart.register(diffFillPlugin);

  function lineDatasets(name1, name2, m1, m2, key) {
    const c = chartColors();
    return {
      labels: MONTHS,
      datasets: [
        {
          label: name1, data: m1.map((m) => +m[key].toFixed(1)),
          borderColor: c.p1, backgroundColor: "rgba(255,107,61,0.25)",
          tension: 0.35, fill: false,
          pointRadius: 5, pointHoverRadius: 9, borderWidth: 3.5,
          pointStyle: "circle",
          pointBackgroundColor: c.p1,
          pointBorderColor: "#fff", pointBorderWidth: 2,
        },
        {
          label: name2, data: m2.map((m) => +m[key].toFixed(1)),
          borderColor: c.p2, backgroundColor: "rgba(0,200,255,0.25)",
          tension: 0.35, fill: false,
          pointRadius: 5, pointHoverRadius: 9, borderWidth: 3.5,
          borderDash: [8, 4],
          pointStyle: "rectRot",
          pointBackgroundColor: c.p2,
          pointBorderColor: "#fff", pointBorderWidth: 2,
        },
      ],
    };
  }

  function barDatasets(name1, name2, m1, m2, key) {
    const c = chartColors();
    return {
      labels: MONTHS,
      datasets: [
        { label: name1, data: m1.map((m) => +m[key].toFixed(2)), backgroundColor: "rgba(255,107,61,0.7)", borderColor: c.p1, borderWidth: 2, borderRadius: 4 },
        { label: name2, data: m2.map((m) => +m[key].toFixed(2)), backgroundColor: "rgba(0,200,255,0.7)", borderColor: c.p2, borderWidth: 2, borderRadius: 4 },
      ],
    };
  }

  function chartOpts(title, yLabel) {
    return {
      responsive: true,
      interaction: { mode: "index", intersect: false },
      plugins: {
        title: { display: true, text: title, font: { size: 14, weight: "700", family: "'Exo 2'" }, color: "#e8edf5" },
        subtitle: { display: true, text: "Tap legend to show/hide a city", font: { size: 11, family: "'Exo 2'", style: "italic" }, color: "#6b7a94", padding: { bottom: 8 } },
        legend: {
          position: "bottom",
          labels: { font: { size: 13, family: "'Exo 2'", weight: "600" }, usePointStyle: true, padding: 20, pointStyleWidth: 14 },
        },
        tooltip: {
          backgroundColor: "rgba(17,24,39,0.95)",
          titleFont: { family: "'Exo 2'", weight: "700" },
          bodyFont: { family: "'Exo 2'" },
          borderColor: "rgba(255,215,0,0.3)",
          borderWidth: 1,
          padding: 12,
          callbacks: {
            label: (ctx) => ` ${ctx.dataset.label}: ${ctx.parsed.y} ${yLabel}`,
          },
        },
      },
      scales: {
        y: { title: { display: true, text: yLabel, font: { family: "'Exo 2'" } }, grid: { color: "rgba(255,255,255,0.04)" } },
        x: { grid: { color: "rgba(255,255,255,0.04)" } },
      },
    };
  }

  function renderCharts(data1, data2, name1, name2) {
    destroyCharts();
    makeChart("chartTemp", { type: "line", data: lineDatasets(name1, name2, data1.monthly, data2.monthly, "tempAvg"), options: chartOpts("Monthly Average Temperature", "\u00b0F") });
    makeChart("chartRealFeel", { type: "line", data: lineDatasets(name1, name2, data1.monthly, data2.monthly, "feelAvg"), options: chartOpts("Monthly Real Feel", "\u00b0F") });
    makeChart("chartPrecip", { type: "bar", data: barDatasets(name1, name2, data1.monthly, data2.monthly, "precip"), options: chartOpts("Monthly Precipitation", "inches/day") });
    makeChart("chartSunshine", { type: "bar", data: barDatasets(name1, name2, data1.monthly, data2.monthly, "sunshine"), options: chartOpts("Monthly Sunshine", "hours/day") });
    makeChart("chartWind", { type: "line", data: lineDatasets(name1, name2, data1.monthly, data2.monthly, "wind"), options: chartOpts("Monthly Max Wind Speed", "mph") });
  }

  // ---- Compare Handler ----
  async function handleCompare() {
    if (!state.loc1 || !state.loc2) return;

    errorEl.classList.add("hidden");
    resultsEl.classList.add("hidden");
    loadingEl.classList.remove("hidden");

    try {
      const [raw1, raw2] = await Promise.all([
        fetchClimate(state.loc1.lat, state.loc1.lon),
        fetchClimate(state.loc2.lat, state.loc2.lon),
      ]);

      const data1 = processData(raw1);
      const data2 = processData(raw2);
      const name1 = state.loc1.name;
      const name2 = state.loc2.name;

      const score1 = comfortScore(data1.overall);
      const score2 = comfortScore(data2.overall);

      renderWinner(score1, score2, name1, name2);
      renderScoreBars(score1, score2, name1, name2);
      renderH2H(data1, data2, name1, name2);
      renderCharts(data1, data2, name1, name2);

      loadingEl.classList.add("hidden");
      resultsEl.classList.remove("hidden");
      resultsEl.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (err) {
      loadingEl.classList.add("hidden");
      errorEl.textContent = "Something went wrong: " + err.message;
      errorEl.classList.remove("hidden");
    }
  }

  // ---- Init ----
  setupSearch(search1, dropdown1, "loc1", selected1);
  setupSearch(search2, dropdown2, "loc2", selected2);
  compareBtn.addEventListener("click", handleCompare);

  document.addEventListener("click", (e) => {
    if (!search1.contains(e.target) && !dropdown1.contains(e.target)) dropdown1.classList.remove("open");
    if (!search2.contains(e.target) && !dropdown2.contains(e.target)) dropdown2.classList.remove("open");
  });
})();
