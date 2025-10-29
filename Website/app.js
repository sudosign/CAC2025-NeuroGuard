/* ====================================================
   NeuroGuard App – Technical Enhancements & Fixes
   - Debounce DOM updates via updateUI()
   - Consolidate mouse/touch event handlers
   - Web Worker suggestion: (Placeholder for heavy computations)
   - Improved error handling and cleanup on unload
   - Automatic BLE reconnection logic can be added here
   - Persist settings via localStorage as needed
==================================================== */

/* --------------------- CONFIGURATION --------------------- */
const DOM_FPS = 60;
const RENDER_FPS = 60;
const dataPointsPerSecond = 100;
const SMOOTHING_WINDOW_SIZE = 7;
const VISIBLE_DATA_POINTS = 400;
const NRS_VISIBLE_POINTS = 30;
const Y_BUFFER_PERCENTAGE = 0.15;
const MIN_Y_RANGE = 4;
const NRS_UPDATE_INTERVAL = 5000;
const GYRO_MULTIPLIER = 2.5;
const WHISE_THRESHOLD = 0.1;
const MIN_LINEAR_G = 1;
const MIN_ROTATIONAL_RAD_S2 = 150;
const DEAD_TIME_MS = 770;
const AUTO_ZERO_ENABLED = false;
const STILLNESS_WINDOW_MS = 250;
const AUTO_ZERO_HOLD_MS = 0;
const AUTO_ZERO_COOLDOWN_MS = 250;
const AUTO_ZERO_MIN_UPTIME_MS = 100;
const IMPACT_SUPPRESSION_MS = 0;
const OMEGA_STD_THRESH = 0.12;
const ACCEL_STD_THRESH = 0.25;
const STILL_WINDOW_N = Math.max(5, Math.round(STILLNESS_WINDOW_MS * dataPointsPerSecond / 1000));

/* --------------------- STATE --------------------- */
let lastDomFlush = 0;
let lastFrame = 0;
let lastImpactTime = 0;
let lastNRSUpdate = 0;
let lastGyro = 0;
let connectedAt = 0;
let lastAutoZeroTime = 0;
let stillStart = 0;
let impactDetectionDisabled = true;
let isConnected = false;
let isPaused = false;
let latestSensorData = null;
let currentNRS = 0.0;
let currentAWE = 0.0;
let cli = 0.0;
let latestISS = 0.0;
let nrsUpdateInterval;
let fullscreenChart = null;
let currentFullscreenType = null;
let fullscreenUpdateInterval = null;

const latestDisplay = { a: {}, g: {} };
const impactHistory = [];
const accelHistory = { x: [], y: [], z: [] };
const gyroHistory = { x: [], y: [], z: [] };
const stillBuf = { accel: { x: [], y: [], z: [] }, gyro: { x: [], y: [], z: [] } };
const offsets = { accel: { x: 0, y: 0, z: 9.81 }, gyro: { x: 0, y: 0, z: 0 } };

/* BLE Configuration */
const SERVICE_UUID = "12345678-1234-1234-1234-123456789abc";
const CHARACTERISTIC_UUID = "87654321-4321-4321-4321-cba987654321";
const DEVICE_NAME = "ESP32_MPU6050_BLE";

/* --------------------- DOM ELEMENTS --------------------- */
const nrsScoreEl = document.getElementById('nrs-score');
const nrsLevelEl = document.getElementById('nrs-level');
const aweScoreEl = document.getElementById('awe-score');
const cliScoreEl = document.getElementById('cli-score');

let bleDevice;
let bleCharacteristic;

/* Chart Buffers Map */
const chartBuffers = new Map();

/* --------------------- HELPER FUNCTIONS --------------------- */

/**
 * Calculate the mean of an array.
 */
