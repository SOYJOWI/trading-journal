// ===== TRADING JOURNAL APP =====
// All data stored in localStorage as JSON (images as base64)

const APP_KEY = 'trading-journal-data';

// ===== STATE =====
let state = {
    trades: [],
    currentTab: 'dashboard',
    editingTradeId: null,
    sortColumn: 'date',
    sortAsc: false,
    filterFrom: '',
    filterTo: '',
    activePreset: 'all',
    goals: { pnl: 0, maxLoss: 0, maxTrades: 0, minWinRate: 0 }
};

// ===== INIT =====
document.addEventListener('DOMContentLoaded', () => {
    loadData();
    initDateFilter();
    renderAll();
    setupEventListeners();
    setupPasteHandler();
    loadGoalsUI();
});

// ===== DATA PERSISTENCE =====
function loadData() {
    try {
        const saved = localStorage.getItem(APP_KEY);
        if (saved) {
            const parsed = JSON.parse(saved);
            state.trades = parsed.trades || [];
            state.goals = parsed.goals || { pnl: 0, maxLoss: 0, maxTrades: 0, minWinRate: 0 };
        }
    } catch (e) {
        console.error('Error loading data:', e);
        state.trades = [];
    }
}

function saveData() {
    try {
        localStorage.setItem(APP_KEY, JSON.stringify({ trades: state.trades, goals: state.goals }));
    } catch (e) {
        if (e.name === 'QuotaExceededError') {
            showToast('Storage full! Export your data and consider removing old images.', 'error');
        }
    }
}

// ===== TABS =====
function switchTab(tab) {
    state.currentTab = tab;
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelector(`[data-tab="${tab}"]`).classList.add('active');
    document.querySelectorAll('.tab-content').forEach(c => c.style.display = 'none');
    document.getElementById(`tab-${tab}`).style.display = 'block';
    if (tab === 'dashboard') renderDashboard();
    if (tab === 'gallery') renderGallery();
    if (tab === 'goals') renderGoalsProgress();
}

// ===== EXCEL IMPORT =====
function setupEventListeners() {
    // Upload zone
    const uploadZone = document.getElementById('upload-zone');
    const fileInput = document.getElementById('excel-file-input');

    if (uploadZone) {
        uploadZone.addEventListener('click', () => fileInput.click());
        uploadZone.addEventListener('dragover', (e) => { e.preventDefault(); uploadZone.classList.add('dragover'); });
        uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('dragover'));
        uploadZone.addEventListener('drop', (e) => {
            e.preventDefault();
            uploadZone.classList.remove('dragover');
            handleExcelFiles(e.dataTransfer.files);
        });
    }

    if (fileInput) {
        fileInput.addEventListener('change', (e) => handleExcelFiles(e.target.files));
    }

    // Modal close
    document.querySelectorAll('.modal-overlay').forEach(m => {
        m.addEventListener('click', (e) => {
            if (e.target === m) closeModal(m.id);
        });
    });

    // Lightbox close
    const lightbox = document.getElementById('lightbox');
    if (lightbox) {
        lightbox.addEventListener('click', () => lightbox.classList.remove('active'));
    }

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            document.querySelectorAll('.modal-overlay.active').forEach(m => m.classList.remove('active'));
            document.getElementById('lightbox')?.classList.remove('active');
            document.getElementById('confirm-dialog')?.classList.remove('active');
        }
    });
}

async function handleExcelFiles(files) {
    if (!files || files.length === 0) return;

    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if (!file.name.match(/\.(xls|xlsx)$/i)) {
            showToast(`${file.name} is not an Excel file`, 'error');
            continue;
        }

        try {
            const data = await readExcelFile(file);
            const trades = parsePropreReports(data, file.name);
            if (trades.length > 0) {
                // Merge trades — avoid duplicates based on symbol+date+net
                let added = 0;
                trades.forEach(t => {
                    const exists = state.trades.some(existing =>
                        existing.symbol === t.symbol &&
                        existing.date === t.date &&
                        existing.net === t.net
                    );
                    if (!exists) {
                        state.trades.push(t);
                        added++;
                    }
                });
                saveData();
                renderAll();
                showToast(`Imported ${added} new trades from ${file.name} (${trades.length - added} duplicates skipped)`, 'success');
            } else {
                showToast(`No trades found in ${file.name}`, 'error');
            }
        } catch (err) {
            console.error(err);
            showToast(`Error reading ${file.name}: ${err.message}`, 'error');
        }
    }
}

function readExcelFile(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const data = new Uint8Array(e.target.result);
                const workbook = XLSX.read(data, { type: 'array' });
                const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
                const jsonData = XLSX.utils.sheet_to_json(firstSheet, { header: 1 });
                resolve(jsonData);
            } catch (err) { reject(err); }
        };
        reader.onerror = reject;
        reader.readAsArrayBuffer(file);
    });
}

