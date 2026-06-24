(function () {
  const TAIL_LINES = 3000;
  const TAIL_BYTES = 1600 * 1024;
  const POLL_MS = 3000;
  const DB_NAME = "poe2-map-tracker";
  const STORE_NAME = "settings";
  const REQUIRED_LOG_FILE = "Client.txt";
  const STATE_VERSION = 6;

  const els = {
    nativePicker: document.getElementById("nativePicker"),
    fullScan: document.getElementById("fullScan"),
    realtimeToggle: document.getElementById("realtimeToggle"),
    clearData: document.getElementById("clearData"),
    startDate: document.getElementById("startDate"),
    watchStatus: document.getElementById("watchStatus"),
    fileName: document.getElementById("fileName"),
    scanMeta: document.getElementById("scanMeta"),
    progressBar: document.getElementById("progressBar"),
    mapCount: document.getElementById("mapCount"),
    uniqueCount: document.getElementById("uniqueCount"),
    bossCount: document.getElementById("bossCount"),
    lastArea: document.getElementById("lastArea"),
    statsBand: document.getElementById("statsBand"),
    statsHeader: document.getElementById("statsHeader"),
    statsHint: document.getElementById("statsHint"),
    locationStats: document.getElementById("locationStats"),
    historyBody: document.getElementById("historyBody"),
    searchBox: document.getElementById("searchBox"),
    filters: Array.from(document.querySelectorAll(".filter"))
  };

  const wikiRows = window.POE2_LOCATION_DATA.maps.map(([name, type, biome, boss]) => ({
    name,
    type,
    biome,
    boss,
    key: normalize(name),
    codeKey: normalizeCodeName(name)
  }));
  const wikiByName = new Map(wikiRows.map((row) => [row.key, row]));
  const wikiByCodeName = new Map(wikiRows.map((row) => [row.codeKey, row]));
  const HIDDEN_TYPES = new Set(["hideout", "town"]);

  let state = {
    fileHandle: null,
    file: null,
    fileName: "",
    lastSize: 0,
    pending: null,
    records: [],
    activeFilter: "all",
    search: "",
    startDate: "",
    realtime: true,
    statsExpanded: false,
    pollTimer: null
  };

  init();

  async function init() {
    wireEvents();
    await restoreSavedState();
    render();
  }

  function wireEvents() {
    els.nativePicker.addEventListener("click", chooseNativeFile);
    els.fullScan.addEventListener("click", () => fullScan());
    els.realtimeToggle.addEventListener("click", toggleRealtime);
    els.clearData.addEventListener("click", clearData);
    els.startDate.addEventListener("change", () => {
      state.startDate = els.startDate.value;
      saveLocalState();
      if (state.file || state.fileHandle) fullScan();
    });
    els.statsHeader.addEventListener("click", toggleStats);
    els.searchBox.addEventListener("input", (event) => {
      state.search = normalizeSearch(event.target.value);
      renderTable();
    });
    els.filters.forEach((button) => {
      button.addEventListener("click", () => {
        state.activeFilter = button.dataset.filter;
        els.filters.forEach((item) => item.classList.toggle("active", item === button));
        renderTable();
      });
    });
  }

  async function chooseNativeFile() {
    if (!window.showOpenFilePicker) {
      els.watchStatus.textContent = "Open in Chrome";
      return;
    }

    const [handle] = await window.showOpenFilePicker({
      multiple: false,
      types: [{ description: "PoE Client log", accept: { "text/plain": [".txt", ".log"] } }]
    });
    const file = await handle.getFile();
    if (file.name !== REQUIRED_LOG_FILE) {
      els.watchStatus.textContent = "Select Client.txt";
      return;
    }
    await saveHandle(handle);
    await loadFile(file, handle, true);
  }

  async function restoreSavedState() {
    const saved = readLocalState();
    const savedLastSize = saved?.lastSize || 0;
    const needsMigrationScan = Boolean(saved && saved.version !== STATE_VERSION);
    if (saved) {
      state.records = (saved.records || []).map(refreshClassification).filter((record) => !HIDDEN_TYPES.has(record.type));
      state.realtime = saved.realtime !== false;
      state.statsExpanded = Boolean(saved.statsExpanded);
      state.startDate = saved.startDate || "";
      state.records = state.records.filter((record) => isOnOrAfterStartDate(record.time));
      recalculateRunCounts();
      recalculateDurations();
      state.lastSize = savedLastSize;
      state.fileName = saved.fileName || "";
    }

    const handle = await readHandle();
    if (!handle) return;

    state.fileHandle = handle;
    const permission = await handle.queryPermission({ mode: "read" });
    if (permission === "granted") {
      const file = await handle.getFile();
      await loadFile(file, handle, false);
      if (needsMigrationScan) {
        await fullScan();
      } else if (savedLastSize > 0 && file.size > savedLastSize) {
        state.lastSize = savedLastSize;
        await pollFile();
      }
      if (state.realtime) startPolling();
    } else {
      els.watchStatus.textContent = "Allow log access";
    }
  }

  async function loadFile(file, handle, scanNow) {
    state.file = file;
    state.fileHandle = handle;
    state.fileName = file.name;
    state.lastSize = file.size;
    els.fileName.textContent = file.name;
    els.watchStatus.textContent = handle && state.realtime ? "Realtime enabled" : "File loaded";

    if (scanNow) {
      await fullScan();
    } else {
      saveLocalState();
    }

    if (handle && state.realtime) startPolling();
    render();
  }

  async function rescanTail() {
    const file = await currentFile();
    if (!file) return;

    setProgress(12, "Reading recent lines");
    const start = Math.max(0, file.size - TAIL_BYTES);
    const text = await file.slice(start).text();
    const lines = text.split(/\r?\n/).slice(-TAIL_LINES);
    const parsed = parseLines(lines, { reset: true });
    state.records = parsed.records;
    state.pending = parsed.pending;
    recalculateDurations();
    recalculateRunCounts();
    state.lastSize = file.size;
    setProgress(100, `${lines.length} lines`);
    saveLocalState();
    render();
  }

  async function fullScan() {
    const file = await currentFile();
    if (!file) return;

    state.records = [];
    state.pending = null;
    const reader = file.stream().getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let loaded = 0;
    let linesCount = 0;
    setProgress(0, "Full scan");

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      loaded += value.byteLength;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      linesCount += lines.length;
      const parsed = parseLines(lines, { reset: false });
      state.pending = parsed.pending;
      setProgress(Math.round((loaded / file.size) * 100), `${linesCount.toLocaleString("en-US")} lines`);
    }

    if (buffer) parseLines([buffer], { reset: false });
    recalculateRunCounts();
    recalculateDurations();
    state.lastSize = file.size;
    setProgress(100, `${linesCount.toLocaleString("en-US")} lines`);
    saveLocalState();
    render();
  }

  async function pollFile() {
    if (!state.realtime) return;
    const file = await currentFile();
    if (!file) return;

    if (file.size < state.lastSize) {
      await rescanTail();
      return;
    }

    if (file.size === state.lastSize) {
      els.watchStatus.textContent = "Waiting for new areas";
      return;
    }

    const text = await file.slice(state.lastSize).text();
    const lines = text.split(/\r?\n/);
    parseLines(lines, { reset: false });
    recalculateRunCounts();
    recalculateDurations();
    state.lastSize = file.size;
    setProgress(100, `+${lines.length} lines`);
    els.watchStatus.textContent = "Updated";
    saveLocalState();
    render();
  }

  function parseLines(lines, options) {
    if (options.reset) {
      state.records = [];
      state.pending = null;
    }

    for (const line of lines) {
      if (!line) continue;
      const generated = line.match(/^(\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}).*Generating level (\d+) area "([^"]+)" with seed (\d+)/);
      if (generated) {
        if (!isOnOrAfterStartDate(parseTime(generated[1]))) {
          state.pending = null;
          continue;
        }
        finalizePending();
        state.pending = {
          id: `${generated[3]}:${generated[4]}:${generated[1]}`,
          instanceKey: instanceKey(generated[3], generated[4]),
          time: parseTime(generated[1]),
          level: Number(generated[2]),
          code: generated[3],
          seed: generated[4],
          name: humanizeCode(generated[3])
        };
        continue;
      }

      const scene = line.match(/^(\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}).*\[SCENE\] Set Source \[(.+)]/);
      if (scene) {
        if (!isOnOrAfterStartDate(parseTime(scene[1]))) continue;
        const name = scene[2].trim();
        if (!name || name === "(null)" || name === "(unknown)") continue;
        if (state.pending) {
          state.pending.name = name;
        } else if (name === "Atlas") {
          pushRecord({ id: `scene:${scene[1]}:${name}`, time: parseTime(scene[1]), name, level: "", code: "", seed: "" });
        }
        continue;
      }

      const loading = line.match(/^(\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}).*\[LOADING SCREEN\] \((.+)\) Duration = ([\d.]+)/);
      if (loading && state.pending) {
        if (!isOnOrAfterStartDate(parseTime(loading[1]))) continue;
        state.pending.name = loading[2].trim();
        state.pending.loadingDuration = Number(loading[3]);
        finalizePending();
      }
    }

    return { records: state.records, pending: state.pending };
  }

  function finalizePending() {
    if (!state.pending) return;
    pushRecord(state.pending);
    state.pending = null;
  }

  function pushRecord(raw) {
    const meta = classify(raw.name, raw.code);
    const record = { ...raw, ...meta };
    record.instanceKey = record.instanceKey || instanceKey(record.code, record.seed);
    const last = state.records[state.records.length - 1];
    if (last && last.instanceKey && last.instanceKey === record.instanceKey) return;
    closePreviousRun(record);
    if (HIDDEN_TYPES.has(record.type)) return;
    record.runCount = countLocationRuns(locationKey(record)) + 1;
    state.records.push(record);
    if (state.records.length > 5000) state.records = state.records.slice(-5000);
  }

  function closePreviousRun(nextRecord) {
    const previous = state.records[state.records.length - 1];
    if (!previous || !isTimedRun(previous)) return;
    if (previous.endTime) return;
    const durationMs = msBetween(previous.time, nextRecord.time);
    if (durationMs > 0) {
      previous.endTime = nextRecord.time;
      previous.durationMs = durationMs;
    }
  }

  function recalculateDurations() {
    for (const record of state.records) {
      delete record.durationMs;
    }

    for (let index = 0; index < state.records.length - 1; index += 1) {
      const record = state.records[index];
      if (!isTimedRun(record)) continue;
      const durationMs = msBetween(record.time, record.endTime || state.records[index + 1].time);
      if (durationMs > 0) record.durationMs = durationMs;
    }

    const last = state.records[state.records.length - 1];
    if (last?.endTime && isTimedRun(last)) {
      const durationMs = msBetween(last.time, last.endTime);
      if (durationMs > 0) last.durationMs = durationMs;
    }
  }

  function recalculateRunCounts() {
    const counts = new Map();
    for (const record of state.records) {
      const key = locationKey(record);
      const nextCount = (counts.get(key) || 0) + 1;
      record.runCount = nextCount;
      counts.set(key, nextCount);
    }
  }

  function countLocationRuns(key) {
    return state.records.reduce((count, record) => count + (locationKey(record) === key ? 1 : 0), 0);
  }

  function locationKey(record) {
    return normalize(record.name || record.code);
  }

  function instanceKey(code, seed) {
    return code && seed ? `${code}:${seed}` : "";
  }

  function isTimedRun(record) {
    return record.type === "map" || record.type === "expedition" || record.type === "boss" || record.type === "special";
  }

  function classify(name, code) {
    const found = wikiByName.get(normalize(name));
    if (found) return { type: found.type, biome: found.biome, boss: found.boss, known: true };

    const codeMatch = matchByCode(code);
    if (codeMatch) return { type: codeMatch.type, biome: codeMatch.biome, boss: codeMatch.boss, known: true };

    const hint = matchHint(name, code);
    if (hint) return { type: hint[1], biome: "", boss: "", known: false };
    if (name === "Atlas") return { type: "town", biome: "", boss: "", known: true };
    if (/town|encampment|caravan|ziggurat/i.test(name)) return { type: "town", biome: "", boss: "", known: false };
    return { type: "map", biome: "", boss: "", known: false };
  }

  function refreshClassification(record) {
    const meta = classify(record.name, record.code);
    return { ...record, ...meta, instanceKey: record.instanceKey || instanceKey(record.code, record.seed) };
  }

  async function currentFile() {
    if (state.fileHandle) {
      const permission = await state.fileHandle.requestPermission({ mode: "read" });
      if (permission !== "granted") {
        els.watchStatus.textContent = "No file access";
        return null;
      }
      state.file = await state.fileHandle.getFile();
      return state.file;
    }
    return state.file;
  }

  function startPolling() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = setInterval(() => pollFile().catch(() => {
      els.watchStatus.textContent = "Waiting for file access";
    }), POLL_MS);
  }

  function stopPolling() {
    if (!state.pollTimer) return;
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }

  function toggleRealtime() {
    state.realtime = !state.realtime;
    if (state.realtime && state.fileHandle) {
      startPolling();
      pollFile();
    } else {
      stopPolling();
      els.watchStatus.textContent = state.fileHandle ? "Realtime disabled" : "No file selected";
    }
    saveLocalState();
    renderRealtimeToggle();
  }

  function toggleStats() {
    state.statsExpanded = !state.statsExpanded;
    saveLocalState();
    renderStatsState();
  }

  async function clearData() {
    stopPolling();
    state.fileHandle = null;
    state.file = null;
    state.fileName = "";
    state.lastSize = 0;
    state.pending = null;
    state.records = [];
    state.startDate = "";
    els.startDate.value = "";
    localStorage.removeItem("poe2-map-tracker-state");
    await deleteHandle();
    setProgress(0, "0 lines");
    els.watchStatus.textContent = "History cleared";
    render();
  }

  function render() {
    els.fileName.textContent = state.fileName || "No log loaded";
    els.startDate.value = state.startDate;
    renderRealtimeToggle();
    renderStatsState();
    renderSummary();
    renderLocationStats();
    renderTable();
  }

  function renderSummary() {
    const maps = state.records.filter((record) => record.type === "map");
    const bosses = state.records.filter((record) => record.type === "boss" || record.type === "special");
    els.mapCount.textContent = maps.length;
    els.uniqueCount.textContent = new Set(maps.map((record) => record.name)).size;
    els.bossCount.textContent = bosses.length;
    const lastVisible = state.records.filter((record) => !HIDDEN_TYPES.has(record.type)).at(-1);
    els.lastArea.textContent = lastVisible ? lastVisible.name : "-";
  }

  function renderLocationStats() {
    const stats = new Map();
    for (const record of state.records) {
      if (HIDDEN_TYPES.has(record.type)) continue;
      const keyName = record.name;
      const key = `${normalize(keyName)}:${record.type}`;
      const current = stats.get(key) || {
        name: keyName,
        type: record.type,
        count: 0,
        totalMs: 0,
        timedCount: 0,
        lastTime: ""
      };
      current.count += 1;
      current.lastTime = record.time;
      if (isTimedRun(record) && record.durationMs) {
        current.totalMs += record.durationMs;
        current.timedCount += 1;
      }
      stats.set(key, current);
    }

    const rows = Array.from(stats.values())
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))

    if (!rows.length) {
      els.locationStats.innerHTML = `<p class="empty-stat">No data yet.</p>`;
      return;
    }

    els.locationStats.innerHTML = rows.map((item) => {
      const averageMs = item.timedCount ? item.totalMs / item.timedCount : 0;
      return `
        <article class="stat-row">
          <div>
            <strong>${escapeHtml(item.name)}</strong>
            <span class="type type-${item.type}">${typeLabel(item.type)}</span>
          </div>
          <b>${item.count}</b>
          <small>${averageMs ? `avg ${formatDuration(averageMs)}` : "time appears after leaving"}</small>
        </article>
      `;
    }).join("");
  }

  function renderTable() {
    const query = state.search;
    const rows = state.records
      .filter((record) => !HIDDEN_TYPES.has(record.type))
      .filter((record) => state.activeFilter === "all" || record.type === state.activeFilter)
      .filter((record) => !query || normalizeSearch(`${record.name} ${record.code} ${record.boss}`).includes(query))
      .slice()
      .reverse()
      .slice(0, 250);

    if (!rows.length) {
      els.historyBody.innerHTML = `<tr><td colspan="6" class="empty">No matching areas yet.</td></tr>`;
      return;
    }

    els.historyBody.innerHTML = rows.map((record) => `
      <tr>
        <td>${escapeHtml(formatTime(record.time))}</td>
        <td>
          <strong>${escapeHtml(record.name)}</strong>
          ${record.boss ? `<small>${escapeHtml(record.boss)}</small>` : ""}
        </td>
        <td><span class="type type-${record.type}">${typeLabel(record.type)}</span></td>
        <td>${escapeHtml(String(record.runCount || ""))}</td>
        <td>${escapeHtml(runDurationLabel(record))}</td>
        <td>${escapeHtml(String(record.level || ""))}</td>
      </tr>
    `).join("");
  }

  function setProgress(percent, label) {
    els.progressBar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
    els.scanMeta.textContent = label;
  }

  function renderRealtimeToggle() {
    els.realtimeToggle.textContent = state.realtime ? "Realtime: on" : "Realtime: off";
    els.realtimeToggle.setAttribute("aria-pressed", String(state.realtime));
    els.realtimeToggle.classList.toggle("active-toggle", state.realtime);
  }

  function renderStatsState() {
    els.statsBand.classList.toggle("expanded", state.statsExpanded);
    els.statsHeader.setAttribute("aria-expanded", String(state.statsExpanded));
    els.statsHint.textContent = state.statsExpanded
      ? "Click to collapse to 3 rows"
      : "Showing first 3 rows. Click to expand";
  }

  function typeLabel(type) {
    return {
      map: "Map",
      expedition: "Expedition",
      hideout: "Hideout",
      boss: "Boss",
      special: "Special",
      town: "Town / UI"
    }[type] || "Area";
  }

  function normalize(value) {
    return String(value || "").toLowerCase().replace(/^the /, "").replace(/\s+/g, " ").trim();
  }

  function normalizeSearch(value) {
    return String(value || "").toLocaleLowerCase().replace(/\s+/g, " ").trim();
  }

  function normalizeCodeName(value) {
    return String(value || "")
      .replace(/^Map/i, "")
      .replace(/^The\s+/i, "")
      .replace(/[^a-z0-9]+/gi, "")
      .toLowerCase();
  }

  function matchByCode(code) {
    if (!code) return null;
    const candidates = codeCandidates(code);
    for (const candidate of candidates) {
      const found = wikiByCodeName.get(candidate);
      if (found) return found;
    }
    return wikiRows.find((row) => candidates.some((candidate) => candidate.includes(row.codeKey) || row.codeKey.includes(candidate))) || null;
  }

  function codeCandidates(code) {
    const raw = String(code || "");
    const parts = raw.split(/[_/\\-]+/).filter(Boolean);
    const candidates = new Set([normalizeCodeName(raw)]);
    for (const part of parts) {
      candidates.add(normalizeCodeName(part));
    }
    candidates.add(normalizeCodeName(raw.replace(/Act\d+/gi, "")));
    candidates.add(normalizeCodeName(raw.replace(/Map/gi, "")));
    return Array.from(candidates).filter(Boolean);
  }

  function matchHint(name, code) {
    const raw = `${code || ""} ${name || ""}`.toLowerCase();
    return window.POE2_LOCATION_DATA.internalHints.find(([needle]) => raw.includes(String(needle).toLowerCase()));
  }

  function humanizeCode(code) {
    return String(code || "")
      .replace(/^Map/, "")
      .replace(/_/g, " ")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .trim() || "Unknown";
  }

  function parseTime(value) {
    return value.replace(/\//g, "-");
  }

  function isOnOrAfterStartDate(value) {
    if (!state.startDate) return true;
    return value.slice(0, 10) >= state.startDate;
  }

  function formatTime(value) {
    return value ? value.replace("T", " ") : "";
  }

  function runDurationLabel(record) {
    if (!isTimedRun(record)) return "";
    return record.durationMs ? formatDuration(record.durationMs) : "running";
  }

  function formatDuration(ms) {
    const totalSeconds = Math.max(0, Math.round(ms / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
    return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  }

  function msBetween(start, end) {
    const startMs = Date.parse(start.replace(" ", "T"));
    const endMs = Date.parse(end.replace(" ", "T"));
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return 0;
    return endMs - startMs;
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    }[char]));
  }

  function saveLocalState() {
    localStorage.setItem("poe2-map-tracker-state", JSON.stringify({
      version: STATE_VERSION,
      records: state.records,
      lastSize: state.lastSize,
      fileName: state.fileName,
      realtime: state.realtime,
      statsExpanded: state.statsExpanded,
      startDate: state.startDate,
      savedAt: Date.now()
    }));
  }

  function readLocalState() {
    try {
      return JSON.parse(localStorage.getItem("poe2-map-tracker-state") || "null");
    } catch {
      return null;
    }
  }

  async function db() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function saveHandle(handle) {
    const database = await db();
    const tx = database.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(handle, "fileHandle");
  }

  async function readHandle() {
    const database = await db();
    return new Promise((resolve) => {
      const tx = database.transaction(STORE_NAME, "readonly");
      const request = tx.objectStore(STORE_NAME).get("fileHandle");
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => resolve(null);
    });
  }

  async function deleteHandle() {
    const database = await db();
    return new Promise((resolve) => {
      const tx = database.transaction(STORE_NAME, "readwrite");
      const request = tx.objectStore(STORE_NAME).delete("fileHandle");
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
    });
  }
})();