function mean(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

/**
 * Calculate the standard deviation (sample) of an array.
 */
function std(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const v = arr.reduce((sum, val) => sum + (val - m) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(v);
}

/**
 * Smooth raw sensor data using a moving average.
 */
function smoothData(rawData, historyBuffer) {
  ['x', 'y', 'z'].forEach(axis => {
    historyBuffer[axis].push(rawData[axis]);
    if (historyBuffer[axis].length > SMOOTHING_WINDOW_SIZE) historyBuffer[axis].shift();
  });
  return { x: mean(historyBuffer.x), y: mean(historyBuffer.y), z: mean(historyBuffer.z) };
}

/**
 * Debounced UI update function that limits updates to DOM_FPS.
 */
function updateUI(zeroedA, zeroedG) {
  const now = performance.now();
  if (now - lastDomFlush >= (1000 / DOM_FPS)) {
    lastDomFlush = now;
  }
}

/**
 * Update the connection button status.
 */
function updateConnectionStatus(status) {
  switch (status) {
    case 'connected':
      addSessionMarker('connect');
      showNotification("Connected", "connected");
      break;
    case 'disconnected':
    default:
      addSessionMarker('disconnect');
      showNotification("Disconnected", "disconnected");
      break;
  }
}


/**
 * Customizes connection notification
 */
function showNotification(message, type) {
  const notification = document.getElementById("notification");
  const text = document.getElementById("notification-text");

  text.textContent = message;

  // Reset classes
  notification.className = "fixed top-4 right-4 px-4 py-3 rounded-lg shadow-lg text-white font-medium transition-all duration-300 z-50";

  if (type === "connected") {
    notification.classList.add("bg-green-600");
  } else if (type === "disconnected") {
    notification.classList.add("bg-red-600");
  }

  notification.classList.remove("hidden");
  notification.classList.add("opacity-100");

  // Auto-hide after 3 seconds
  setTimeout(() => {
    notification.classList.add("opacity-0");
    setTimeout(() => {
      notification.classList.add("hidden");
    }, 300);
  }, 3000);
}

/**
 * Add a session marker to chart data for events like connection changes, pause/resume.
 */
function addSessionMarker(type) {
  const now = Date.now();
  const timeStr = new Date(now).toLocaleTimeString();
  [accelChart, gyroChart].forEach(chart => {
    chart.data.labels.push(timeStr);
    chart.data.datasets.forEach(ds => ds.data.push(null));
    chart.$times.push(now);
  });
  if (type === 'pause' || type === 'resume') {
    nrsChart.data.labels.push(timeStr);
    nrsChart.data.datasets[0].data.push(null);
  }
}

/**
 * Toggle paused/resumed state.
 */
function togglePause() {
  if (!isConnected) return;
  const icon = pauseButton.querySelector('.pause-icon');
  const text = pauseButton.querySelector('.pause-text');
  if (isPaused) {
    instantZeroSensors();
    isPaused = false;
    pauseButton.className = 'pause-button pause-inactive';
    icon.textContent = '⏸️';
    text.textContent = 'Pause';
    addSessionMarker('resume');
  } else {
    isPaused = true;
    pauseButton.className = 'pause-button pause-active';
    icon.textContent = '▶️';
    text.textContent = 'Resume';
    addSessionMarker('pause');
  }
}

/**
 * Zero sensor offsets based on current sensor data.
 */
function instantZeroSensors() {
  if (latestSensorData && latestSensorData.sensor) {
    const sd = latestSensorData.sensor;
    offsets.accel = { ...sd.accel };
    offsets.gyro = { ...sd.gyro };
  }
}

/**
 * Check whether sensor readings are "still" based on standard deviation.
 */
function sensorIsAccelStill(buf) {
  if (buf.accel.x.length < STILL_WINDOW_N) return false;
  return Math.max(std(buf.accel.x), std(buf.accel.y), std(buf.accel.z)) < ACCEL_STD_THRESH;
}
function sensorIsGyroStill(buf) {
  if (buf.gyro.x.length < STILL_WINDOW_N) return false;
  return Math.max(std(buf.gyro.x), std(buf.gyro.y), std(buf.gyro.z)) < OMEGA_STD_THRESH;
}

/**
 * Apply auto-zero adjustments for the specified sensor type.
 */
function applyAutoZeroForSensor(kind) {
  if (kind === 'accel') {
    offsets.accel = {
      x: mean(stillBuf.accel.x),
      y: mean(stillBuf.accel.y),
      z: mean(stillBuf.accel.z)
    };
  } else if (kind === 'gyro') {
    offsets.gyro = {
      x: mean(stillBuf.gyro.x),
      y: mean(stillBuf.gyro.y),
      z: mean(stillBuf.gyro.z)
    };
  }
}

/**
 * Check auto-zero conditions and update offsets if conditions are met.
 */
function checkAutoZero() {
  if (!AUTO_ZERO_ENABLED || isPaused) return;
  const now = Date.now();
  if (connectedAt && now - connectedAt < AUTO_ZERO_MIN_UPTIME_MS) return;
  if (now - lastImpactTime < IMPACT_SUPPRESSION_MS) return;
  const accelStill = sensorIsAccelStill(stillBuf);
  const gyroStill = sensorIsGyroStill(stillBuf);
  if (!(accelStill || gyroStill)) {
    stillStart = 0;
    return;
  }
  if (!stillStart) stillStart = now;
  if (now - stillStart < STILLNESS_WINDOW_MS + AUTO_ZERO_HOLD_MS) return;
  if (now - lastAutoZeroTime < AUTO_ZERO_COOLDOWN_MS) return;
  if (accelStill) applyAutoZeroForSensor('accel');
  if (gyroStill) applyAutoZeroForSensor('gyro');
  lastAutoZeroTime = now;
  stillStart = 0;
}

/**
 * Save impact history and state to localStorage.
 */
function saveImpactHistory() {
  try {
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(impactHistory));
    localStorage.setItem(NRS_STATE_KEY, JSON.stringify({
      lastUpdate: Date.now(),
      currentNRS,
      currentAWE,
      cli,
      latestISS
    }));
  } catch (e) {
    console.error("Failed to save history:", e);
  }
}

/**
 * Load impact history and state from localStorage.
 */
function loadImpactHistory() {
  try {
    const stored = localStorage.getItem(LOCAL_STORAGE_KEY);
    const nrsState = localStorage.getItem(NRS_STATE_KEY);
    if (stored) {
      impactHistory.push(...JSON.parse(stored));
      if (nrsState) {
        const state = JSON.parse(nrsState);
        cli = state.cli || 0;
        latestISS = state.latestISS || 0;
      }
      rebuildNRSChart();
      recalculateRiskScores();
    }
  } catch (e) {
    console.error("Failed to load history:", e);
  }
}

/**
 * Clear impact history and reset state.
 */
function clearImpactHistory() {
  impactHistory.length = 0;
  currentNRS = 0.0;
  currentAWE = 0.0;
  latestISS = 0.0;
  cli = 0.0;
  localStorage.removeItem(LOCAL_STORAGE_KEY);
  localStorage.removeItem(NRS_STATE_KEY);
  rebuildNRSChart();
  resetRiskScores();
  showCustomAlert("Impact history cleared.");
}

/**
 * Rebuild the NRS chart from impact history data.
 */
function rebuildNRSChart() {
  nrsChart.data.labels = [];
  nrsChart.data.datasets[0].data = [];
  impactHistory.forEach(impact => {
    if (typeof impact.nrs === 'number') {
      nrsChart.data.labels.push(new Date(impact.time).toLocaleTimeString());
      nrsChart.data.datasets[0].data.push(impact.nrs);
    }
  });
  if (nrsChart.data.labels.length > NRS_VISIBLE_POINTS) {
    const e = nrsChart.data.labels.length - NRS_VISIBLE_POINTS;
    nrsChart.data.labels.splice(0, e);
    nrsChart.data.datasets[0].data.splice(0, e);
  }
  nrsChart.update('none');
}

/**
 * Recalculate risk scores from the impact history.
 */
function recalculateRiskScores() {
  if (!impactHistory.length) {
    resetRiskScores();
    return;
  }
  const now = Date.now();
  const oneDay = 86400000;
  const recentImpacts = impactHistory.filter(imp => now - imp.time < 7 * oneDay);
  let awe = 0;
  recentImpacts.forEach(imp => {
    const daysAgo = (now - imp.time) / oneDay;
    awe += imp.iss * Math.exp(-0.4 * daysAgo);
  });
  currentAWE = awe;
  if (recentImpacts.length > 0) {
    const latestImpact = recentImpacts[recentImpacts.length - 1];
    latestISS = latestImpact.iss;
    const nrs = (0.35 * impact.iss + 0.35 * awe + 0.2 * cli) * 3;
    currentNRS = Math.round(nrs * 10) / 10;
    nrsScoreEl.textContent = currentNRS.toFixed(1);
    aweScoreEl.textContent = awe.toFixed(2);
    cliScoreEl.textContent = cli.toFixed(2);
    updateRiskLevel(currentNRS);
    latestImpact.nrs = currentNRS;
    latestImpact.awe = awe;
    latestImpact.cli = cli;
  } else {
    resetRiskScores();
  }
}

/**
 * Update risk level UI based on NRS score.
 */
function updateRiskLevel(nrs) {
  if (nrs < 3) {
    nrsLevelEl.className = 'risk-level risk-low';
    nrsLevelEl.textContent = 'Low Risk';
  } else if (nrs < 6) {
    nrsLevelEl.className = 'risk-level risk-moderate';
    nrsLevelEl.textContent = 'Moderate';
  } else if (nrs < 8) {
    nrsLevelEl.className = 'risk-level risk-high';
    nrsLevelEl.textContent = 'High - Evaluate';
  } else {
    nrsLevelEl.className = 'risk-level risk-severe';
    nrsLevelEl.textContent = 'Severe - Stop';
  }
}

/**
 * Reset risk scores on the UI.
 */
function resetRiskScores() {
  nrsScoreEl.textContent = "0.0";
  nrsLevelEl.className = 'risk-level risk-low';
  nrsLevelEl.textContent = 'Low Risk';
  aweScoreEl.textContent = "0.0";
  cliScoreEl.textContent = "0.0";
  currentNRS = 0.0;
  currentAWE = 0.0;
  latestISS = 0.0;
}

/* --------------------- CHART INITIALIZATION --------------------- */
// Initialize NRS Chart
const nrsChart = new Chart(document.getElementById('nrsChartCanvas').getContext('2d'), {
  type: 'line',
  data: {
    labels: [],
    datasets: [{
      label: 'NRS',
      data: [],
      borderColor: 'rgba(255, 99, 132, 1)',
      backgroundColor: 'rgba(255, 99, 132, 0.2)',
      borderWidth: 2,
      fill: true,
      tension: 0.2,
      pointRadius: 0,
      spanGaps: false,
    }],
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 0 },
    plugins: {
      legend: {
        labels: {
          font: { family: "IBM Plex Sans", size: 14, weight: "500" },
          color: "#ffffff"
        }
      },
      tooltip: {
        mode: 'index',
        intersect: false,
        titleFont: { family: "IBM Plex Sans", size: 14, weight: "500" },
        bodyFont: { family: "IBM Plex Sans", size: 14, weight: "400" },
        titleColor: "#ffffff",
        bodyColor: "#ffffff",
        backgroundColor: "#1d2126"
      },
      zoom: {
        pan: { enabled: true, mode: 'xy', speed: 0.0025 },
        zoom: { wheel: { enabled: true, speed: 0.005 }, pinch: { enabled: true }, mode: 'xy' }
      }
    },
    scales: {
      x: {
        title: { display: true, text: 'Time', color: '#a0a0a0', font: { family: "IBM Plex Sans", size: 14 } },
        ticks: { color: '#e0e0e0', maxTicksLimit: 8, autoSkip: true, font: { family: "IBM Plex Sans", size: 14, weight: "400" } },
        grid: { color: 'rgba(255,255,255,0.1)' },
      },
      y: {
        min: 0,
        max: 10,
        title: { display: true, text: 'NRS', color: '#a0a0a0', font: { family: "IBM Plex Sans", size: 14 } },
        ticks: { color: '#e0e0e0', stepSize: 1, font: { family: "IBM Plex Sans", size: 14, weight: "400" } },
        grid: { color: 'rgba(255,255,255,0.1)' },
      }
    },
    elements: { point: { radius: 0 } }
  },
});