function parsePropreReports(rawData, filename) {
    // Find header row
    let headerIdx = -1;
    let headers = [];
    for (let i = 0; i < Math.min(20, rawData.length); i++) {
        const row = rawData[i];
        if (row && row.some(cell => cell && cell.toString().toLowerCase().includes('symbol'))) {
            headerIdx = i;
            headers = row.map(h => h ? h.toString().toLowerCase().trim() : '');
            break;
        }
    }

    if (headerIdx === -1) throw new Error('Could not find header row with "Symbol" column');

    // Map columns
    const col = {
        symbol: headers.indexOf('symbol'),
        side: headers.findIndex(h => h.includes('type') || h.includes('side') || h.includes('b/s')),
        date: headers.findIndex(h => h.includes('date') || h.includes('time') || h.includes('open')),
        gross: headers.findIndex(h => h === 'gross' || h.includes('gross p')),
        comm: headers.findIndex(h => h.includes('comm')),
        ecn: headers.findIndex(h => h.includes('ecn') || h.includes('fee')),
        qty: headers.findIndex(h => h.includes('qty') || h.includes('shares') || h.includes('quantity')),
        net: headers.findIndex(h => h === 'net' || h.includes('net p')),
        held: headers.findIndex(h => h.includes('held') || h.includes('duration'))
    };

    const trades = [];
    for (let i = headerIdx + 1; i < rawData.length; i++) {
        const row = rawData[i];
        if (!row || row.length === 0 || !row[col.symbol]) continue;

        const parseNum = (val) => {
            if (typeof val === 'number') return val;
            if (typeof val === 'string') return parseFloat(val.replace(/[^0-9.\-]/g, '')) || 0;
            return 0;
        };

        const parseDate = (val) => {
            if (!val) return new Date().toISOString().split('T')[0];
            if (typeof val === 'number') {
                return new Date(Math.round((val - 25569) * 86400 * 1000)).toISOString().split('T')[0];
            }
            const d = new Date(val);
            return isNaN(d) ? new Date().toISOString().split('T')[0] : d.toISOString().split('T')[0];
        };

        const parseDuration = (val) => {
            if (!val) return '';
            if (typeof val === 'string') return val;
            if (typeof val === 'number') {
                const totalSec = Math.round(val * 86400);
                const h = Math.floor(totalSec / 3600);
                const m = Math.floor((totalSec % 3600) / 60);
                const s = totalSec % 60;
                return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
            }
            return String(val);
        };

        const net = col.net !== -1 ? parseNum(row[col.net]) : 0;
        const gross = col.gross !== -1 ? parseNum(row[col.gross]) : net;

        trades.push({
            id: generateId(),
            symbol: String(row[col.symbol]).toUpperCase().trim(),
            side: col.side !== -1 ? String(row[col.side] || 'Long').trim() : 'Long',
            date: col.date !== -1 ? parseDate(row[col.date]) : new Date().toISOString().split('T')[0],
            gross: gross,
            comm: col.comm !== -1 ? parseNum(row[col.comm]) : 0,
            ecnFee: col.ecn !== -1 ? parseNum(row[col.ecn]) : 0,
            qty: col.qty !== -1 ? parseNum(row[col.qty]) : 0,
            net: net,
            duration: col.held !== -1 ? parseDuration(row[col.held]) : '',
            notes: '',
            images: [],
            source: filename
        });
    }

    return trades;
}

// ===== MANUAL TRADE ENTRY =====
function openAddTradeModal() {
    state.editingTradeId = null;
    document.getElementById('modal-title').textContent = 'Add Trade';
    document.getElementById('trade-form').reset();
    document.getElementById('trade-date').value = new Date().toISOString().split('T')[0];
    clearPasteZone();
    openModal('trade-modal');
}

function openEditTradeModal(id) {
    const trade = state.trades.find(t => t.id === id);
    if (!trade) return;

    state.editingTradeId = id;
    document.getElementById('modal-title').textContent = 'Edit Trade';
    document.getElementById('trade-symbol').value = trade.symbol;
    document.getElementById('trade-side').value = trade.side;
    document.getElementById('trade-date').value = trade.date;
    document.getElementById('trade-gross').value = trade.gross || '';
    document.getElementById('trade-comm').value = trade.comm || '';
    document.getElementById('trade-ecn').value = trade.ecnFee || '';
    document.getElementById('trade-qty').value = trade.qty || '';
    document.getElementById('trade-net').value = trade.net || '';
    document.getElementById('trade-duration').value = trade.duration || '';
    document.getElementById('trade-notes').value = trade.notes || '';

    // Show existing images
    const pasteZone = document.getElementById('paste-zone');
    if (trade.images && trade.images.length > 0) {
        pasteZone.innerHTML = trade.images.map((img, i) =>
            `<img src="${img}" alt="Trade screenshot ${i + 1}" style="margin: 4px;" />`
        ).join('');
        pasteZone.classList.add('has-image');
        pasteZone.dataset.images = JSON.stringify(trade.images);
    } else {
        clearPasteZone();
    }

    openModal('trade-modal');
}

function saveTrade() {
    const symbol = document.getElementById('trade-symbol').value.trim().toUpperCase();
    if (!symbol) { showToast('Symbol is required', 'error'); return; }

    const pasteZone = document.getElementById('paste-zone');
    let images = [];
    try { images = JSON.parse(pasteZone.dataset.images || '[]'); } catch (e) { images = []; }

    const tradeData = {
        symbol: symbol,
        side: document.getElementById('trade-side').value,
        date: document.getElementById('trade-date').value || new Date().toISOString().split('T')[0],
        gross: parseFloat(document.getElementById('trade-gross').value) || 0,
        comm: parseFloat(document.getElementById('trade-comm').value) || 0,
        ecnFee: parseFloat(document.getElementById('trade-ecn').value) || 0,
        qty: parseInt(document.getElementById('trade-qty').value) || 0,
        net: parseFloat(document.getElementById('trade-net').value) || 0,
        duration: document.getElementById('trade-duration').value || '',
        notes: document.getElementById('trade-notes').value || '',
        images: images,
        source: 'manual'
    };

    // Auto-calc net if not provided but gross/comm/ecn are
    if (!tradeData.net && tradeData.gross) {
        tradeData.net = tradeData.gross + tradeData.comm + tradeData.ecnFee;
    }

    if (state.editingTradeId) {
        const idx = state.trades.findIndex(t => t.id === state.editingTradeId);
        if (idx !== -1) {
            state.trades[idx] = { ...state.trades[idx], ...tradeData };
        }
        showToast('Trade updated', 'success');
    } else {
        tradeData.id = generateId();
        state.trades.push(tradeData);
        showToast('Trade added', 'success');
    }

    saveData();
    closeModal('trade-modal');
    renderAll();
}

function deleteTrade(id) {
    showConfirm('Delete Trade', 'Are you sure you want to delete this trade?', () => {
        state.trades = state.trades.filter(t => t.id !== id);
        saveData();
        renderAll();
        showToast('Trade deleted', 'info');
    });
}

