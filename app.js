(function () {
  "use strict";

  // ---- State ----
  const state = {
    loc1: null, // { name, lat, lon }
    loc2: null,
  };

  // ---- DOM refs ----
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
  const cardsGrid = $("#cardsGrid");

  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const CHART_IDS = ["chartTemp", "chartRealFeel", "chartPrecip", "chartSunshine", "chartWind"];
  const chartInstances = {};

  // ---- Debounce ----
  function debounce(fn, ms) {
    let timer;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  // ---- Geocoding ----
  async function geocode(query) {
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=5&language=en`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("Geocoding request failed");
    const data = await res.json();
    return data.results || [];
  }

  function renderDropdown(items, dropdown, locKey, input, selectedEl) {
    dropdown.innerHTML = "";
    if (!items.length) {
      dropdown.classList.remove("open");
      return;
    }
    items.forEach((item) => {
      const div = document.createElement("div");
      div.className = "dropdown-item";
      const region = [item.admin1, item.country].filter(Boolean).join(", ");
      div.innerHTML = `<span class="city">${item.name}</span> <span class="region">${region}</span>`;
      div.addEventListener("mousedown", (e) => {
        e.preventDefault(); // prevent blur before click
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
      if (q.length < 2) {
        dropdown.classList.remove("open");
        return;
      }
      try {
        const results = await geocode(q);
        renderDropdown(results, dropdown, locKey, input, selectedEl);
      } catch {
        dropdown.classList.remove("open");
      }
    }, 300);

    input.addEventListener("input", () => {
      // Clear previous selection when user edits
      state[locKey] = null;
      selectedEl.textContent = "";
      updateCompareBtn();
      search();
    });

    input.addEventListener("blur", () => {
      setTimeout(() => dropdown.classList.remove("open"), 150);
    });

    input.addEventListener("focus", () => {
      if (dropdown.children.length) dropdown.classList.add("open");
    });
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
        "temperature_2m_max",
        "temperature_2m_min",
        "apparent_temperature_max",
        "apparent_temperature_min",
        "wind_speed_10m_max",
        "sunshine_duration",
        "precipitation_sum",
      ].join(","),
      temperature_unit: "fahrenheit",
      wind_speed_unit: "mph",
      precipitation_unit: "inch",
      timezone: "auto",
    });
    const url = `https://archive-api.open-meteo.com/v1/archive?${params}`;
    const res = await fetch(url);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`API error (${res.status}): ${text}`);
    }
    return res.json();
  }

  // ---- Data Processing ----
  function processData(raw) {
    const d = raw.daily;
    // Build monthly buckets: 0-11
    const buckets = Array.from({ length: 12 }, () => ({
      tempMax: [],
      tempMin: [],
      feelMax: [],
      feelMin: [],
      wind: [],
      sunshine: [],
      precip: [],
    }));

    for (let i = 0; i < d.time.length; i++) {
      const month = new Date(d.time[i] + "T00:00").getMonth();
      const push = (arr, val) => { if (val != null) arr.push(val); };
      push(buckets[month].tempMax, d.temperature_2m_max[i]);
      push(buckets[month].tempMin, d.temperature_2m_min[i]);
      push(buckets[month].feelMax, d.apparent_temperature_max[i]);
      push(buckets[month].feelMin, d.apparent_temperature_min[i]);
      push(buckets[month].wind, d.wind_speed_10m_max[i]);
      // sunshine_duration is in seconds, convert to hours
      if (d.sunshine_duration[i] != null) buckets[month].sunshine.push(d.sunshine_duration[i] / 3600);
      push(buckets[month].precip, d.precipitation_sum[i]);
    }

    const avg = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

    const monthly = buckets.map((b) => ({
      tempAvg: avg(b.tempMax.map((v, j) => (v + b.tempMin[j]) / 2)),
      tempMax: avg(b.tempMax),
      tempMin: avg(b.tempMin),
      feelAvg: avg(b.feelMax.map((v, j) => (v + b.feelMin[j]) / 2)),
      wind: avg(b.wind),
      sunshine: avg(b.sunshine),
      precip: avg(b.precip),
    }));

    // Overall averages across all months (weighted equally)
    const overall = {
      tempAvg: avg(monthly.map((m) => m.tempAvg)),
      tempMax: avg(monthly.map((m) => m.tempMax)),
      tempMin: avg(monthly.map((m) => m.tempMin)),
      feelAvg: avg(monthly.map((m) => m.feelAvg)),
      wind: avg(monthly.map((m) => m.wind)),
      sunshine: avg(monthly.map((m) => m.sunshine)),
      precip: avg(monthly.map((m) => m.precip)),
    };

    return { monthly, overall };
  }

  // ---- Render Cards ----
  function renderCards(data1, data2, name1, name2) {
    cardsGrid.innerHTML = "";

    const metrics = [
      { label: "Average Temperature", key: "tempAvg", unit: "\u00b0F", fmt: 1, higherLabel: "Warmer", lowerLabel: "Cooler" },
      { label: "Real Feel", key: "feelAvg", unit: "\u00b0F", fmt: 1, higherLabel: "Warmer", lowerLabel: "Cooler" },
      { label: "Average High / Low", key: null, unit: "\u00b0F", fmt: 1, custom: true },
      { label: "Max Wind Speed", key: "wind", unit: " mph", fmt: 1, higherLabel: "Windier", lowerLabel: "Calmer" },
      { label: "Sunshine", key: "sunshine", unit: " hrs/day", fmt: 1, higherLabel: "Sunnier", lowerLabel: "Cloudier" },
      { label: "Precipitation", key: "precip", unit: " in/day", fmt: 3, higherLabel: "Wetter", lowerLabel: "Drier" },
    ];

    metrics.forEach((m) => {
      const card = document.createElement("div");
      card.className = "metric-card";

      let v1, v2, display1, display2, indicatorText, indicatorClass;

      if (m.custom) {
        // high/low
        const h1 = data1.overall.tempMax.toFixed(1);
        const l1 = data1.overall.tempMin.toFixed(1);
        const h2 = data2.overall.tempMax.toFixed(1);
        const l2 = data2.overall.tempMin.toFixed(1);
        display1 = `${h1}\u00b0 / ${l1}\u00b0`;
        display2 = `${h2}\u00b0 / ${l2}\u00b0`;
        v1 = data1.overall.tempMax;
        v2 = data2.overall.tempMax;
        indicatorText = v1 > v2 ? "Warmer highs" : v2 > v1 ? "Warmer highs" : "Equal";
        indicatorClass = v1 > v2 ? "warmer" : "cooler";
      } else {
        v1 = data1.overall[m.key];
        v2 = data2.overall[m.key];
        display1 = v1.toFixed(m.fmt) + m.unit;
        display2 = v2.toFixed(m.fmt) + m.unit;
        if (v1 > v2) {
          indicatorText = m.higherLabel;
          indicatorClass = "warmer";
        } else if (v2 > v1) {
          indicatorText = m.higherLabel;
          indicatorClass = "cooler";
        } else {
          indicatorText = "Equal";
          indicatorClass = "warmer";
        }
      }

      // Determine which location the indicator points to
      const indicatorPointsTo = v1 > v2 ? name1 : name2;

      card.innerHTML = `
        <h4>${m.label}</h4>
        <div class="metric-row">
          <div class="metric-loc1">
            <span class="loc-label">${name1}</span>
            <span class="metric-value">${display1}</span>
          </div>
          <span class="indicator ${indicatorClass}">${indicatorPointsTo}: ${indicatorText}</span>
          <div class="metric-loc2">
            <span class="loc-label">${name2}</span>
            <span class="metric-value">${display2}</span>
          </div>
        </div>`;
      cardsGrid.appendChild(card);
    });
  }

  // ---- Render Charts ----
  function destroyCharts() {
    CHART_IDS.forEach((id) => {
      if (chartInstances[id]) {
        chartInstances[id].destroy();
        delete chartInstances[id];
      }
    });
  }

  function makeChart(canvasId, config) {
    const ctx = document.getElementById(canvasId).getContext("2d");
    chartInstances[canvasId] = new Chart(ctx, config);
  }

  function lineDatasets(name1, name2, data1Monthly, data2Monthly, key) {
    return {
      labels: MONTHS,
      datasets: [
        {
          label: name1,
          data: data1Monthly.map((m) => parseFloat(m[key].toFixed(1))),
          borderColor: getComputedStyle(document.documentElement).getPropertyValue("--coral").trim(),
          backgroundColor: "rgba(232,106,80,0.15)",
          tension: 0.3,
          fill: false,
          pointRadius: 4,
          pointHoverRadius: 6,
        },
        {
          label: name2,
          data: data2Monthly.map((m) => parseFloat(m[key].toFixed(1))),
          borderColor: getComputedStyle(document.documentElement).getPropertyValue("--blue").trim(),
          backgroundColor: "rgba(74,144,217,0.15)",
          tension: 0.3,
          fill: false,
          pointRadius: 4,
          pointHoverRadius: 6,
        },
      ],
    };
  }

  function barDatasets(name1, name2, data1Monthly, data2Monthly, key) {
    return {
      labels: MONTHS,
      datasets: [
        {
          label: name1,
          data: data1Monthly.map((m) => parseFloat(m[key].toFixed(2))),
          backgroundColor: "rgba(232,106,80,0.7)",
          borderColor: "#e86a50",
          borderWidth: 1,
          borderRadius: 4,
        },
        {
          label: name2,
          data: data2Monthly.map((m) => parseFloat(m[key].toFixed(2))),
          backgroundColor: "rgba(74,144,217,0.7)",
          borderColor: "#4a90d9",
          borderWidth: 1,
          borderRadius: 4,
        },
      ],
    };
  }

  function chartOpts(title, yLabel) {
    return {
      responsive: true,
      plugins: {
        title: { display: true, text: title, font: { size: 15, weight: "600" } },
        legend: { position: "bottom" },
      },
      scales: {
        y: { title: { display: true, text: yLabel } },
      },
    };
  }

  function renderCharts(data1, data2, name1, name2) {
    destroyCharts();

    makeChart("chartTemp", {
      type: "line",
      data: lineDatasets(name1, name2, data1.monthly, data2.monthly, "tempAvg"),
      options: chartOpts("Monthly Average Temperature", "\u00b0F"),
    });

    makeChart("chartRealFeel", {
      type: "line",
      data: lineDatasets(name1, name2, data1.monthly, data2.monthly, "feelAvg"),
      options: chartOpts("Monthly Real Feel Temperature", "\u00b0F"),
    });

    makeChart("chartPrecip", {
      type: "bar",
      data: barDatasets(name1, name2, data1.monthly, data2.monthly, "precip"),
      options: chartOpts("Monthly Average Precipitation", "inches/day"),
    });

    makeChart("chartSunshine", {
      type: "bar",
      data: barDatasets(name1, name2, data1.monthly, data2.monthly, "sunshine"),
      options: chartOpts("Monthly Average Sunshine", "hours/day"),
    });

    makeChart("chartWind", {
      type: "line",
      data: lineDatasets(name1, name2, data1.monthly, data2.monthly, "wind"),
      options: chartOpts("Monthly Max Wind Speed", "mph"),
    });
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

      // Update header names
      document.querySelector(".loc1-name").textContent = state.loc1.fullName;
      document.querySelector(".loc2-name").textContent = state.loc2.fullName;

      renderCards(data1, data2, name1, name2);
      renderCharts(data1, data2, name1, name2);

      loadingEl.classList.add("hidden");
      resultsEl.classList.remove("hidden");
      resultsEl.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (err) {
      loadingEl.classList.add("hidden");
      errorEl.textContent = "Something went wrong fetching climate data. Please try again. (" + err.message + ")";
      errorEl.classList.remove("hidden");
    }
  }

  // ---- Init ----
  setupSearch(search1, dropdown1, "loc1", selected1);
  setupSearch(search2, dropdown2, "loc2", selected2);
  compareBtn.addEventListener("click", handleCompare);

  // Close dropdowns on outside click
  document.addEventListener("click", (e) => {
    if (!search1.contains(e.target) && !dropdown1.contains(e.target)) dropdown1.classList.remove("open");
    if (!search2.contains(e.target) && !dropdown2.contains(e.target)) dropdown2.classList.remove("open");
  });
})();