/**
 * Helper function to create accelerometer and gyroscope charts.
 */
function createChart(ctx, labelPrefix, yAxisLabel) {
  const chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        {
          label: `${labelPrefix} X`,
          borderColor: 'rgb(239, 68, 68)',
          data: [],
          tension: 0.1,
          pointRadius: 0,
        },
        {
          label: `${labelPrefix} Y`,
          borderColor: 'rgb(59, 130, 246)',
          data: [],
          tension: 0.1,
          pointRadius: 0,
        },
        {
          label: `${labelPrefix} Z`,
          borderColor: 'rgb(16, 185, 129)',
          data: [],
          tension: 0.1,
          pointRadius: 0,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          labels: { 
            usePointStyle: true, 
            boxWidth: 8, 
            padding: 16, 
            color: '#e0e0e0',
            font: { family: "IBM Plex Sans", size: 12, weight: "400" }
          },
        },
        tooltip: {
          callbacks: {
            title: (items) => {
              const t = items[0].chart.$times?.[items[0].dataIndex];
              return t ? `Time: ${new Date(t).toLocaleTimeString()}` : '';
            },
          },
          titleFont: { family: "IBM Plex Sans", size: 14, weight: "500" },
          bodyFont: { family: "IBM Plex Sans", size: 14, weight: "400" },
          titleColor: "#ffffff",
          bodyColor: "#ffffff",
          backgroundColor: "#1d2126"
        },
        zoom: {
          pan: { enabled: true, mode: 'x', speed: 0.0025 },
          zoom: { wheel: { enabled: true, speed: 0.005 }, pinch: { enabled: true }, mode: 'y' }
        },
      },
      scales: {
        x: {
          title: { display: true, text: 'Time', color: '#a0a0a0', font: { family: "IBM Plex Sans", size: 14 } },
          ticks: { display: false, font: { family: "IBM Plex Sans", size: 12 } },
          grid: { display: false },
        },
        y: {
          title: { display: true, text: yAxisLabel, color: '#a0e0e0', font: { family: "IBM Plex Sans", size: 14 } },
          min: -MIN_Y_RANGE,
          max: MIN_Y_RANGE,
          ticks: {
            stepSize: 1,
            color: '#e0e0e0',
            font: { family: "IBM Plex Sans", size: 14 },
            callback: v => parseFloat(v.toFixed(1)),
          },
          grid: {
            color: ctx => (ctx.tick.value === 0 ? 'rgba(255,255,255,0.7)' : 'rgba(255,255,255,0.1)'),
            lineWidth: ctx => (ctx.tick.value === 0 ? 2 : 1),
          },
        },
      },
      elements: { point: { radius: 0 } },
    },
  });
  chart.$times = [];
  return chart;
}