// ===== IMAGE HANDLING =====
function setupPasteHandler() {
    document.addEventListener('paste', (e) => {
        // Only handle paste if modal is open
        const modal = document.getElementById('trade-modal');
        if (!modal || !modal.classList.contains('active')) return;

        const items = e.clipboardData?.items;
        if (!items) return;

        for (let i = 0; i < items.length; i++) {
            if (items[i].type.startsWith('image/')) {
                e.preventDefault();
                const blob = items[i].getAsFile();
                processImage(blob);
                break;
            }
        }
    });
}

function processImage(blob) {
    const reader = new FileReader();
    reader.onload = (e) => {
        // Compress image to reduce storage
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            const maxW = 1200;
            const maxH = 900;
            let w = img.width, h = img.height;
            if (w > maxW) { h = h * (maxW / w); w = maxW; }
            if (h > maxH) { w = w * (maxH / h); h = maxH; }
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, w, h);
            const compressed = canvas.toDataURL('image/webp', 0.8);
            addImageToPasteZone(compressed);
        };
        img.src = e.target.result;
    };
    reader.readAsDataURL(blob);
}

function addImageToPasteZone(base64) {
    const pasteZone = document.getElementById('paste-zone');
    let images = [];
    try { images = JSON.parse(pasteZone.dataset.images || '[]'); } catch (e) { images = []; }
    images.push(base64);
    pasteZone.dataset.images = JSON.stringify(images);
    pasteZone.classList.add('has-image');

    // Show images
    pasteZone.innerHTML = images.map((img, i) =>
        `<img src="${img}" alt="Screenshot ${i + 1}" style="margin: 4px;" />`
    ).join('') + '<p class="placeholder" style="font-size:11px; margin-top:8px;">Paste another image or click to add more</p>';
}

function clearPasteZone() {
    const pasteZone = document.getElementById('paste-zone');
    pasteZone.classList.remove('has-image');
    pasteZone.dataset.images = '[]';
    pasteZone.innerHTML = `
        <div class="placeholder">
            <div style="font-size: 28px; margin-bottom: 8px;">📋</div>
            <div>Paste image (Ctrl+V) or drag & drop</div>
            <div style="font-size: 11px; margin-top: 4px; color: var(--text-muted);">Supports PNG, JPG, WebP</div>
        </div>
    `;
}

function handlePasteZoneDrop(e) {
    e.preventDefault();
    const files = e.dataTransfer.files;
    for (let i = 0; i < files.length; i++) {
        if (files[i].type.startsWith('image/')) {
            processImage(files[i]);
        }
    }
}

function handlePasteZoneClick() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = true;
    input.onchange = (e) => {
        for (let i = 0; i < e.target.files.length; i++) {
            processImage(e.target.files[i]);
        }
    };
    input.click();
}

// ===== ADD IMAGE TO EXISTING TRADE =====
function addImageToTrade(tradeId) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = true;
    input.onchange = (e) => {
        const trade = state.trades.find(t => t.id === tradeId);
        if (!trade) return;
        if (!trade.images) trade.images = [];

        for (let i = 0; i < e.target.files.length; i++) {
            const reader = new FileReader();
            reader.onload = (ev) => {
                const img = new Image();
                img.onload = () => {
                    const canvas = document.createElement('canvas');
                    const maxW = 1200, maxH = 900;
                    let w = img.width, h = img.height;
                    if (w > maxW) { h = h * (maxW / w); w = maxW; }
                    if (h > maxH) { w = w * (maxH / h); h = maxH; }
                    canvas.width = w; canvas.height = h;
                    canvas.getContext('2d').drawImage(img, 0, 0, w, h);
                    trade.images.push(canvas.toDataURL('image/webp', 0.8));
                    saveData();
                    renderAll();
                    showToast('Image added to ' + trade.symbol, 'success');
                };
                img.src = ev.target.result;
            };
            reader.readAsDataURL(e.target.files[i]);
        }
    };
    input.click();
}

// ===== RENDER ALL =====
function renderAll() {
    renderTradeLog();
    renderDashboard();
    renderGallery();
}

// ===== TRADE LOG TABLE =====
function renderTradeLog() {
    const tbody = document.getElementById('trade-tbody');
    if (!tbody) return;

    const filtered = getFilteredTrades();
    const sorted = [...filtered].sort((a, b) => {
        let va = a[state.sortColumn], vb = b[state.sortColumn];
        if (state.sortColumn === 'date') { va = new Date(va); vb = new Date(vb); }
        if (typeof va === 'string') va = va.toLowerCase();
        if (typeof vb === 'string') vb = vb.toLowerCase();
        if (va < vb) return state.sortAsc ? -1 : 1;
        if (va > vb) return state.sortAsc ? 1 : -1;
        return 0;
    });

    if (sorted.length === 0) {
        tbody.innerHTML = `<tr><td colspan="10" class="no-data-text">No trades match the current filter.</td></tr>`;
        return;
    }

    tbody.innerHTML = sorted.map(t => {
        const netClass = t.net >= 0 ? 'text-green' : 'text-red';
        const sideClass = (t.side || '').toLowerCase().includes('short') ? 'badge-short' : 'badge-long';
        const sideLabel = (t.side || '').toLowerCase().includes('short') ? 'SHORT' : 'LONG';
        const thumb = t.images && t.images.length > 0
            ? `<img src="${t.images[0]}" class="trade-thumb" onclick="openLightbox('${t.id}', 0)" />`
            : `<span style="color: var(--text-muted); font-size: 11px; cursor: pointer;" onclick="addImageToTrade('${t.id}')">+ img</span>`;

        return `<tr>
            <td>${thumb}</td>
            <td><strong>${t.symbol}</strong></td>
            <td><span class="badge ${sideClass}">${sideLabel}</span></td>
            <td>${t.date}</td>
            <td>${t.qty || '-'}</td>
            <td class="${netClass}"><strong>$${t.net.toFixed(2)}</strong></td>
            <td>$${(t.gross || 0).toFixed(2)}</td>
            <td>$${(t.comm || 0).toFixed(2)}</td>
            <td>${t.duration || '-'}</td>
            <td>
                <button class="btn btn-sm" onclick="openEditTradeModal('${t.id}')" title="Edit">✏️</button>
                <button class="btn btn-sm btn-danger" onclick="deleteTrade('${t.id}')" title="Delete">🗑️</button>
            </td>
        </tr>`;
    }).join('');
}

