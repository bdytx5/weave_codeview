import json
from pathlib import Path
from flask import Flask, jsonify, render_template_string, request

RUNS_DIR = Path("runs")

app = Flask(__name__)

HTML = """
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>WV Trace Viewer</title>

<style>
* { box-sizing: border-box; margin: 0; padding: 0; }

body {
    font-family: Arial, sans-serif;
    background: #0f1117;
    color: #e6edf3;
    display: flex;
    flex-direction: column;
    height: 100vh;
    overflow: hidden;
}

/* ── Header ── */
#header {
    height: 48px;
    min-height: 48px;
    background: #161b22;
    border-bottom: 1px solid #30363d;
    display: flex;
    align-items: center;
    padding: 0 16px;
    gap: 12px;
}

#header h2 { font-size: 16px; flex: 1; }

select, button {
    padding: 5px 10px;
    background: #21262d;
    border: 1px solid #30363d;
    color: #e6edf3;
    border-radius: 4px;
    cursor: pointer;
    font-size: 13px;
}

select:focus, button:focus { outline: none; border-color: #58a6ff; }
button:hover { background: #30363d; }

/* ── Main layout ── */
#main {
    display: flex;
    flex: 1;
    overflow: hidden;
}

/* ── Code panel ── */
#codePanel {
    width: 50%;
    border-right: 1px solid #30363d;
    overflow-y: auto;
    font-family: 'SFMono-Regular', Consolas, monospace;
    font-size: 13px;
}

#codePanel .empty-msg {
    padding: 20px;
    color: #8b949e;
    font-style: italic;
}

.code-line {
    display: flex;
    align-items: stretch;
    min-height: 20px;
    line-height: 20px;
}

.code-line .ln {
    width: 48px;
    min-width: 48px;
    text-align: right;
    padding-right: 12px;
    color: #484f58;
    user-select: none;
    background: #0d1117;
    border-right: 2px solid transparent;
    flex-shrink: 0;
}

.code-line .code {
    padding-left: 12px;
    white-space: pre;
    flex: 1;
    overflow: hidden;
}

/* Clickable fn lines */
.code-line.fn-line {
    cursor: pointer;
}

.code-line.fn-line:hover .ln {
    border-right-color: #58a6ff;
    color: #8b949e;
}

.code-line.fn-line:hover {
    background: #1c2128;
}

/* Filter selected highlight */
.code-line.selected .ln {
    border-right-color: #58a6ff;
    color: #58a6ff;
}

.code-line.selected {
    background: #1c2128;
}

/* Playback active highlight */
.code-line.line-highlight-active .ln {
    border-right-color: #58a6ff;
    background: #1a2332;
    color: #79c0ff;
}

.code-line.line-highlight-active {
    background: #1a2332;
}

/* ── Right panel ── */
#rightPanel {
    width: 50%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
}

/* ── Trace list ── */
#traceListContainer {
    flex: 1;
    overflow-y: auto;
    padding: 8px;
}

.trace {
    border: 1px solid #30363d;
    border-radius: 6px;
    margin-bottom: 6px;
    background: #161b22;
    transition: box-shadow 0.15s;
}

.trace-header {
    cursor: pointer;
    display: flex;
    justify-content: space-between;
    padding: 8px 10px;
    font-size: 13px;
}

.trace-header:hover { background: #1c2128; border-radius: 6px; }

.trace-details {
    display: none;
    margin: 0 10px 10px;
    white-space: pre-wrap;
    font-family: monospace;
    font-size: 12px;
    background: #0d1117;
    padding: 8px;
    border-radius: 4px;
}

.trace.error .trace-header { color: #ff6b6b; }

.trace.playback-active {
    box-shadow: 0 0 0 2px #58a6ff;
}

/* ── Playback bar ── */
#playbackBar {
    border-top: 1px solid #30363d;
    padding: 10px 12px;
    background: #161b22;
    display: flex;
    flex-direction: column;
    gap: 8px;
}

#playbackControls {
    display: flex;
    align-items: center;
    gap: 8px;
}

#playbackStatus {
    font-size: 12px;
    color: #8b949e;
}

#speedControl {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: #8b949e;
}

#speedSlider {
    width: 80px;
    accent-color: #58a6ff;
}

/* ── I/O panel ── */
#ioPanel {
    border-top: 1px solid #30363d;
    padding: 12px 14px;
    background: #0d1117;
    font-family: monospace;
    font-size: 13px;
    height: 220px;
    min-height: 220px;
    flex-shrink: 0;
    overflow-y: auto;
}

#ioPanel .io-empty { color: #484f58; font-style: italic; }

#ioPanel .io-label {
    font-weight: bold;
    margin-bottom: 2px;
}

#ioPanel .io-inputs { color: #58a6ff; margin-bottom: 6px; }
#ioPanel .io-output { color: #3fb950; }
#ioPanel .io-error  { color: #ff6b6b; }
</style>
</head>

<body>

<div id="header">
    <h2>WV Trace Viewer</h2>
    <label style="font-size:13px;color:#8b949e">Run:</label>
    <select id="runPicker"></select>
    <label style="font-size:13px;color:#8b949e">File:</label>
    <select id="filePicker"></select>
    <button onclick="refresh()">Refresh</button>
</div>

<div id="main">
    <!-- Left: code panel -->
    <div id="codePanel">
        <div class="empty-msg">Loading source…</div>
    </div>

    <!-- Right: traces + playback + IO -->
    <div id="rightPanel">
        <div id="traceListContainer"></div>

        <div id="playbackBar">
            <div id="playbackControls">
                <button id="btnPrev" onclick="stepPrev()">&#9664; Prev</button>
                <button id="btnPlay" onclick="togglePlay()">&#9654; Play</button>
                <button id="btnNext" onclick="stepNext()">Next &#9654;</button>
                <span id="playbackStatus">Step — / —</span>
            </div>
            <div id="speedControl">
                Speed:
                <input type="range" id="speedSlider" min="0" max="4" step="1" value="2">
                <span id="speedLabel">1x</span>
            </div>
        </div>

        <div id="ioPanel">
            <div class="io-empty">Select a trace or use playback to see I/O.</div>
        </div>
    </div>
</div>

<script>
// ─────────────────────────────────────────────
// State
// ─────────────────────────────────────────────
let allTraces = []          // all traces, chronological
let filteredTraces = []     // current trace list (may be filtered)
let activeFilter = null     // fn name filter from code click
let fnLineMap = {}          // fnName -> {decorator_line, start_line, end_line}
let currentFile = null
let currentRun = null

let playStep = -1           // current playback index into allTraces
let playTimer = null        // setTimeout handle
let isPlaying = false

// Base delay in ms per step at 1x speed
const BASE_DELAY_MS = 1200
const SPEED_VALUES = [0.25, 0.5, 1, 2, 4]

// ─────────────────────────────────────────────
// Init
// ─────────────────────────────────────────────
async function init() {
    await loadRuns()
    await loadTracesAndSource()
}

async function refresh() {
    await loadRuns(true)
    await loadTracesAndSource()
}

async function loadRuns(keepCurrent = false) {
    const res = await fetch("/runs")
    const runs = await res.json()

    const picker = document.getElementById("runPicker")
    const prev = currentRun

    picker.innerHTML = ""

    if (runs.length === 0) {
        const opt = document.createElement("option")
        opt.value = ""
        opt.textContent = "(no runs)"
        picker.appendChild(opt)
        currentRun = null
        return
    }

    runs.forEach(r => {
        const opt = document.createElement("option")
        opt.value = r.id
        opt.textContent = r.label
        picker.appendChild(opt)
    })

    if (keepCurrent && prev && runs.find(r => r.id === prev)) {
        picker.value = prev
        currentRun = prev
    } else {
        currentRun = runs[0].id
        picker.value = currentRun
    }

    picker.onchange = async () => {
        currentRun = picker.value
        activeFilter = null
        playStep = -1
        pausePlay()
        await loadFiles()
        await loadTracesAndSource()
    }
}

async function loadFiles() {
    const res = await fetch("/files?run=" + encodeURIComponent(currentRun || ""))
    const files = await res.json()

    const picker = document.getElementById("filePicker")
    picker.innerHTML = ""

    if (files.length === 0) {
        const opt = document.createElement("option")
        opt.value = ""
        opt.textContent = "(no source files)"
        picker.appendChild(opt)
        currentFile = null
        return
    }

    files.forEach(f => {
        const opt = document.createElement("option")
        opt.value = f.path
        opt.textContent = f.label
        picker.appendChild(opt)
    })

    currentFile = files[0].path

    picker.onchange = async () => {
        currentFile = picker.value
        await loadSource()
        buildFnLineMap()
        applyFnLineMarkers()
    }
}

async function loadTracesAndSource() {
    await loadFiles()
    await Promise.all([loadTraces(), loadSource()])
    buildFnLineMap()
    applyFnLineMarkers()
}

// ─────────────────────────────────────────────
// Traces
// ─────────────────────────────────────────────
async function loadTraces() {
    const res = await fetch("/traces?run=" + encodeURIComponent(currentRun || ""))
    const data = await res.json()
    allTraces = data.traces
    applyFilter()
}

function applyFilter() {
    if (activeFilter) {
        filteredTraces = allTraces.filter(t => t.function === activeFilter)
    } else {
        filteredTraces = allTraces
    }
    renderTraceList()
    updatePlaybackStatus()
}

function renderTraceList() {
    const container = document.getElementById("traceListContainer")
    container.innerHTML = ""

    if (filteredTraces.length === 0) {
        container.innerHTML = '<div style="padding:12px;color:#8b949e;font-size:13px;">No traces.</div>'
        return
    }

    filteredTraces.forEach((trace, idx) => {
        const div = document.createElement("div")
        div.className = "trace" + (trace.error ? " error" : "")
        div.id = "trace-" + trace.call_id

        const header = document.createElement("div")
        header.className = "trace-header"

        const left = document.createElement("span")
        left.textContent = trace.function + " | " + trace.duration_s.toFixed(4) + "s"

        const right = document.createElement("span")
        right.textContent = new Date(trace.timestamp_start * 1000).toLocaleTimeString()
        right.style.color = "#8b949e"

        header.appendChild(left)
        header.appendChild(right)

        const details = document.createElement("div")
        details.className = "trace-details"
        details.textContent = JSON.stringify(trace, null, 2)

        header.onclick = () => {
            details.style.display = details.style.display === "block" ? "none" : "block"
        }

        div.appendChild(header)
        div.appendChild(details)
        container.appendChild(div)
    })
}

// ─────────────────────────────────────────────
// Source / code panel
// ─────────────────────────────────────────────
async function loadSource() {
    const panel = document.getElementById("codePanel")

    if (!currentFile) {
        panel.innerHTML = '<div class="empty-msg">No source file selected.</div>'
        return
    }

    const res = await fetch("/source?run=" + encodeURIComponent(currentRun || "") + "&file=" + encodeURIComponent(currentFile))
    if (!res.ok) {
        panel.innerHTML = '<div class="empty-msg">Could not load source.</div>'
        return
    }

    const lines = await res.json()
    panel.innerHTML = ""

    lines.forEach(({ line_no, text }) => {
        const row = document.createElement("div")
        row.className = "code-line"
        row.id = "ln-" + line_no
        row.dataset.lineNo = line_no

        const ln = document.createElement("span")
        ln.className = "ln"
        ln.textContent = line_no

        const code = document.createElement("span")
        code.className = "code"
        code.textContent = text

        row.appendChild(ln)
        row.appendChild(code)
        panel.appendChild(row)
    })
}

function buildFnLineMap() {
    fnLineMap = {}

    allTraces.forEach(t => {
        const name = t.function
        if (!name) return
        const start = t.source_line_start
        const end = t.source_line_end
        if (start == null || end == null) return

        if (!fnLineMap[name]) {
            fnLineMap[name] = {
                decorator_line: start - 1,
                start_line: start,
                end_line: end,
            }
        }
    })
}

function applyFnLineMarkers() {
    // Remove all fn-line classes first
    document.querySelectorAll(".code-line.fn-line").forEach(el => {
        el.classList.remove("fn-line")
        el.onclick = null
    })

    Object.entries(fnLineMap).forEach(([fnName, info]) => {
        const { decorator_line, start_line, end_line } = info

        for (let ln = decorator_line; ln <= end_line; ln++) {
            const row = document.getElementById("ln-" + ln)
            if (!row) continue

            row.classList.add("fn-line")
            row.onclick = () => handleCodeLineClick(fnName, ln)
        }
    })

    // Re-apply selected state if filter is active
    if (activeFilter) {
        highlightFnLines(activeFilter)
    }
}

function handleCodeLineClick(fnName, lineNo) {
    if (activeFilter === fnName) {
        // Toggle off
        activeFilter = null
        clearSelectedLines()
    } else {
        activeFilter = fnName
        clearSelectedLines()
        highlightFnLines(fnName)
    }
    applyFilter()
}

function highlightFnLines(fnName) {
    const info = fnLineMap[fnName]
    if (!info) return

    for (let ln = info.decorator_line; ln <= info.end_line; ln++) {
        const row = document.getElementById("ln-" + ln)
        if (row) row.classList.add("selected")
    }
}

function clearSelectedLines() {
    document.querySelectorAll(".code-line.selected").forEach(el => {
        el.classList.remove("selected")
    })
}

// ─────────────────────────────────────────────
// Playback
// ─────────────────────────────────────────────
function getSpeed() {
    const idx = parseInt(document.getElementById("speedSlider").value)
    return SPEED_VALUES[idx] || 1
}

document.getElementById("speedSlider").addEventListener("input", function() {
    const speed = getSpeed()
    document.getElementById("speedLabel").textContent = speed + "x"
})

function updatePlaybackStatus() {
    const total = allTraces.length
    const step = playStep >= 0 ? playStep + 1 : "—"
    document.getElementById("playbackStatus").textContent =
        "Step " + step + " / " + (total || "—")
}

function showTrace(trace) {
    if (!trace) return

    // Highlight code lines
    document.querySelectorAll(".code-line.line-highlight-active").forEach(el => {
        el.classList.remove("line-highlight-active")
    })

    const start = trace.source_line_start
    const end = trace.source_line_end
    if (start != null && end != null) {
        const decoratorLine = start - 1
        for (let ln = decoratorLine; ln <= end; ln++) {
            const row = document.getElementById("ln-" + ln)
            if (row) {
                row.classList.add("line-highlight-active")
            }
        }
        // Scroll first highlighted line into view
        const first = document.getElementById("ln-" + decoratorLine)
            || document.getElementById("ln-" + start)
        if (first) {
            first.scrollIntoView({ block: "center", behavior: "smooth" })
        }
    }

    // Highlight trace card
    document.querySelectorAll(".trace.playback-active").forEach(el => {
        el.classList.remove("playback-active")
    })

    const card = document.getElementById("trace-" + trace.call_id)
    if (card) {
        card.classList.add("playback-active")
        card.scrollIntoView({ block: "nearest", behavior: "smooth" })
    }

    // Update I/O panel
    updateIOPanel(trace)

    updatePlaybackStatus()
}

function updateIOPanel(trace) {
    const panel = document.getElementById("ioPanel")
    panel.innerHTML = ""

    const inputs = trace.inputs || {}
    const inputsEl = document.createElement("div")
    inputsEl.className = "io-inputs"
    inputsEl.innerHTML =
        '<span class="io-label">inputs:</span> ' +
        escapeHtml(JSON.stringify(inputs))
    panel.appendChild(inputsEl)

    if (trace.error) {
        const errEl = document.createElement("div")
        errEl.className = "io-error"
        errEl.innerHTML =
            '<span class="io-label">error:</span> ' +
            escapeHtml(trace.error.type + ": " + trace.error.message) +
            '<br><span style="opacity:0.7;white-space:pre-wrap">' +
            escapeHtml(trace.error.traceback || "") +
            "</span>"
        panel.appendChild(errEl)
    } else {
        const outEl = document.createElement("div")
        outEl.className = "io-output"
        outEl.innerHTML =
            '<span class="io-label">output:</span> ' +
            escapeHtml(JSON.stringify(trace.output))
        panel.appendChild(outEl)
    }
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
}

function stepTo(idx) {
    if (allTraces.length === 0) return
    playStep = Math.max(0, Math.min(idx, allTraces.length - 1))
    showTrace(allTraces[playStep])
    updatePlaybackStatus()
}

function stepNext() {
    if (playStep < allTraces.length - 1) {
        stepTo(playStep + 1)
    }
}

function stepPrev() {
    if (playStep > 0) {
        stepTo(playStep - 1)
    } else if (playStep < 0) {
        stepTo(0)
    }
}

function togglePlay() {
    if (isPlaying) {
        pausePlay()
    } else {
        startPlay()
    }
}

function startPlay() {
    if (allTraces.length === 0) return

    isPlaying = true
    document.getElementById("btnPlay").textContent = "⏸ Pause"

    // If at end or not started, reset to beginning
    if (playStep < 0 || playStep >= allTraces.length - 1) {
        playStep = -1
    }

    advancePlay()
}

function pausePlay() {
    isPlaying = false
    document.getElementById("btnPlay").textContent = "▶ Play"
    if (playTimer) {
        clearTimeout(playTimer)
        playTimer = null
    }
}

function advancePlay() {
    if (!isPlaying) return

    const nextIdx = playStep + 1
    if (nextIdx >= allTraces.length) {
        pausePlay()
        document.getElementById("btnPlay").textContent = "▶ Play"
        return
    }

    stepTo(nextIdx)

    const delay = BASE_DELAY_MS / getSpeed()
    playTimer = setTimeout(advancePlay, delay)
}

// ─────────────────────────────────────────────
// Boot
// ─────────────────────────────────────────────
init()
</script>

</body>
</html>
"""