const accelChart = createChart(document.getElementById('accelChartCanvas').getContext('2d'), 'Accel', 'm/s²');
const gyroChart = createChart(document.getElementById('gyroChartCanvas').getContext('2d'), 'Gyro', 'rad/s');
chartBuffers.set(accelChart, { x: [], y: [], z: [], labels: [], times: [] });
chartBuffers.set(gyroChart, { x: [], y: [], z: [], labels: [], times: [] });

/* --------------------- CHART INTERACTIONS & FULLSCREEN --------------------- */
/**
 * Consolidated function to add mouse and touch event listeners,
 * reducing duplicate code.
 */
function addInteractionListeners(canvas, chart, type) {
  let holdTimeout, isHolding = false, isDragging = false;
  const startHandler = () => {
    isHolding = false;
    isDragging = false;
    holdTimeout = setTimeout(() => {
      if (!isDragging) {
        isHolding = true;
        chart.resetZoom();
        canvas.style.opacity = '0.7';
        setTimeout(() => { canvas.style.opacity = '1'; }, 200);
      }
    }, 500);
  };
  const moveHandler = () => {
    if (!isHolding) {
      isDragging = true;
      clearTimeout(holdTimeout);
    }
  };
  const endHandler = () => {
    clearTimeout(holdTimeout);
    isDragging = false;
  };
  canvas.addEventListener('mousedown', startHandler);
  canvas.addEventListener('mousemove', moveHandler);
  canvas.addEventListener('mouseup', endHandler);
  canvas.addEventListener('mouseleave', endHandler);
  canvas.addEventListener('touchstart', startHandler);
  canvas.addEventListener('touchend', endHandler);
  canvas.addEventListener('dblclick', (e) => {
    e.preventDefault();
    openFullscreen(type);
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
}

function setupChartInteractions() {
  const charts = [
    { canvas: document.getElementById('nrsChartCanvas'), chart: nrsChart, type: 'nrs' },
    { canvas: document.getElementById('accelChartCanvas'), chart: accelChart, type: 'accel' },
    { canvas: document.getElementById('gyroChartCanvas'), chart: gyroChart, type: 'gyro' },
  ];
  charts.forEach(item => addInteractionListeners(item.canvas, item.chart, item.type));
}

/**
 * Schedule a chart data point.
 */
function scheduleChartPoint(chart, timeMs, x, y, z) {
  const buf = chartBuffers.get(chart);
  buf.x.push(x);
  buf.y.push(y);
  buf.z.push(z);
  buf.labels.push('');
  buf.times.push(timeMs);
}

/**
 * Commit buffered chart data. Batches updates to avoid redrawing on every point.
 */
function commitChart(chart, buf) {
  if (!buf.x.length) return;
  const ds = chart.data.datasets;
  ds[0].data.push(...buf.x);
  ds[1].data.push(...buf.y);
  ds[2].data.push(...buf.z);
  chart.data.labels.push(...buf.labels);
  chart.$times.push(...buf.times);
  const over = chart.data.labels.length - VISIBLE_DATA_POINTS;
  if (over > 0) {
    ds.forEach(dataset => dataset.data.splice(0, over));
    chart.data.labels.splice(0, over);
    chart.$times.splice(0, over);
  }
  let maxAbs = 0;
  ds[0].data.forEach((val, i) => {
    if (val !== null) {
      maxAbs = Math.max(maxAbs, Math.abs(val), Math.abs(ds[1].data[i]), Math.abs(ds[2].data[i]));
    }
  });
  const desired = Math.max(maxAbs * (1 + Y_BUFFER_PERCENTAGE), MIN_Y_RANGE);
  const roundedDesired = Math.ceil(desired * 10) / 10;
  if (Math.abs(chart.options.scales.y.max - roundedDesired) > 0.1) {
    chart.options.scales.y.min = -roundedDesired;
    chart.options.scales.y.max = roundedDesired;
  }
  chart.update('none');
  buf.x.length = buf.y.length = buf.z.length = buf.labels.length = buf.times.length = 0;
}

function rafCommit(t) {
  if (t - lastFrame >= (1000 / RENDER_FPS)) {
    chartBuffers.forEach((buf, chart) => commitChart(chart, buf));
    lastFrame = t;
  }
  requestAnimationFrame(rafCommit);
}
requestAnimationFrame(rafCommit);

/* --------------------- SENSOR & IMPACT HANDLING --------------------- */
/**
 * Push sensor values into a stillness buffer for auto-zero detection.
 */
function pushStillnessSample(accel, gyro) {
  ['x', 'y', 'z'].forEach(axis => {
    stillBuf.accel[axis].push(accel[axis]);
    if (stillBuf.accel[axis].length > STILL_WINDOW_N) stillBuf.accel[axis].shift();
    stillBuf.gyro[axis].push(gyro[axis] * GYRO_MULTIPLIER);
    if (stillBuf.gyro[axis].length > STILL_WINDOW_N) stillBuf.gyro[axis].shift();
  });
}

/**
 * Detect an impact event based on sensor thresholds.
 */
function detectImpact(a, g) {
  if (impactDetectionDisabled || isPaused) return;
  const now = Date.now();
  if (now - lastImpactTime < DEAD_TIME_MS) return;
  const aMagnitude = Math.sqrt(a.x ** 2 + a.y ** 2 + a.z ** 2);
  const aInG = aMagnitude / 9.81;
  const gAdjusted = {
    x: g.x * GYRO_MULTIPLIER,
    y: g.y * GYRO_MULTIPLIER,
    z: g.z * GYRO_MULTIPLIER,
  };
  const omega = Math.sqrt(gAdjusted.x ** 2 + gAdjusted.y ** 2 + gAdjusted.z ** 2);
  const alpha = (omega - lastGyro) / 0.01;
  lastGyro = omega;
  if (aInG < MIN_LINEAR_G) return;
  if (Math.abs(alpha) < MIN_ROTATIONAL_RAD_S2) return;
  const whise = 0.4 * (aInG / 100) + 0.6 * (Math.abs(alpha) / 6000);
  if (whise >= WHISE_THRESHOLD) {
    lastImpactTime = now;
    const iss = Math.log10(1 + aInG * 0.8) * (1 + Math.abs(alpha) / 4500) * 0.75;
    const impact = { time: now, a_peak: aInG, alpha_peak: Math.abs(alpha), iss: parseFloat(iss.toFixed(2)) };
    impactHistory.push(impact);
    saveImpactHistory();
    processImpact(impact);
  }
}

/**
 * Process an impact event, update risk scores, and show alerts.
 */
function processImpact(impact) {
  cli = 0.99 * cli + (1 - 0.99) * impact.iss;
  const now = Date.now();
  let awe = 0;
  impactHistory.forEach(imp => {
    const daysAgo = (now - imp.time) / 86400000;
    awe += imp.iss * Math.exp(-0.4 * daysAgo);
  });
  currentAWE = awe;
  latestISS = impact.iss;
  const nrs = 0.35 * impact.iss + 0.35 * awe + 0.2 * cli;
  const nrsRounded = Math.round(nrs * 10) / 10;
  currentNRS = nrsRounded;
  impact.nrs = nrsRounded;
  impact.awe = awe;
  impact.cli = cli;
  nrsScoreEl.textContent = nrsRounded.toFixed(1) * 3;
  aweScoreEl.textContent = awe.toFixed(2);
  cliScoreEl.textContent = cli.toFixed(2);
  updateRiskLevel(nrsRounded);
  if (nrsRounded >= 8) showCustomAlert('severe', { nrs: nrsRounded });
  else if (nrsRounded >= 6) showCustomAlert('high', { nrs: nrsRounded });
  updateNRSRealtime();
  startNRSUpdateInterval();
}

/**
 * Update NRS chart in real time.
 */
function updateNRSRealtime() {
  const now = Date.now();
  let awe = 0;
  impactHistory.forEach(imp => {
    const daysAgo = (now - imp.time) / 86400000;
    awe += imp.iss * Math.exp(-0.4 * daysAgo);
  });
  currentAWE = awe;
  const nrs = (0.35 * latestISS + 0.35 * awe + 0.2 * cli) * 3;
  currentNRS = Math.max(0, nrs);
  nrsScoreEl.textContent = currentNRS.toFixed(1);
  aweScoreEl.textContent = awe.toFixed(2);
  updateRiskLevel(currentNRS);
  nrsChart.data.labels.push(new Date(now).toLocaleTimeString());
  nrsChart.data.datasets[0].data.push(currentNRS);
  if (nrsChart.data.labels.length > NRS_VISIBLE_POINTS) {
    nrsChart.data.labels.shift();
    nrsChart.data.datasets[0].data.shift();
  }
  nrsChart.update('none');
  lastNRSUpdate = now;
  saveImpactHistory();
}

/**
 * Start the interval that updates the NRS chart.
 */
function startNRSUpdateInterval() {
  if (nrsUpdateInterval) clearInterval(nrsUpdateInterval);
  nrsUpdateInterval = setInterval(updateNRSRealtime, NRS_UPDATE_INTERVAL);
}
startNRSUpdateInterval();

/* --------------------- BLE & SENSOR --------------------- */
/**
 * Connect to the BLE device and start notifications.
 */
async function connectToBle() {
  try {
    updateConnectionStatus('connecting');
    if (!navigator.bluetooth) throw new Error("Web Bluetooth not supported.");
    bleDevice = await navigator.bluetooth.requestDevice({
      filters: [{ name: DEVICE_NAME }],
      optionalServices: [SERVICE_UUID],
    });
    bleDevice.addEventListener('gattserverdisconnected', onDisconnected);
    const server = await bleDevice.gatt.connect();
    const service = await server.getPrimaryService(SERVICE_UUID);
    bleCharacteristic = await service.getCharacteristic(CHARACTERISTIC_UUID);
    await bleCharacteristic.startNotifications();
    bleCharacteristic.addEventListener('characteristicvaluechanged', handleCharacteristicValueChanged);
    updateConnectionStatus('connected');
    pauseButton.classList.remove('hidden');
    connectedAt = Date.now();
    impactDetectionDisabled = true;
    setTimeout(() => {
      instantZeroSensors();
      impactDetectionDisabled = false;
    }, 500);
  } catch (error) {
    console.error("BLE Connection error:", error);
    updateConnectionStatus('disconnected');
    showCustomAlert(error.name === 'NotFoundError' ? "No device selected." : `BLE Error: ${error.message}`);
  }
}

/**
 * Disconnect from the BLE device.
 */
async function disconnectBle() {
  if (bleDevice && bleDevice.gatt.connected) await bleDevice.gatt.disconnect();
}

/**
 * Handle BLE disconnect event.
 */
function onDisconnected() {
  updateConnectionStatus('disconnected');
  pauseButton.classList.add('hidden');
  impactDetectionDisabled = true;
  isPaused = false;
}

/**
 * Handle BLE characteristic value changes.
 */
function handleCharacteristicValueChanged(event) {
  const value = event.target.value;
  const decoder = new TextDecoder('utf-8');
  let receivedString = "";
  try {
    receivedString = decoder.decode(value);

    // Parse JSON safely with a try-catch.
    try {
      latestSensorData = JSON.parse(receivedString);
    } catch (e) {
      console.error("JSON parse error:", e);
      return;
    }
    if (isPaused || !latestSensorData.sensor) return;

    const smoothedA = smoothData(latestSensorData.sensor.accel, accelHistory);
    const smoothedG = smoothData(latestSensorData.sensor.gyro, gyroHistory);
    const zeroedA = {
      x: smoothedA.x - offsets.accel.x,
      y: smoothedA.y - offsets.accel.y,
      z: smoothedA.z - offsets.accel.z,
    };
    const zeroedG = {
      x: (smoothedG.x - offsets.gyro.x) * GYRO_MULTIPLIER,
      y: (smoothedG.y - offsets.gyro.y) * GYRO_MULTIPLIER,
      z: (smoothedG.z - offsets.gyro.z) * GYRO_MULTIPLIER,
    };
    latestDisplay.g = zeroedA;
    latestDisplay.a = zeroedG;
    pushStillnessSample(smoothedA, smoothedG);
    detectImpact(zeroedA, zeroedG);
    updateUI(zeroedA, zeroedG);

    const nowMs = Date.now();
    scheduleChartPoint(accelChart, nowMs, zeroedG.x, zeroedG.y, zeroedG.z);
    scheduleChartPoint(gyroChart, nowMs, zeroedA.x, zeroedA.y, zeroedA.z);
    checkAutoZero();
  } catch (e) {
    console.error("Error in characteristic handler:", e);
  }
}

const searchBtn = document.getElementById("searchBtn");
const deviceList = document.getElementById("deviceList");
const bluetoothModal = document.getElementById("bluetoothModal");

searchBtn.addEventListener("click", async () => {
  deviceList.innerHTML = `<p class="text-gray-400 text-sm">Scanning...</p>`;

  try {
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ name: DEVICE_NAME }],
      optionalServices: [SERVICE_UUID]
    });

    deviceList.innerHTML = `
      <button id="deviceSelect" 
              class="w-full px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-left">
        ${device.name || "Unnamed Device"}
      </button>`;

    document.getElementById("deviceSelect").addEventListener("click", async () => {
      try {
        updateConnectionStatus("connecting");

        const server = await device.gatt.connect();
        bleDevice = device;
        const service = await server.getPrimaryService(SERVICE_UUID);
        bleCharacteristic = await service.getCharacteristic(CHARACTERISTIC_UUID);

        await bleCharacteristic.startNotifications();
        bleCharacteristic.addEventListener(
          "characteristicvaluechanged",
          handleCharacteristicValueChanged
        );

        isConnected = true;
        connectedAt = Date.now();
        updateConnectionStatus("connected");
        bluetoothModal.classList.add("hidden");

        impactDetectionDisabled = true;
        setTimeout(() => {
          instantZeroSensors();
          impactDetectionDisabled = false;
        }, 500);

        bleDevice.addEventListener("gattserverdisconnected", () => {
          isConnected = false;
          updateConnectionStatus("disconnected");
          bluetoothModal.classList.remove("hidden");
        });

      } catch (err) {
        console.error("Connection failed:", err);
        showNotification("Connection failed", "disconnected");
      }
    });


  } catch (err) {
    deviceList.innerHTML = `<p class="text-red-500 text-sm">No devices found or permission denied.</p>`;
    console.error("Device request failed:", err);
  }
});

/* --------------------- EVENT LISTENERS & CLEANUP --------------------- */
window.addEventListener('beforeunload', () => {
  if (nrsUpdateInterval) clearInterval(nrsUpdateInterval);
  if (fullscreenUpdateInterval) clearInterval(fullscreenUpdateInterval);
});

window.addEventListener("DOMContentLoaded", () => {
  setupChartInteractions();
});