function sortTable(column) {
    if (state.sortColumn === column) {
        state.sortAsc = !state.sortAsc;
    } else {
        state.sortColumn = column;
        state.sortAsc = column === 'symbol';
    }
    renderTradeLog();
}

// ===== DASHBOARD / STATISTICS =====
function renderDashboard() {
    const trades = getFilteredTrades();
    if (trades.length === 0) {
        setStatValues({});
        renderEmptyCharts();
        return;
    }

    // Sort trades by date
    const sorted = [...trades].sort((a, b) => new Date(a.date) - new Date(b.date));

    // Core stats
    const wins = sorted.filter(t => t.net > 0);
    const losses = sorted.filter(t => t.net <= 0);
    const totalTrades = sorted.length;
    const grossProfit = wins.reduce((s, t) => s + t.net, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.net, 0));
    const totalNet = sorted.reduce((s, t) => s + t.net, 0);

    const winRate = totalTrades > 0 ? ((wins.length / totalTrades) * 100) : 0;
    const avgWin = wins.length > 0 ? grossProfit / wins.length : 0;
    const avgLoss = losses.length > 0 ? grossLoss / losses.length : 0;
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
    const expectancy = totalTrades > 0 ? (winRate / 100 * avgWin) - ((1 - winRate / 100) * avgLoss) : 0;
    const bestTrade = Math.max(...sorted.map(t => t.net));
    const worstTrade = Math.min(...sorted.map(t => t.net));
    const avgRR = avgLoss > 0 ? avgWin / avgLoss : 0;

    // Average duration
    let avgDuration = '-';
    const durationsInSec = sorted.filter(t => t.duration).map(t => parseDurationToSeconds(t.duration)).filter(d => d > 0);
    if (durationsInSec.length > 0) {
        const avgSec = durationsInSec.reduce((a, b) => a + b, 0) / durationsInSec.length;
        avgDuration = formatSecondsToHMS(avgSec);
    }

    // Max Drawdown
    let peak = 0, maxDD = 0, runningPnL = 0;
    const equityData = [];
    const drawdownData = [];
    sorted.forEach(t => {
        runningPnL += t.net;
        equityData.push(runningPnL);
        if (runningPnL > peak) peak = runningPnL;
        const dd = peak - runningPnL;
        if (dd > maxDD) maxDD = dd;
        drawdownData.push(-dd);
    });

    // Total commissions
    const totalComm = sorted.reduce((s, t) => s + Math.abs(t.comm || 0) + Math.abs(t.ecnFee || 0), 0);

    // Set stat values
    setStatValues({
        totalNet, winRate, avgWin, avgLoss, profitFactor, expectancy,
        maxDD, bestTrade, worstTrade, avgRR, avgDuration, totalTrades,
        wins: wins.length, losses: losses.length, totalComm
    });

    // Render charts
    renderEquityChart(sorted, equityData);
    renderDrawdownChart(sorted, drawdownData);
    renderDistributionChart(wins.length, losses.length);
    renderDailyPnLChart(sorted);
}

function setStatValues(s) {
    const el = (id) => document.getElementById(id);
    const fmt = (v) => v !== undefined ? '$' + v.toFixed(2) : '-';
    const pct = (v) => v !== undefined ? v.toFixed(1) + '%' : '-';

    el('stat-net-pnl').textContent = s.totalNet !== undefined ? fmt(s.totalNet) : '-';
    el('stat-net-pnl').className = 'stat-value ' + (s.totalNet >= 0 ? 'text-green' : 'text-red');

    el('stat-win-rate').textContent = s.winRate !== undefined ? pct(s.winRate) : '-';
    el('stat-win-rate').className = 'stat-value ' + (s.winRate >= 50 ? 'text-green' : 'text-red');

    el('stat-avg-win').textContent = s.avgWin !== undefined ? fmt(s.avgWin) : '-';
    el('stat-avg-loss').textContent = s.avgLoss !== undefined ? '-' + fmt(s.avgLoss) : '-';
    el('stat-profit-factor').textContent = s.profitFactor !== undefined ?
        (s.profitFactor === Infinity ? '∞' : s.profitFactor.toFixed(2)) : '-';
    el('stat-expectancy').textContent = s.expectancy !== undefined ? fmt(s.expectancy) : '-';
    el('stat-expectancy').className = 'stat-value ' + (s.expectancy >= 0 ? 'text-green' : 'text-red');

    el('stat-max-dd').textContent = s.maxDD !== undefined ? '-' + fmt(s.maxDD) : '-';
    el('stat-best-trade').textContent = s.bestTrade !== undefined ? fmt(s.bestTrade) : '-';
    el('stat-worst-trade').textContent = s.worstTrade !== undefined ? fmt(s.worstTrade) : '-';
    el('stat-avg-rr').textContent = s.avgRR !== undefined ? s.avgRR.toFixed(2) + ':1' : '-';
    el('stat-avg-duration').textContent = s.avgDuration || '-';
    el('stat-total-trades').textContent = s.totalTrades !== undefined ? s.totalTrades : '-';
    el('stat-total-comm').textContent = s.totalComm !== undefined ? '-' + fmt(s.totalComm) : '-';
}

// ===== CHARTS =====
let charts = {};

function destroyChart(name) {
    if (charts[name]) { charts[name].destroy(); charts[name] = null; }
}