def get_run_file(run_id):
    if not run_id:
        return None
    path = RUNS_DIR / f"{run_id}.jsonl"
    # Safety: must resolve inside RUNS_DIR
    try:
        path.resolve().relative_to(RUNS_DIR.resolve())
    except ValueError:
        return None
    return path


def load_traces_from(run_id):
    path = get_run_file(run_id)
    if not path or not path.exists():
        return []

    traces = []
    with path.open(encoding="utf-8") as f:
        for line in f:
            try:
                traces.append(json.loads(line))
            except Exception:
                pass

    traces.sort(key=lambda x: x.get("timestamp_start", 0))
    return traces


@app.route("/")
def index():
    return render_template_string(HTML)


@app.route("/runs")
def runs():
    if not RUNS_DIR.exists():
        return jsonify([])

    files = sorted(RUNS_DIR.glob("*.jsonl"), reverse=True)
    result = []
    for f in files:
        run_id = f.stem
        # Parse timestamp from filename for a nice label
        parts = run_id.split("_")
        if len(parts) >= 2:
            date = parts[0]       # 20250218
            time_part = parts[1]  # 143022
            label = f"{date[:4]}-{date[4:6]}-{date[6:]} {time_part[:2]}:{time_part[2:4]}:{time_part[4:]}"
        else:
            label = run_id
        result.append({"id": run_id, "label": label})

    return jsonify(result)


@app.route("/traces")
def traces():
    run_id = request.args.get("run", "")
    all_traces = load_traces_from(run_id)
    return jsonify({"traces": all_traces})


@app.route("/files")
def files():
    run_id = request.args.get("run", "")
    all_traces = load_traces_from(run_id)

    seen = {}
    for t in all_traces:
        path = t.get("source_file")
        if path and path not in seen:
            seen[path] = {"path": path, "label": Path(path).name}

    return jsonify(list(seen.values()))


@app.route("/source")
def source():
    run_id = request.args.get("run", "")
    requested = request.args.get("file", "")

    # Security whitelist: only serve files referenced in this run's traces
    all_traces = load_traces_from(run_id)
    allowed = {t.get("source_file") for t in all_traces if t.get("source_file")}

    if requested not in allowed:
        return jsonify({"error": "not allowed"}), 403

    path = Path(requested)
    if not path.exists():
        return jsonify({"error": "file not found"}), 404

    lines = []
    with path.open(encoding="utf-8", errors="replace") as f:
        for i, text in enumerate(f, start=1):
            lines.append({"line_no": i, "text": text.rstrip("\n")})

    return jsonify(lines)


if __name__ == "__main__":
    app.run(debug=True)