const chartColors = {
    gridColor: '#1e2535',
    tickColor: '#5a6478',
    green: '#00d4aa',
    red: '#ff4757',
    blue: '#4f8cff',
    greenBg: 'rgba(0, 212, 170, 0.1)',
    redBg: 'rgba(255, 71, 87, 0.1)',
    blueBg: 'rgba(79, 140, 255, 0.1)'
};

const baseChartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
        legend: { display: false },
        tooltip: {
            backgroundColor: '#1a1f2e',
            borderColor: '#2a3142',
            borderWidth: 1,
            titleColor: '#f0f2f5',
            bodyColor: '#8b95a8',
            padding: 12,
            cornerRadius: 8
        }
    },
    scales: {
        x: {
            grid: { color: chartColors.gridColor },
            ticks: { color: chartColors.tickColor, font: { size: 11 } }
        },
        y: {
            grid: { color: chartColors.gridColor },
            ticks: {
                color: chartColors.tickColor, font: { size: 11 },
                callback: (v) => '$' + v.toFixed(0)
            }
        }
    }
};

function renderEquityChart(trades, equityData) {
    destroyChart('equity');
    const ctx = document.getElementById('equity-chart');
    if (!ctx) return;

    // Determine gradient
    const gradient = ctx.getContext('2d').createLinearGradient(0, 0, 0, 280);
    const lastVal = equityData[equityData.length - 1] || 0;
    if (lastVal >= 0) {
        gradient.addColorStop(0, 'rgba(0, 212, 170, 0.3)');
        gradient.addColorStop(1, 'rgba(0, 212, 170, 0)');
    } else {
        gradient.addColorStop(0, 'rgba(255, 71, 87, 0.3)');
        gradient.addColorStop(1, 'rgba(255, 71, 87, 0)');
    }

    charts.equity = new Chart(ctx, {
        type: 'line',
        data: {
            labels: trades.map((t, i) => t.date + ' #' + (i + 1)),
            datasets: [{
                label: 'Equity',
                data: equityData,
                borderColor: lastVal >= 0 ? chartColors.green : chartColors.red,
                backgroundColor: gradient,
                fill: true,
                tension: 0.3,
                pointRadius: equityData.length > 50 ? 0 : 3,
                pointHoverRadius: 5,
                borderWidth: 2
            }]
        },
        options: {
            ...baseChartOptions,
            scales: {
                ...baseChartOptions.scales,
                x: { ...baseChartOptions.scales.x, display: false }
            }
        }
    });
}

function renderDrawdownChart(trades, drawdownData) {
    destroyChart('drawdown');
    const ctx = document.getElementById('drawdown-chart');
    if (!ctx) return;

    const gradient = ctx.getContext('2d').createLinearGradient(0, 0, 0, 280);
    gradient.addColorStop(0, 'rgba(255, 71, 87, 0)');
    gradient.addColorStop(1, 'rgba(255, 71, 87, 0.3)');

    charts.drawdown = new Chart(ctx, {
        type: 'line',
        data: {
            labels: trades.map((t, i) => t.date + ' #' + (i + 1)),
            datasets: [{
                label: 'Drawdown',
                data: drawdownData,
                borderColor: chartColors.red,
                backgroundColor: gradient,
                fill: true,
                tension: 0.3,
                pointRadius: 0,
                borderWidth: 2
            }]
        },
        options: {
            ...baseChartOptions,
            scales: {
                ...baseChartOptions.scales,
                x: { ...baseChartOptions.scales.x, display: false }
            }
        }
    });
}

function renderDistributionChart(wins, losses) {
    destroyChart('distribution');
    const ctx = document.getElementById('distribution-chart');
    if (!ctx) return;

    charts.distribution = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: ['Wins', 'Losses'],
            datasets: [{
                data: [wins, losses],
                backgroundColor: [chartColors.green, chartColors.red],
                borderWidth: 0,
                spacing: 4,
                borderRadius: 4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: '72%',
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: { color: chartColors.tickColor, padding: 16, font: { size: 12 } }
                },
                tooltip: baseChartOptions.plugins.tooltip
            }
        }
    });
}

function renderDailyPnLChart(trades) {
    destroyChart('dailypnl');
    const ctx = document.getElementById('daily-pnl-chart');
    if (!ctx) return;

    // Group by date
    const dailyMap = {};
    trades.forEach(t => {
        dailyMap[t.date] = (dailyMap[t.date] || 0) + t.net;
    });
    const dates = Object.keys(dailyMap).sort();
    const values = dates.map(d => dailyMap[d]);

    charts.dailypnl = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: dates,
            datasets: [{
                label: 'Daily P&L',
                data: values,
                backgroundColor: values.map(v => v >= 0 ? chartColors.green : chartColors.red),
                borderRadius: 4,
                maxBarThickness: 40
            }]
        },
        options: baseChartOptions
    });
}

function renderEmptyCharts() {
    ['equity', 'drawdown', 'distribution', 'dailypnl'].forEach(c => destroyChart(c));
}

// ===== GALLERY =====
function renderGallery() {
    const container = document.getElementById('gallery-grid');
    if (!container) return;

    const tradesWithImages = getFilteredTrades().filter(t => t.images && t.images.length > 0);

    if (tradesWithImages.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="icon">🖼️</div>
                <h3>No Images Yet</h3>
                <p>Add screenshots to your trades by editing them or pasting images when adding new trades.</p>
            </div>
        `;
        return;
    }

    // Group by date, then by trade
    const dateGroups = {};
    tradesWithImages.forEach(t => {
        const date = t.date;
        if (!dateGroups[date]) dateGroups[date] = {};
        if (!dateGroups[date][t.id]) dateGroups[date][t.id] = t;
    });

    // Sort dates descending
    const sortedDates = Object.keys(dateGroups).sort((a, b) => new Date(b) - new Date(a));

    let html = '';
    sortedDates.forEach(date => {
        const trades = Object.values(dateGroups[date]);
        const dayNet = trades.reduce((s, t) => s + t.net, 0);
        const dayNetClass = dayNet >= 0 ? 'text-green' : 'text-red';
        const dayLabel = formatDateLabel(date);

        html += `<div class="gallery-date-group">`;
        html += `<div class="gallery-date-header">
            <div class="gallery-date-title">
                <span class="gallery-date-icon">📅</span>
                <span class="gallery-date-text">${dayLabel}</span>
                <span class="gallery-date-count">${trades.length} trade${trades.length > 1 ? 's' : ''} · ${trades.reduce((s, t) => s + t.images.length, 0)} screenshots</span>
            </div>
            <span class="gallery-date-pnl ${dayNetClass}">$${dayNet.toFixed(2)}</span>
        </div>`;

        trades.forEach(trade => {
            const netClass = trade.net >= 0 ? 'text-green' : 'text-red';
            const sideClass = (trade.side || '').toLowerCase().includes('short') ? 'badge-short' : 'badge-long';
            const sideLabel = (trade.side || '').toLowerCase().includes('short') ? 'SHORT' : 'LONG';
            const escapedNotes = (trade.notes || '').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

            html += `<div class="gallery-trade-card">
                <div class="gallery-trade-header">
                    <div class="gallery-trade-info">
                        <span class="gallery-trade-symbol">${trade.symbol}</span>
                        <span class="badge ${sideClass}">${sideLabel}</span>
                        <span class="gallery-trade-qty">${trade.qty ? trade.qty + ' shares' : ''}</span>
                    </div>
                    <div class="gallery-trade-stats">
                        <span class="${netClass}" style="font-weight: 700; font-size: 16px;">$${trade.net.toFixed(2)}</span>
                        ${trade.duration ? `<span class="gallery-trade-duration">⏱ ${trade.duration}</span>` : ''}
                    </div>
                </div>
                <div class="gallery-images-scroll">
                    ${trade.images.map((img, i) =>
                `<div class="gallery-image-wrapper" onclick="openLightbox('${trade.id}', ${i})">
                            <img src="${img}" alt="${trade.symbol} #${i + 1}" loading="lazy" />
                            <div class="gallery-image-label">${i + 1} / ${trade.images.length}</div>
                        </div>`
            ).join('')}
                </div>
                <div class="gallery-notes-section">
                    <div class="gallery-notes-header">
                        <span>📝 Notes</span>
                        <span class="gallery-notes-saved" id="notes-saved-${trade.id}" style="display:none;">✓ Saved</span>
                    </div>
                    <textarea
                        class="gallery-notes-input"
                        id="gallery-notes-${trade.id}"
                        placeholder="Click to add notes about this trade..."
                        onblur="saveGalleryNote('${trade.id}')"
                        oninput="autoResizeTextarea(this)"
                    >${trade.notes || ''}</textarea>
                </div>
            </div>`;
        });

        html += `</div>`;
    });

    container.innerHTML = html;

    // Auto-resize all textareas
    container.querySelectorAll('.gallery-notes-input').forEach(ta => autoResizeTextarea(ta));
}

function saveGalleryNote(tradeId) {
    const textarea = document.getElementById('gallery-notes-' + tradeId);
    if (!textarea) return;

    const trade = state.trades.find(t => t.id === tradeId);
    if (!trade) return;

    const newNotes = textarea.value.trim();
    if (trade.notes === newNotes) return; // No change

    trade.notes = newNotes;
    saveData();

    // Show saved indicator
    const savedEl = document.getElementById('notes-saved-' + tradeId);
    if (savedEl) {
        savedEl.style.display = 'inline';
        setTimeout(() => { savedEl.style.display = 'none'; }, 2000);
    }
}

function autoResizeTextarea(el) {
    el.style.height = 'auto';
    el.style.height = Math.max(40, el.scrollHeight) + 'px';
}

function formatDateLabel(dateStr) {
    const date = new Date(dateStr + 'T12:00:00');
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    const dateOnly = (d) => d.toISOString().split('T')[0];

    if (dateOnly(date) === dateOnly(today)) return 'Today · ' + dateStr;
    if (dateOnly(date) === dateOnly(yesterday)) return 'Yesterday · ' + dateStr;

    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    return days[date.getDay()] + ' · ' + dateStr;
}

// ===== LIGHTBOX =====
function openLightbox(tradeId, imgIndex) {
    const trade = state.trades.find(t => t.id === tradeId);
    if (!trade || !trade.images || !trade.images[imgIndex]) return;

    const lightbox = document.getElementById('lightbox');
    lightbox.querySelector('img').src = trade.images[imgIndex];
    lightbox.classList.add('active');
}

// ===== EXPORT / IMPORT =====
function exportData() {
    const dataStr = JSON.stringify({ trades: state.trades, exportDate: new Date().toISOString() }, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `trading-journal-backup-${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Data exported successfully', 'success');
}

function importData() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
            try {
                const data = JSON.parse(ev.target.result);
                if (data.trades && Array.isArray(data.trades)) {
                    showConfirm('Import Data',
                        `This will add ${data.trades.length} trades. Existing trades won't be deleted. Continue?`,
                        () => {
                            let added = 0;
                            data.trades.forEach(t => {
                                const exists = state.trades.some(existing =>
                                    existing.symbol === t.symbol &&
                                    existing.date === t.date &&
                                    existing.net === t.net
                                );
                                if (!exists) {
                                    if (!t.id) t.id = generateId();
                                    state.trades.push(t);
                                    added++;
                                }
                            });
                            saveData();
                            renderAll();
                            showToast(`Imported ${added} new trades (${data.trades.length - added} duplicates skipped)`, 'success');
                        }
                    );
                } else {
                    showToast('Invalid backup file format', 'error');
                }
            } catch (err) {
                showToast('Error reading file: ' + err.message, 'error');
            }
        };
        reader.readAsText(file);
    };
    input.click();
}

function clearAllData() {
    showConfirm('Clear All Data', 'This will permanently delete ALL trades and images. This cannot be undone!', () => {
        state.trades = [];
        saveData();
        renderAll();
        showToast('All data cleared', 'info');
    });
}

// ===== UTILITIES =====
function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

function parseDurationToSeconds(dur) {
    if (!dur) return 0;
    const str = String(dur);
    const parts = str.split(':').map(Number);
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return 0;
}

function formatSecondsToHMS(sec) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m ${s}s`;
}

// ===== MODALS =====
function openModal(id) {
    document.getElementById(id).classList.add('active');
}

function closeModal(id) {
    document.getElementById(id).classList.remove('active');
}

// ===== CONFIRM DIALOG =====
let confirmCallback = null;

function showConfirm(title, message, onConfirm) {
    const dialog = document.getElementById('confirm-dialog');
    dialog.querySelector('h4').textContent = title;
    dialog.querySelector('p').textContent = message;
    confirmCallback = onConfirm;
    dialog.classList.add('active');
}

function confirmYes() {
    document.getElementById('confirm-dialog').classList.remove('active');
    if (confirmCallback) confirmCallback();
    confirmCallback = null;
}

function confirmNo() {
    document.getElementById('confirm-dialog').classList.remove('active');
    confirmCallback = null;
}

// ===== TOAST NOTIFICATIONS =====
function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    const icons = { success: '✅', error: '❌', info: 'ℹ️' };
    toast.innerHTML = `<span>${icons[type] || ''}</span> ${message}`;
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(100px)';
        setTimeout(() => toast.remove(), 300);
    }, 3500);
}

// ===== DATE FILTER =====
function getFilteredTrades() {
    let trades = state.trades;
    if (state.filterFrom) {
        trades = trades.filter(t => t.date >= state.filterFrom);
    }
    if (state.filterTo) {
        trades = trades.filter(t => t.date <= state.filterTo);
    }
    updateFilterCount(trades.length, state.trades.length);
    return trades;
}

function updateFilterCount(filtered, total) {
    const el = document.getElementById('filter-count');
    if (!el) return;
    if (state.activePreset === 'all' && !state.filterFrom && !state.filterTo) {
        el.textContent = `${total} trades`;
    } else {
        el.textContent = `${filtered} of ${total} trades`;
    }
}

function initDateFilter() {
    // Set default to "All Time"
    setFilterPreset('all');
}

function setFilterPreset(preset) {
    state.activePreset = preset;
    const today = new Date();
    const toISO = (d) => d.toISOString().split('T')[0];

    switch (preset) {
        case 'today':
            state.filterFrom = toISO(today);
            state.filterTo = toISO(today);
            break;
        case 'week': {
            const day = today.getDay();
            const monday = new Date(today);
            monday.setDate(today.getDate() - ((day + 6) % 7));
            state.filterFrom = toISO(monday);
            state.filterTo = toISO(today);
            break;
        }
        case 'month':
            state.filterFrom = toISO(new Date(today.getFullYear(), today.getMonth(), 1));
            state.filterTo = toISO(today);
            break;
        case 'all':
        default:
            state.filterFrom = '';
            state.filterTo = '';
            break;
    }

    // Update UI
    document.getElementById('filter-from').value = state.filterFrom;
    document.getElementById('filter-to').value = state.filterTo;

    // Update active preset button
    document.querySelectorAll('.filter-preset').forEach(b => b.classList.remove('active-preset'));
    document.querySelector(`.filter-preset[onclick*="${preset}"]`)?.classList.add('active-preset');

    renderAll();
}

function applyDateFilter() {
    state.filterFrom = document.getElementById('filter-from').value;
    state.filterTo = document.getElementById('filter-to').value;

    // Clear active preset since custom dates
    state.activePreset = 'custom';
    document.querySelectorAll('.filter-preset').forEach(b => b.classList.remove('active-preset'));

    renderAll();
}

// ===== GOALS =====
function saveGoals() {
    state.goals = {
        pnl: parseFloat(document.getElementById('goal-pnl').value) || 0,
        maxLoss: parseFloat(document.getElementById('goal-max-loss').value) || 0,
        maxTrades: parseInt(document.getElementById('goal-max-trades').value) || 0,
        minWinRate: parseFloat(document.getElementById('goal-min-winrate').value) || 0
    };
    saveData();
    renderGoalsProgress();
    showToast('Goals saved!', 'success');
}

function loadGoalsUI() {
    const g = state.goals;
    if (g.pnl) document.getElementById('goal-pnl').value = g.pnl;
    if (g.maxLoss) document.getElementById('goal-max-loss').value = g.maxLoss;
    if (g.maxTrades) document.getElementById('goal-max-trades').value = g.maxTrades;
    if (g.minWinRate) document.getElementById('goal-min-winrate').value = g.minWinRate;
}

function renderGoalsProgress() {
    const container = document.getElementById('goals-progress');
    if (!container) return;

    const g = state.goals;
    const hasGoals = g.pnl || g.maxLoss || g.maxTrades || g.minWinRate;

    if (!hasGoals) {
        container.innerHTML = '<div class="no-data-text">Set your goals above and save to see progress tracking.</div>';
        return;
    }

    // Get current month trades
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
    const monthEnd = now.toISOString().split('T')[0];
    const monthTrades = state.trades.filter(t => t.date >= monthStart && t.date <= monthEnd);

    // Calculate current month stats
    const monthNet = monthTrades.reduce((s, t) => s + t.net, 0);
    const wins = monthTrades.filter(t => t.net > 0).length;
    const winRate = monthTrades.length > 0 ? (wins / monthTrades.length) * 100 : 0;

    // Daily stats
    const dailyMap = {};
    monthTrades.forEach(t => {
        if (!dailyMap[t.date]) dailyMap[t.date] = { pnl: 0, count: 0 };
        dailyMap[t.date].pnl += t.net;
        dailyMap[t.date].count++;
    });

    const tradingDays = Object.keys(dailyMap).length;
    const worstDay = Math.min(...Object.values(dailyMap).map(d => d.pnl), 0);
    const maxTradesInDay = Math.max(...Object.values(dailyMap).map(d => d.count), 0);

    // Days info
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const dayOfMonth = now.getDate();
    const daysRemaining = daysInMonth - dayOfMonth;

    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'];
    const monthLabel = monthNames[now.getMonth()] + ' ' + now.getFullYear();

    let html = `<div style="grid-column: 1/-1; margin-bottom: 8px; display: flex; align-items: center; justify-content: space-between;">
        <h3 style="font-size: 16px; font-weight: 600;">📅 ${monthLabel} Progress</h3>
        <span style="font-size: 12px; color: var(--text-muted);">${tradingDays} trading days · ${daysRemaining} days remaining</span>
    </div>`;

    // 1. Monthly P&L Target
    if (g.pnl) {
        const pct = Math.min((monthNet / g.pnl) * 100, 100);
        const pctReal = (monthNet / g.pnl) * 100;
        const status = pctReal >= 100 ? 'achieved' : pctReal >= 60 ? 'on-track' : pctReal >= 30 ? 'warning' : 'exceeded';
        const statusLabel = pctReal >= 100 ? '✅ ACHIEVED' : pctReal >= 60 ? 'ON TRACK' : pctReal >= 30 ? 'NEEDS WORK' : 'BEHIND';
        const netClass = monthNet >= 0 ? 'text-green' : 'text-red';

        html += `<div class="goal-card">
            <div class="goal-card-header">
                <div class="goal-card-title"><span class="icon">💰</span><span>Monthly P&L Target</span></div>
                <span class="goal-status ${status}">${statusLabel}</span>
            </div>
            <div class="goal-values">
                <span class="goal-current ${netClass}">$${monthNet.toFixed(2)}</span>
                <span class="goal-target">Target: $${g.pnl.toFixed(2)}</span>
            </div>
            <div class="goal-progress-bar"><div class="goal-progress-fill green" style="width: ${Math.max(0, pct)}%"></div></div>
            <div class="goal-percentage">${pctReal.toFixed(1)}% of goal</div>
        </div>`;
    }

    // 2. Max Loss Per Day
    if (g.maxLoss) {
        const lossLimit = Math.abs(g.maxLoss);
        const worstDayAbs = Math.abs(worstDay);
        const pct = lossLimit > 0 ? Math.min((worstDayAbs / lossLimit) * 100, 100) : 0;
        const isOk = worstDayAbs <= lossLimit;
        const status = isOk ? 'on-track' : 'exceeded';
        const statusLabel = isOk ? 'WITHIN LIMIT' : '⚠️ EXCEEDED';

        html += `<div class="goal-card">
            <div class="goal-card-header">
                <div class="goal-card-title"><span class="icon">🛡️</span><span>Max Loss Per Day</span></div>
                <span class="goal-status ${status}">${statusLabel}</span>
            </div>
            <div class="goal-values">
                <span class="goal-current ${isOk ? 'text-green' : 'text-red'}">-$${worstDayAbs.toFixed(2)}</span>
                <span class="goal-target">Limit: -$${lossLimit.toFixed(2)}</span>
            </div>
            <div class="goal-progress-bar"><div class="goal-progress-fill ${isOk ? 'blue' : 'red'}" style="width: ${pct}%"></div></div>
            <div class="goal-percentage">Worst day: -$${worstDayAbs.toFixed(2)}</div>
        </div>`;
    }

    // 3. Max Trades Per Day
    if (g.maxTrades) {
        const pct = Math.min((maxTradesInDay / g.maxTrades) * 100, 100);
        const isOk = maxTradesInDay <= g.maxTrades;
        const status = isOk ? 'on-track' : 'exceeded';
        const statusLabel = isOk ? 'WITHIN LIMIT' : '⚠️ EXCEEDED';

        html += `<div class="goal-card">
            <div class="goal-card-header">
                <div class="goal-card-title"><span class="icon">📊</span><span>Max Trades Per Day</span></div>
                <span class="goal-status ${status}">${statusLabel}</span>
            </div>
            <div class="goal-values">
                <span class="goal-current ${isOk ? 'text-green' : 'text-red'}">${maxTradesInDay}</span>
                <span class="goal-target">Limit: ${g.maxTrades} trades</span>
            </div>
            <div class="goal-progress-bar"><div class="goal-progress-fill ${isOk ? 'blue' : 'red'}" style="width: ${pct}%"></div></div>
            <div class="goal-percentage">Busiest day: ${maxTradesInDay} trades</div>
        </div>`;
    }

    // 4. Min Win Rate
    if (g.minWinRate) {
        const pct = Math.min((winRate / g.minWinRate) * 100, 100);
        const isOk = winRate >= g.minWinRate;
        const status = isOk ? 'achieved' : winRate >= g.minWinRate * 0.8 ? 'warning' : 'exceeded';
        const statusLabel = isOk ? '✅ ON TARGET' : winRate >= g.minWinRate * 0.8 ? 'CLOSE' : 'BELOW TARGET';

        html += `<div class="goal-card">
            <div class="goal-card-header">
                <div class="goal-card-title"><span class="icon">🎯</span><span>Win Rate</span></div>
                <span class="goal-status ${status}">${statusLabel}</span>
            </div>
            <div class="goal-values">
                <span class="goal-current ${isOk ? 'text-green' : 'text-red'}">${winRate.toFixed(1)}%</span>
                <span class="goal-target">Target: ${g.minWinRate.toFixed(1)}%</span>
            </div>
            <div class="goal-progress-bar"><div class="goal-progress-fill ${isOk ? 'green' : 'amber'}" style="width: ${pct}%"></div></div>
            <div class="goal-percentage">${wins} wins of ${monthTrades.length} trades</div>
        </div>`;
    }

    container.innerHTML = html;
}
