import { connectHost } from "@openchamber/sdk";
import { applyHostReady } from "@openchamber/sdk/ui";
import { getColor, validateColorMaps } from "./colors.js";

const host = connectHost();
const contentEl = document.getElementById('content');
const refreshBtn = document.getElementById('refresh');
const tabs = document.querySelectorAll('.tab');

let pollInterval;
let currentView = 'usage';
let debounceTimer;

// ====== CHART STATE & PERSISTENCE ======

const chartState = {
    preset: '24h',
    split: 'model',
    hidden: { model: [], agent: [] },
    window: null,
    zoomStack: [],
    data: null,
    error: null,
    loading: false,
    seq: 0,
    active: null,
    geom: null,
    cumulativeData: null
};

let colorMap = { model: new Map(), agent: new Map() };

function loadState() {
    try {
        const stored = localStorage.getItem('kiro-usage:chart:v1');
        if (stored) {
            const parsed = JSON.parse(stored);
            chartState.preset = parsed.preset || '24h';
            chartState.split = parsed.split || 'model';
            chartState.hidden = parsed.hidden || { model: [], agent: [] };
        }
        const colorStored = localStorage.getItem('kiro-usage:colors:v1');
        if (colorStored) {
            try {
                const parsed = JSON.parse(colorStored);
                const validated = validateColorMaps(parsed);
                colorMap = validated;
            } catch {
                colorMap = { model: new Map(), agent: new Map() };
            }
        } else {
            colorMap = { model: new Map(), agent: new Map() };
        }
    } catch (e) {
        colorMap = { model: new Map(), agent: new Map() };
    }
}

function saveState() {
    try {
        localStorage.setItem('kiro-usage:chart:v1', JSON.stringify({
            preset: chartState.preset,
            split: chartState.split,
            hidden: chartState.hidden
        }));
        const colors = {};
        for (const [ns, map] of Object.entries(colorMap)) {
            colors[ns] = Array.from(map);
        }
        localStorage.setItem('kiro-usage:colors:v1', JSON.stringify(colors));
    } catch (e) {
        // ignore
    }
}

function getColorImpl(key) {
    const color = getColor(key, chartState.split, colorMap);
    if (color !== '#d1d5db' && color !== '#9ca3af') {
        saveState();
    }
    return color;
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// ====== USAGE RENDERERS (existing) ======

function formatTime(date) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function renderLoading() {
    contentEl.innerHTML = '<div class="loading">Loading Kiro usage...</div>';
}

function renderError(message) {
    contentEl.innerHTML = `<div class="error-message">${escapeHtml(message)}</div>`;
}

function computeWorkdayPace(now = new Date()) {
    const year = now.getFullYear();
    const month = now.getMonth();

    // First day of month
    const firstDay = new Date(year, month, 1);
    // Last day of month
    const lastDay = new Date(year, month + 1, 0);

    let totalWorkdays = 0;
    let elapsedWorkdays = 0;

    // Count all workdays in the month
    const current = new Date(firstDay);
    while (current <= lastDay) {
        const day = current.getDay();
        // Monday (1) through Friday (5)
        if (day >= 1 && day <= 5) {
            totalWorkdays++;
        }
        current.setDate(current.getDate() + 1);
    }

    // Count elapsed workdays up to and including today
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const start = new Date(firstDay);
    while (start <= today) {
        const day = start.getDay();
        if (day >= 1 && day <= 5) {
            elapsedWorkdays++;
        }
        start.setDate(start.getDate() + 1);
    }

    return { totalWorkdays, elapsedWorkdays };
}

function renderAccounts(entries, totalUsed, totalLimit, totalPct, expectedByNow, paceOk, elapsedWorkdays, totalWorkdays) {
    let html = '';

    entries.forEach(entry => {
        if (entry.error) {
            html += `
                <div class="account">
                    <div class="email">${entry.email}</div>
                    <div class="error-text">Unavailable: ${entry.error}</div>
                </div>
            `;
        } else {
            const colorClass = entry.pct >= 90 ? 'red' : entry.pct >= 75 ? 'orange' : 'green';
            html += `
                <div class="account">
                    <div class="email">${entry.email}</div>
                    <div class="progress-bar">
                        <div class="progress-fill ${colorClass}" style="width: ${Math.min(entry.pct, 100)}%"></div>
                    </div>
                    <div class="usage-text">${entry.used} / ${entry.limit} credits (${entry.pct}%)</div>
                </div>
            `;
        }
    });

    if (entries.length > 0) {
        html += `<div class="summary">Total: ${totalUsed.toFixed(2)} / ${totalLimit.toFixed(2)} credits (${totalPct}%)</div>`;

        if (totalLimit > 0) {
            html += `
                <div class="pace">
                    <div class="pace-label">Pace: ${totalUsed.toFixed(2)} used vs ${expectedByNow.toFixed(2)} expected by day ${elapsedWorkdays}/${totalWorkdays} workdays (<span class="pace-status ${paceOk ? 'ok' : 'over'}">${paceOk ? 'on track' : 'over budget'}</span>)</div>
                    <div class="pace-bar">
                        <div class="pace-bar-fill ${paceOk ? 'green' : 'red'}" style="width: ${Math.min((totalUsed / totalLimit) * 100, 100)}%"></div>
                        <div class="pace-marker" style="left: ${Math.min((expectedByNow / totalLimit) * 100, 100)}%"></div>
                    </div>
                </div>
            `;
        }
    }

    contentEl.innerHTML = html;
}

function updateLastUpdated() {
    const timeEl = document.createElement('div');
    timeEl.className = 'last-updated';
    timeEl.textContent = `Last updated: ${formatTime(new Date())}`;

    const existing = contentEl.querySelector('.last-updated');
    if (existing) {
        contentEl.removeChild(existing);
    }
    contentEl.appendChild(timeEl);
}

// ====== REQUEST DRILL-DOWN RENDERERS ======

function formatRelativeTime(timestamp) {
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now - date;

    if (diff < 60000) return 'just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return date.toLocaleDateString();
}

function renderRequestList(records, total, limit, offset) {
    if (records.length === 0) {
        contentEl.innerHTML = `
            <div class="empty-state">
                <h3>No requests found</h3>
                <p>No API requests match your filters.</p>
            </div>
        `;
        return;
    }

    let html = `
        <div class="results-header">
            Showing ${Math.min(offset + 1, total)}-${Math.min(offset + records.length, total)} of ${total} requests
        </div>
        <div class="request-list">
    `;

    records.forEach(record => {
        const statusClass = record.isError ? 'error' : 'ok';
        const statusText = record.isError ? 'error' : 'ok';
        const creditsDisplay = record.credits !== undefined && record.credits !== null
            ? `${record.credits.toFixed(1)} cr`
            : '—';
        const rateDisplay = record.rate ? `<span style="color: var(--oc-muted, #888); font-size: 11px;">${record.rate}</span>` : '';
        const inputTokensDisplay = record.inputTokens !== undefined && record.inputTokens !== null
            ? `${record.inputTokens.toLocaleString()} in`
            : null;
        const outputTokensDisplay = record.outputTokens !== undefined && record.outputTokens !== null
            ? `${record.outputTokens.toLocaleString()} out`
            : null;
        const tokensDisplay = [inputTokensDisplay, outputTokensDisplay].filter(Boolean).join(' / ');

        html += `
            <div class="request-row collapsed" data-id="${record.id}">
                <div class="request-header">
                    <span class="request-time">${formatRelativeTime(record.timestamp)}</span>
                    <span class="request-email">${record.email || '—'}</span>
                    <span class="request-model" title="${record.model || ''}">${record.model || '—'}${rateDisplay ? ' <span style="color: var(--oc-muted, #888); font-size: 11px;">' + rateDisplay + '</span>' : ''}</span>
                    <span class="request-status ${statusClass}">${statusText}${creditsDisplay !== '—' ? ` · ${creditsDisplay}${tokensDisplay ? ' · ' + tokensDisplay : ''}` : ''}</span>
                </div>
                <div class="request-details" style="display: none;"></div>
            </div>
        `;
    });

    html += '</div>';

    // Pagination
    if (total > limit) {
        html += `
            <div class="pagination">
                <button class="pagination-btn" ${offset === 0 ? 'disabled' : ''} data-action="prev">Previous</button>
                <span style="color: var(--oc-muted, #888); font-size: 13px;">
                    Page ${Math.floor(offset / limit) + 1} of ${Math.ceil(total / limit)}
                </span>
                <button class="pagination-btn" ${offset + records.length >= total ? 'disabled' : ''} data-action="next">Next</button>
            </div>
        `;
    }

    contentEl.innerHTML = html;

    // Attach event listeners for expandable rows
    document.querySelectorAll('.request-row').forEach(row => {
        row.addEventListener('click', (e) => {
            if (e.target.closest('.pagination-btn') || e.target.closest('.request-details')) {
                return;
            }
            toggleRowDetails(row);
        });
    });

    // Attach pagination listeners
    document.querySelectorAll('.pagination-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const action = e.target.dataset.action;
            if (action === 'prev') {
                loadRequests({ offset: Math.max(0, offset - limit) });
            } else if (action === 'next') {
                loadRequests({ offset: offset + limit });
            }
        });
    });
}

function toggleRowDetails(row) {
    const detailsEl = row.querySelector('.request-details');
    const isCollapsed = row.classList.contains('collapsed');

    if (isCollapsed) {
        row.classList.remove('collapsed');
        row.classList.add('expanded');
        detailsEl.style.display = 'block';
        detailsEl.innerHTML = '<em style="color: var(--oc-muted, #888)">Loading…</em>';

        const id = row.dataset.id;
        loadRequestDetail(id).then(record => {
            if (!record) {
                detailsEl.innerHTML = '<em style="color: var(--oc-error-text, #e74c3c)">Failed to load detail</em>';
                return;
            }

            // Build request summary (model, conversation, message preview, tool counts)
            let requestSummaryHtml = '';
            {
                const req = record.request;
                let body = req?.body;
                if (typeof body === 'string') {
                    try { body = JSON.parse(body); } catch (e) { body = null; }
                }
                const userMsg = body?.conversationState?.currentMessage?.userInputMessage;
                const historyLength = body?.conversationState?.historyLength;
                const conversationId = body?.conversationState?.conversationId || req?.conversationId;
                const modelId = userMsg?.modelId || req?.model;
                const toolCount = userMsg?.userInputMessageContext?.tools?.length;
                const toolResultCount = userMsg?.userInputMessageContext?.toolResults?.length;
                const content = userMsg?.content;
                const contentPreview = typeof content === 'string'
                    ? (content.length > 300 ? content.slice(0, 300) + '…' : content)
                    : null;

                if (userMsg || req?.url) {
                    const rows = [];
                    if (modelId) rows.push(`<div><strong style="color: var(--oc-info-text, #b0b0b0)">Model:</strong> ${escapeHtml(modelId)}</div>`);
                    if (req?.url) rows.push(`<div><strong style="color: var(--oc-info-text, #b0b0b0)">URL:</strong> ${escapeHtml(req.url)}</div>`);
                    if (conversationId) rows.push(`<div><strong style="color: var(--oc-info-text, #b0b0b0)">Conversation:</strong> ${escapeHtml(conversationId)}</div>`);
                    if (historyLength !== undefined) rows.push(`<div><strong style="color: var(--oc-info-text, #b0b0b0)">History length:</strong> ${historyLength}</div>`);
                    if (toolCount !== undefined) rows.push(`<div><strong style="color: var(--oc-info-text, #b0b0b0)">Tools available:</strong> ${toolCount}</div>`);
                    if (toolResultCount !== undefined) rows.push(`<div><strong style="color: var(--oc-info-text, #b0b0b0)">Tool results in message:</strong> ${toolResultCount}</div>`);
                    const previewHtml = contentPreview
                        ? `<div style="margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--oc-border, #444);">
                            <strong style="color: var(--oc-info-text, #b0b0b0)">Message preview:</strong>
                            <div style="margin-top: 4px; white-space: pre-wrap; word-break: break-word; color: var(--oc-fg, #e0e0e0);">${escapeHtml(contentPreview)}</div>
                           </div>`
                        : '';
                    requestSummaryHtml = `
                        <div style="margin-bottom: 12px; padding: 10px; background: var(--oc-bg, #1a1a1a); border-radius: var(--oc-radius, 4px); border: 1px solid var(--oc-border, #444); font-size: 12px;">
                            <div style="font-size: 13px; margin-bottom: 8px; color: var(--oc-primary-text, #e0e0e0); font-weight: 500;">Request Summary</div>
                            ${rows.join('\n')}
                            ${previewHtml}
                        </div>
                    `;
                }
            }

            // Build usage summary
            let usageHtml = '';
            if (record.response?.usage) {
                const usage = record.response.usage;
                const creditsDisplay = usage.credits !== undefined && usage.credits !== null
                    ? `<div style="margin-bottom: 8px;"><strong style="color: var(--oc-success-text, #2ecc71)">Credits:</strong> ${usage.credits.toFixed(1)}</div>`
                    : '';
                const rateDisplay = usage.rate ? `<div style="margin-bottom: 8px;"><strong style="color: var(--oc-primary-text, #e0e0e0)">Rate Multiplier:</strong> ${usage.rate}</div>` : '';
                const tokensHtml = usage.inputTokens !== undefined || usage.outputTokens !== undefined || usage.totalTokens !== undefined
                    ? `<div style="margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--oc-border, #444); font-size: 12px;">
                        <div><strong style="color: var(--oc-info-text, #b0b0b0)">Input tokens:</strong> ${usage.inputTokens ?? '—'}</div>
                        <div><strong style="color: var(--oc-info-text, #b0b0b0)">Output tokens:</strong> ${usage.outputTokens ?? '—'}</div>
                        <div><strong style="color: var(--oc-info-text, #b0b0b0)">Total tokens:</strong> ${usage.totalTokens ?? '—'}</div>
                        <div><strong style="color: var(--oc-info-text, #b0b0b0)">Cache read tokens:</strong> ${usage.cacheReadInputTokens ?? '—'}</div>
                        <div><strong style="color: var(--oc-info-text, #b0b0b0)">Cache write tokens:</strong> ${usage.cacheWriteInputTokens ?? '—'}</div>
                        <div><strong style="color: var(--oc-info-text, #b0b0b0)">Context used:</strong> ${usage.contextUsagePercentage !== undefined ? usage.contextUsagePercentage.toFixed(1) + '%' : '—'}</div>
                       </div>`
                    : '';

                usageHtml = `
                    <div style="margin-bottom: 12px; padding: 10px; background: var(--oc-bg, #1a1a1a); border-radius: var(--oc-radius, 4px); border: 1px solid var(--oc-border, #444);">
                        <div style="font-size: 13px; margin-bottom: 8px; color: var(--oc-primary-text, #e0e0e0); font-weight: 500;">Usage Summary</div>
                        ${creditsDisplay}
                        ${rateDisplay}
                        ${tokensHtml}
                    </div>
                `;
            }

            const requestHtml = `
                <strong style="color: var(--oc-success-text, #2ecc71)">Request:</strong>
                <pre>${JSON.stringify(record.request, null, 2)}</pre>
            `;
            const responseHtml = record.response
                ? `
                    <strong style="color: var(--oc-primary-text, #e0e0e0)">Response:</strong>
                    <pre>${JSON.stringify(record.response, null, 2)}</pre>
                  `
                : '<em style="color: var(--oc-muted, #888)">No response recorded</em>';
            detailsEl.innerHTML = `${requestSummaryHtml}${usageHtml}${requestHtml}\n\n${responseHtml}`;
        });
    } else {
        detailsEl.innerHTML = '';
        detailsEl.style.display = 'none';
        row.classList.remove('expanded');
        row.classList.add('collapsed');
    }
}

async function loadRequestDetail(id) {
    try {
        const result = await host.serviceRequest({
            method: 'GET',
            path: `/requests/detail?id=${encodeURIComponent(id)}`
        });
        const data = typeof result.body === 'string' ? JSON.parse(result.body) : result.body;
        return data.record || null;
    } catch (e) {
        return null;
    }
}

function renderEmptyLogDir() {
    contentEl.innerHTML = `
        <div class="empty-state">
            <h3>API request logging is disabled</h3>
            <p>To view API request logs, enable logging in your Kiro plugin config by setting:</p>
            <p><code>enable_log_api_request: true</code></p>
            <p style="margin-top: 16px; color: var(--oc-muted, #888); font-size: 13px;">
                Once enabled, API requests will be captured and appear here.
            </p>
        </div>
    `;
}

async function loadRequests(filters = {}) {
    try {
        const params = new URLSearchParams();
        if (filters.account) params.append('account', filters.account);
        if (filters.status) params.append('status', filters.status);
        if (filters.from) params.append('from', filters.from);
        if (filters.to) params.append('to', filters.to);
        if (filters.q) params.append('q', filters.q);
        params.append('limit', filters.limit || 100);
        params.append('offset', filters.offset || 0);

        const result = await host.serviceRequest({
            method: 'GET',
            path: `/requests?${params.toString()}`
        });

        const data = typeof result.body === 'string' ? JSON.parse(result.body) : result.body;

        if (data.logDirMissing) {
            renderEmptyLogDir();
        } else {
            renderRequestList(data.records, data.total, filters.limit || 100, filters.offset || 0);
        }
    } catch (error) {
        renderError(`Failed to fetch requests: ${error.message}`);
    }
}

// ====== FILTER HANDLERS ======

function debounce(fn, delay) {
    return (...args) => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => fn(...args), delay);
    };
}

function applyFilters() {
    const account = document.getElementById('filter-account')?.value || '';
    const status = document.getElementById('filter-status')?.value || '';
    const from = document.getElementById('filter-from')?.value || '';
    const to = document.getElementById('filter-to')?.value || '';
    const q = document.getElementById('filter-q')?.value || '';

    loadRequests({ account, status, from, to, q });
}

const debouncedApplyFilters = debounce(applyFilters, 300);

// ====== TAB SWITCHING ======

function switchTab(view) {
    currentView = view;

    tabs.forEach(tab => {
        if (tab.dataset.view === view) {
            tab.classList.add('active');
        } else {
            tab.classList.remove('active');
        }
    });

    if (view === 'usage') {
        renderLoading();
        refreshUsage();
    } else {
        applyFilters();
    }
}

function formatBucketLabel(date, bucket, split) {
    if (bucket === 'hour') {
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } else {
        // Short format for daily: "08/10" or "Thu 8" to save space
        const day = date.getDate();
        const month = date.getMonth() + 1;
        const dow = date.toLocaleDateString([], { weekday: 'short' });
        return `${dow} ${day}`;
    }
}



// Compute cumulative credits from buckets filtered by visible keys
function computeCumulativeData(buckets, visibleKeys) {
    const cumulative = [];
    let sum = 0;
    for (const bucket of buckets) {
        for (const k of visibleKeys) {
            sum += bucket.series[k.key] || 0;
        }
        cumulative.push(sum);
    }
    return cumulative;
}

function renderChart(data, section) {
    const emptyDiv = section.querySelector('.uc-empty');
    if (!data || !data.buckets || data.buckets.length === 0) {
        emptyDiv.textContent = data && data.totals && data.totals.credits === 0 ? 'No credit usage in this range' : 'No data available';
        emptyDiv.hidden = false;
        const svg = section.querySelector('.uc-plot svg');
        svg.innerHTML = '';
        section.querySelector('.uc-live').textContent = '';
        return;
    }

    emptyDiv.hidden = true;
    const svg = section.querySelector('.uc-plot svg');
    if (!svg) return;

    const plot = section.querySelector('.uc-plot');
    let W = Math.max(1, plot.getBoundingClientRect().width - 96);
    if (W <= 0 || !isFinite(W)) W = 400;

    const buckets = data.buckets;
    const keys = data.keys || [];
    const visibleKeys = keys.filter(k => !chartState.hidden[chartState.split]?.includes(k.key));

    // Compute cumulative data for visible keys only
    const cumulative = computeCumulativeData(buckets, visibleKeys);
    chartState.cumulativeData = cumulative;
    const maxCumulative = Math.max(...cumulative, 1);

    const maxTotal = Math.max(...buckets.map(b => b.total), 1);
    const H = 200;
    const PH = H;  // Plot height
    const N = buckets.length;
    const slot = W / N;
    const barW = Math.max(1, slot * 0.8);

    const ticks = [];
    const tickCount = 4;
    for (let i = 0; i <= tickCount; i++) {
        ticks.push((maxTotal / tickCount) * i);
    }

    const yAxis = section.querySelector('.uc-yaxis');
    yAxis.innerHTML = ticks.map(t => `<div>${t.toFixed(1)}</div>`).join('');
    // ponytail: sync y-axis height with plot; padding-bottom handles label strip
    yAxis.style.minHeight = PH + 'px';
    yAxis.style.paddingBottom = '28px';

    let bars = '';
    let hitRects = '';
    let labelsSvg = '';
    // Adaptive label spacing: estimate label width (~7px/char for 11px font at 96dpi) + 12px gap
    // Prefer showing every Nth label so labels don't overlap
    const estimatedLabelWidth = data.bucket === 'hour' ? 35 : 50;  // HH:MM vs "Thu 8"
    const minGap = 12;
    const minSlotForLabel = estimatedLabelWidth + minGap;
    const labelSpacing = Math.max(1, Math.ceil(minSlotForLabel / slot));

    // Always show first label; then every Nth label
    const shouldShowLabel = (i) => i === 0 || (i % labelSpacing === 0);
    let hoverIdx = null;
    let hoverRect = '';

    for (let i = 0; i < N; i++) {
        const bucket = buckets[i];
        const x = i * slot;
        let y = PH;

        for (const k of visibleKeys) {
            const credits = bucket.series[k.key] || 0;
            if (credits > 0) {
                const h = (credits / maxTotal) * PH;
                const color = getColorImpl(k.key);
                bars += `<rect x="${x}" y="${y - h}" width="${barW}" height="${h}" fill="${color}" class="uc-bar" data-key="${escapeHtml(k.key)}" data-credits="${credits.toFixed(4)}" data-idx="${i}"/>`;
                y -= h;
            }
        }

        hitRects += `<rect x="${i * slot}" y="0" width="${slot}" height="${PH}" class="uc-hit" data-idx="${i}" tabindex="0"/>`;

        if (shouldShowLabel(i)) {
            const bucket = buckets[i];
            const date = new Date(bucket.start);
            const label = formatBucketLabel(date, data.bucket, chartState.split);
            // Labels below baseline at y=PH+16; dominant-baseline:hanging aligns top of text to y
            labelsSvg += `<text x="${i * slot + slot / 2}" y="${PH + 16}" text-anchor="middle" dominant-baseline="hanging" class="uc-label">${escapeHtml(label)}</text>`;
            // Thin tick mark at baseline
            labelsSvg += `<line x1="${i * slot + slot / 2}" y1="${PH}" x2="${i * slot + slot / 2}" y2="${PH + 4}" stroke="var(--oc-border, #555)" stroke-width="1"/>`;
        }
    }

    bars += hitRects + labelsSvg;

    let cumulativeLine = '';
    let cumulativeDots = '';
    let cumulativeRightAxis = '';

    // Build cumulative line and dots
    for (let i = 0; i < N; i++) {
        const cumY = PH - (cumulative[i] / maxCumulative) * PH;
        const cumX = i * slot + slot / 2;
        if (i === 0) {
            cumulativeLine = `M ${cumX} ${cumY}`;
        } else {
            cumulativeLine += ` L ${cumX} ${cumY}`;
        }
        cumulativeDots += `<circle cx="${cumX}" cy="${cumY}" r="2" fill="white" opacity="0.7" class="uc-cumulative-dot"/>`;
    }

    // Right-side cumulative axis labels
    const cumulativeTicks = [];
    for (let i = 0; i <= tickCount; i++) {
        cumulativeTicks.push((maxCumulative / tickCount) * i);
    }
    cumulativeRightAxis = `<g class="uc-cumulative-axis" font-size="11" fill="rgba(255,255,255,0.4)" text-anchor="start">`;
    cumulativeTicks.forEach((tick) => {
        const y = PH - (tick / maxCumulative) * PH;
        cumulativeRightAxis += `<text x="${W + 4}" y="${y + 4}">${tick.toFixed(1)}</text>`;
    });
    cumulativeRightAxis += `</g>`;

    bars += `<g class="uc-cumulative" stroke="white" stroke-width="1.5" fill="none" opacity="0.7"><path d="${cumulativeLine}"/></g>`;
    bars += cumulativeDots;
    bars += cumulativeRightAxis;
    // SVG viewBox and height: PH (200) for bars, +28 for label strip below
    svg.setAttribute('viewBox', `0 0 ${W} ${PH + 28}`);
    svg.setAttribute('height', PH + 28);
    svg.setAttribute('width', W);
    svg.innerHTML = bars;

    chartState.geom = { slot, W, N, PH };

    // Track pinned state for hover/click
    let pinnedIdx = null;
    let brushActive = false;

    svg.querySelectorAll('.uc-hit').forEach(hit => {
        hit.addEventListener('click', () => {
            const idx = parseInt(hit.dataset.idx);
            pinnedIdx = pinnedIdx === idx ? null : idx;  // Toggle pin
            if (pinnedIdx !== null) {
                chartState.active = pinnedIdx;
                updateTooltip(pinnedIdx, data, section, true);  // true = from click/keyboard
            } else {
                section.querySelector('.uc-tip').style.display = 'none';
            }
        });
        hit.addEventListener('keydown', (e) => {
            const idx = parseInt(hit.dataset.idx);
            if (e.key === 'ArrowLeft' && idx > 0) {
                e.preventDefault();
                chartState.active = idx - 1;
                pinnedIdx = idx - 1;
                section.querySelectorAll('.uc-hit')[idx - 1].focus();
                updateTooltip(idx - 1, data, section, true);
            } else if (e.key === 'ArrowRight' && idx < N - 1) {
                e.preventDefault();
                chartState.active = idx + 1;
                pinnedIdx = idx + 1;
                section.querySelectorAll('.uc-hit')[idx + 1].focus();
                updateTooltip(idx + 1, data, section, true);
            } else if (e.key === 'Home') {
                e.preventDefault();
                chartState.active = 0;
                pinnedIdx = 0;
                section.querySelectorAll('.uc-hit')[0].focus();
                updateTooltip(0, data, section, true);
            } else if (e.key === 'End') {
                e.preventDefault();
                chartState.active = N - 1;
                pinnedIdx = N - 1;
                section.querySelectorAll('.uc-hit')[N - 1].focus();
                updateTooltip(N - 1, data, section, true);
            } else if (e.key === 'Enter') {
                e.preventDefault();
                const bucket = data.buckets[idx];
                chartState.zoomStack.push(chartState.window);
                if (data.bucket === 'day') {
                    chartState.window = { from: bucket.start, to: bucket.end };
                } else if (data.bucket === 'hour') {
                    if (N > 5) {
                        chartState.window = { from: new Date(new Date(bucket.start).getTime() - 2*3600000).toISOString(), to: new Date(new Date(bucket.end).getTime() + 2*3600000).toISOString() };
                    } else {
                        return;
                    }
                }
                chartState.active = null;
                pinnedIdx = null;
                section.querySelector('.uc-tip').style.display = 'none';
                fetchChart();
            } else if (e.key === '-') {
                e.preventDefault();
                zoomOut();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                chartState.active = null;
                pinnedIdx = null;
                section.querySelector('.uc-tip').style.display = 'none';
            }
        });
    });

    // Hover tooltip: show on pointermove unless brushing
    svg.addEventListener('pointermove', (e) => {
        if (brushActive) {
            section.querySelector('.uc-tip').style.display = 'none';
            return;
        }
        const g = chartState.geom;
        if (!g) return;
        const r = svg.getBoundingClientRect();
        const x = (e.clientX - r.left) * (g.W / r.width);
        const idx = Math.max(0, Math.min(g.N - 1, Math.floor(x / g.slot)));
        const bucket = data.buckets[idx];
        // Skip empty buckets
        if (bucket.total === 0) {
            section.querySelector('.uc-tip').style.display = 'none';
            return;
        }
        updateTooltip(idx, data, section, false);  // false = from hover, no aria-live
    });

    svg.addEventListener('pointerleave', () => {
        // Hide tooltip on leave unless pinned
        if (pinnedIdx === null) {
            section.querySelector('.uc-tip').style.display = 'none';
        }
    });
}

function updateTooltip(idx, data, section, fromClick = false) {
    const bucket = data.buckets[idx];
    const tip = section.querySelector('.uc-tip');
    const visibleKeys = data.keys.filter(k => !chartState.hidden[chartState.split]?.includes(k.key));

    const date = new Date(bucket.start);
    const endDate = new Date(bucket.end);
    let timeStr = date.toLocaleTimeString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) +
        ' – ' + endDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    let keysHtml = visibleKeys
        .filter(k => bucket.series[k.key])
        .map(k => `<div style="font-size:11px; color:var(--oc-fg);">${escapeHtml(k.key)}: ${bucket.series[k.key].toFixed(2)} cr</div>`)
        .join('');

    // Add cumulative if available
    const cumulative = chartState.cumulativeData?.[idx];
    const cumulativeHtml = cumulative !== undefined ? `<div style="font-size:11px; color:rgba(255,255,255,0.5);">Cumulative: ${cumulative.toFixed(2)} cr</div>` : '';

    tip.innerHTML = `<div style="font-weight:500;">${timeStr}</div><div>${bucket.total.toFixed(2)} credits · ${bucket.count} requests</div>${keysHtml}${cumulativeHtml}`;
    tip.style.display = 'block';

    // Position tooltip: clamp vertically to stay within plot container
    const g = chartState.geom;
    if (g) {
        // Horizontal clamping (keep existing logic)
        const tipWidth = Math.min(tip.offsetWidth || 200, 200);
        const slotCenter = (idx + 0.5) * g.slot + 40;
        let left = slotCenter - tipWidth / 2;
        const maxLeft = g.W + 40;
        if (left + tipWidth > maxLeft) {
            left = maxLeft - tipWidth;
        }
        if (left < 40) {
            left = 40;
        }
        tip.style.left = left + 'px';

        // .uc-plot clips overflow, so keep the tip inside it, pinned to the top
        tip.style.bottom = 'auto';
        tip.style.top = '4px';
    }

    // Only announce on click/keyboard, not on hover
    if (fromClick) {
        const liveEl = section.querySelector('.uc-live');
        const announcement = `${timeStr}: ${bucket.total.toFixed(2)} credits, ${bucket.count} requests`;
        liveEl.textContent = announcement;
    }
}

function zoomOut() {
    if (!chartState.data) return;
    if (chartState.zoomStack.length > 0) {
        chartState.window = chartState.zoomStack.pop();
    } else {
        const span = new Date(chartState.data.to) - new Date(chartState.data.from);
        const nextSpan = span * 2;
        if (nextSpan > 1000 * 60 * 60 * 24 * 400) {
            chartState.window = null;
        } else {
            const center = (new Date(chartState.data.from).getTime() + new Date(chartState.data.to).getTime()) / 2;
            const halfNext = nextSpan / 2;
            chartState.window = {
                from: new Date(center - halfNext).toISOString(),
                to: new Date(center + halfNext).toISOString()
            };
        }
    }
    fetchChart();
}

async function fetchChart() {
    chartState.seq++;
    const seq = chartState.seq;
    chartState.loading = true;

    const section = document.querySelector('.uc');
    if (section) {
        section.setAttribute('aria-busy', 'true');
    }

    try {
        const params = new URLSearchParams();
        params.append('split', chartState.split);

        if (chartState.window) {
            params.append('from', chartState.window.from);
            params.append('to', chartState.window.to);
            params.append('bucket', 'auto');
        } else {
            params.append('range', chartState.preset);
        }

        const result = await host.serviceRequest({
            method: 'GET',
            path: `/usage/series?${params.toString()}`
        });

        if (seq !== chartState.seq) return;

        const data = typeof result.body === 'string' ? JSON.parse(result.body) : result.body;
        if (result.status && result.status >= 400) throw new Error(data?.error || `HTTP ${result.status}`);

        chartState.data = data;
        chartState.error = null;

        const section = document.querySelector('.uc');
        if (section) {
            updateChartDisplay(section);
            renderChart(data, section);
        }
    } catch (error) {
        chartState.error = error.message;
        const freshSection = document.querySelector('.uc');
        if (freshSection) {
            const plot = freshSection.querySelector('.uc-plot');
            if (plot) {
                plot.innerHTML = `<div class="uc-empty"><p>Error: ${escapeHtml(error.message)}</p></div>`;
            }
        }
    } finally {
        chartState.loading = false;
        const freshSection = document.querySelector('.uc');
        if (freshSection) {
            freshSection.setAttribute('aria-busy', 'false');
        }
    }
}

function updateChartDisplay(section) {
    const data = chartState.data;
    if (!data) return;

    const summary = `${data.totals.credits.toFixed(2)} credits · ${data.totals.requests} requests${data.keys.length > 0 ? ` · top: ${data.keys[0].key} (${Math.round(data.keys[0].total / data.totals.credits * 100)}%)` : ''}`;
    const headerEl = section.querySelector('.uc-head p');
    if (headerEl) {
        headerEl.textContent = summary;
    }

    const resetBtn = section.querySelector('.uc-reset');
    if (resetBtn) {
        resetBtn.style.display = chartState.window ? 'inline-block' : 'none';
    }

    const legendEl = section.querySelector('.uc-legend');
    if (legendEl) {
        legendEl.innerHTML = `
            ${data.keys.map(k => `
                <button class="uc-chip ${chartState.hidden[chartState.split]?.includes(k.key) ? '' : 'active'}" data-key="${escapeHtml(k.key)}" aria-pressed="${!chartState.hidden[chartState.split]?.includes(k.key)}">
                    <span class="uc-swatch" style="background: ${getColorImpl(k.key)}"></span>
                    <span class="uc-name">${escapeHtml(k.key)}</span>
                    ${k.rate ? `<span class="uc-rate">${k.rate}</span>` : ''}
                    <span class="uc-total">${k.total.toFixed(2)} cr</span>
                </button>
            `).join('')}
            <button class="uc-chip uc-all">All</button>
            <button class="uc-chip uc-none">None</button>
        `;

        legendEl.querySelectorAll('[data-key]').forEach(chip => {
            chip.addEventListener('click', () => {
                const key = chip.dataset.key;
                const hidden = chartState.hidden[chartState.split] || [];
                const idx = hidden.indexOf(key);
                if (idx >= 0) {
                    hidden.splice(idx, 1);
                } else {
                    hidden.push(key);
                }
                chip.classList.toggle('active');
                saveState();
                renderChart(chartState.data, section);
            });
        });

        legendEl.querySelector('.uc-all')?.addEventListener('click', () => {
            chartState.hidden[chartState.split] = [];
            legendEl.querySelectorAll('[data-key]').forEach(chip => chip.classList.add('active'));
            saveState();
            renderChart(chartState.data, section);
        });

        legendEl.querySelector('.uc-none')?.addEventListener('click', () => {
            chartState.hidden[chartState.split] = Array.from(legendEl.querySelectorAll('[data-key]'), c => c.dataset.key);
            legendEl.querySelectorAll('[data-key]').forEach(chip => chip.classList.remove('active'));
            saveState();
            renderChart(chartState.data, section);
        });
    }

    const footEl = section.querySelector('.uc-foot');
    if (footEl) {
        let footHtml = '';
        if (data.totals.skipped) footHtml += `<p>${data.totals.skipped} entries skipped</p>`;
        if (data.totals.unreadable) footHtml += `<p>${data.totals.unreadable} log files unreadable</p>`;

        if (chartState.split === 'agent' && data.meta?.agentAttribution) {
            const attr = data.meta.agentAttribution;
            const parts = [];
            if (attr.captured) parts.push(`${attr.captured} captured`);
            if (attr.inferred) parts.push(`${attr.inferred} inferred from session history`);
            if (attr.ambiguous) parts.push(`${attr.ambiguous} ambiguous (parallel same-model agents)`);
            const unknownTotal = (attr.unknown.no_candidate || 0) + (attr.unknown.db_unavailable || 0) + (attr.unknown.out_of_coverage || 0);
            if (unknownTotal) parts.push(`${unknownTotal} unknown`);
            if (parts.length) footHtml += `<p style="font-size: 12px; color: var(--oc-muted);">${parts.join(', ')}</p>`;
            if (data.meta.agentIndexError) {
                footHtml += `<p style="font-size: 12px; color: var(--oc-warning-text);">⚠ Agent index error: ${escapeHtml(data.meta.agentIndexError)}</p>`;
            }
        }

        footEl.innerHTML = footHtml;
    }
}

function buildChartSection() {
    const section = document.createElement('section');
    section.className = 'uc';
    section.setAttribute('aria-labelledby', 'uc-title');

    section.innerHTML = `
        <header class="uc-head">
            <h2 id="uc-title">Credit usage</h2>
            <p class="uc-summary">Loading...</p>
        </header>
        <div class="uc-toolbar">
            <div class="uc-seg">
                <button class="uc-btn ${chartState.preset === '6h' ? 'active' : ''}" data-preset="6h" aria-pressed="${chartState.preset === '6h'}">6h</button>
                <button class="uc-btn ${chartState.preset === '24h' ? 'active' : ''}" data-preset="24h" aria-pressed="${chartState.preset === '24h'}">24h</button>
                <button class="uc-btn ${chartState.preset === '7d' ? 'active' : ''}" data-preset="7d" aria-pressed="${chartState.preset === '7d'}">7d</button>
                <button class="uc-btn ${chartState.preset === '30d' ? 'active' : ''}" data-preset="30d" aria-pressed="${chartState.preset === '30d'}">30d</button>
            </div>
            <div class="uc-seg">
                <button class="uc-btn ${chartState.split === 'model' ? 'active' : ''}" data-split="model" aria-pressed="${chartState.split === 'model'}">Split by Model</button>
                <button class="uc-btn ${chartState.split === 'agent' ? 'active' : ''}" data-split="agent" aria-pressed="${chartState.split === 'agent'}">Split by Agent</button>
            </div>
            <button class="uc-btn uc-reset" style="display: ${chartState.window ? 'inline-block' : 'none'};">Reset zoom</button>
        </div>
        <div class="uc-legend"></div>
        <div class="uc-plot">
            <div class="uc-yaxis"></div>
            <svg role="group" tabindex="0" aria-label="Credit usage chart, use arrow keys to navigate"></svg>
            <div class="uc-tip" role="tooltip" style="display: none;"></div>
            <div class="uc-empty" hidden></div>
        </div>
        <div aria-live="polite" class="uc-live visually-hidden"></div>
        <div class="uc-foot"></div>
    `;

    section.querySelectorAll('[data-preset]').forEach(btn => {
        btn.addEventListener('click', () => {
            chartState.preset = btn.dataset.preset;
            chartState.window = null;
            chartState.zoomStack = [];
            chartState.active = null;
            saveState();
            section.querySelectorAll('[data-preset]').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            fetchChart();
        });
    });

    section.querySelectorAll('[data-split]').forEach(btn => {
        btn.addEventListener('click', () => {
            chartState.split = btn.dataset.split;
            chartState.active = null;
            saveState();
            section.querySelectorAll('[data-split]').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            fetchChart();
        });
    });

    section.querySelector('.uc-reset')?.addEventListener('click', () => {
        chartState.window = null;
        chartState.zoomStack = [];
        chartState.active = null;
        section.querySelector('.uc-reset').style.display = 'none';
        fetchChart();
    });

    // ====== RESIZE OBSERVER ======
    const plot = section.querySelector('.uc-plot');
    let resizeRAF = null;
    const resizeObserver = new ResizeObserver(() => {
        if (resizeRAF !== null) cancelAnimationFrame(resizeRAF);
        resizeRAF = requestAnimationFrame(() => {
            if (chartState.data?.buckets?.length) {
                renderChart(chartState.data, section);
            }
            resizeRAF = null;
        });
    });
    if (plot) resizeObserver.observe(plot);
    section._resizeObserver = resizeObserver;

    // ====== DRAG-BRUSH ======
    const svg = section.querySelector('.uc-plot svg');
    let brush = null;
    let suppressClick = false;
    let brushActive = false;  // Track brush state for hover tooltip

    const idxAt = (e) => {
        const g = chartState.geom;
        if (!g) return 0;
        const r = svg.getBoundingClientRect();
        const x = (e.clientX - r.left) * (g.W / r.width);
        return Math.max(0, Math.min(g.N - 1, Math.floor(x / g.slot)));
    };

    const cancel = () => {
        if (!brush) return;
        brush.el?.remove();
        svg.releasePointerCapture?.(brush.id);
        brush = null;
        brushActive = false;  // Reset flag
    };

    svg.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || !chartState.data?.buckets?.length) return;
        brush = { a: idxAt(e), b: idxAt(e), el: null, id: e.pointerId };
        brushActive = true;  // Set flag
        svg.setPointerCapture(e.pointerId);
    });

    svg.addEventListener('pointermove', (e) => {
        if (!brush) return;
        brush.b = idxAt(e);
        if (brush.a === brush.b) {
            brush.el?.setAttribute('width', 0);
            return;
        }
        if (!brush.el) {
            brush.el = document.createElementNS('http://www.w3.org/2000/svg','rect');
            brush.el.setAttribute('class','uc-brush');
            brush.el.setAttribute('y',0);
            const g = chartState.geom;
            brush.el.setAttribute('height', g ? g.PH : 200);
            svg.appendChild(brush.el);
        }
        const lo = Math.min(brush.a, brush.b);
        const hi = Math.max(brush.a, brush.b);
        const s = chartState.geom.slot;
        brush.el.setAttribute('x', lo * s);
        brush.el.setAttribute('width', (hi - lo + 1) * s);
    });

    svg.addEventListener('pointerup', () => {
        if (!brush) return;
        const lo = Math.min(brush.a, brush.b);
        const hi = Math.max(brush.a, brush.b);
        cancel();
        if (hi - lo + 1 < 2) return;
        suppressClick = true;
        const b = chartState.data.buckets;
        chartState.zoomStack.push(chartState.window);
        chartState.window = { from: b[lo].start, to: b[hi].end };
        chartState.active = null;
        section.querySelector('.uc-tip').style.display = 'none';
        fetchChart();
    });

    svg.addEventListener('pointercancel', cancel);

    svg.addEventListener('click', (e) => {
        if (suppressClick) {
            suppressClick = false;
            e.stopPropagation();
        }
    }, true);

    const keydownHandler = (e) => {
        if (e.key === 'Escape' && brush) {
            e.preventDefault();
            cancel();
        }
    };
    document.addEventListener('keydown', keydownHandler);
    section._keydownHandler = keydownHandler;

    // Cleanup on removal
    section._cleanup = () => {
        if (section._resizeObserver) section._resizeObserver.disconnect();
        if (section._keydownHandler) document.removeEventListener('keydown', section._keydownHandler);
    };

    return section;
}

// ====== USAGE REFRESH (updated) ======

async function refreshUsage() {
    try {
        const result = await host.serviceRequest({
            method: 'GET',
            path: '/usage'
        });

        const entries = typeof result.body === 'string' ? JSON.parse(result.body) : result.body;

        const successful = entries.filter(entry =>
            !entry.error && typeof entry.used === 'number' && typeof entry.limit === 'number' && typeof entry.pct === 'number'
        );

        const totalUsed = Number(successful.reduce((sum, entry) => sum + entry.used, 0).toFixed(2));
        const totalLimit = Number(successful.reduce((sum, entry) => sum + entry.limit, 0).toFixed(2));
        const totalPct = totalLimit > 0 ? Math.round((totalUsed / totalLimit) * 100) : 0;

        const { totalWorkdays, elapsedWorkdays } = computeWorkdayPace();
        const expectedByNow = totalWorkdays > 0 ? (totalLimit / totalWorkdays) * elapsedWorkdays : 0;
        const paceOk = totalUsed <= expectedByNow;

        renderAccounts(entries, totalUsed, totalLimit, totalPct, expectedByNow, paceOk, elapsedWorkdays, totalWorkdays);
        updateLastUpdated();

        const accountsEl = document.getElementById('accounts');
        let chartSection = document.querySelector('.uc');
        if (!chartSection) {
            chartSection = buildChartSection();
            if (accountsEl && accountsEl.parentElement === contentEl) {
                accountsEl.after(chartSection);
            } else {
                contentEl.appendChild(chartSection);
            }
        } else if (chartSection._cleanup) {
            chartSection._cleanup();
            chartSection = buildChartSection();
            const oldSection = document.querySelector('.uc');
            oldSection?.replaceWith(chartSection);
        }

        await fetchChart();
        host.setBadge(totalPct >= 80 ? totalPct : null);
    } catch (error) {
        renderError(`Failed to fetch usage: ${error.message}`);
    }
}

// ====== INITIALIZE ======

let initialized = false;

host.onReady((ctx) => {
    applyHostReady(ctx, document.documentElement);
    if (initialized) return;
    initialized = true;
    loadState();

    // Tab switching
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            switchTab(tab.dataset.view);
        });
    });

    // Create filter controls for requests view
    const filtersContainer = document.createElement('div');
    filtersContainer.className = 'filters';
    filtersContainer.id = 'filters-container';
    filtersContainer.innerHTML = `
        <div class="filter-group">
            <label class="filter-label" for="filter-account">Account</label>
            <input type="text" id="filter-account" class="filter-input" placeholder="email contains...">
        </div>
        <div class="filter-group">
            <label class="filter-label" for="filter-status">Status</label>
            <select id="filter-status" class="filter-select">
                <option value="">All</option>
                <option value="ok">OK</option>
                <option value="error">Error</option>
            </select>
        </div>
        <div class="filter-group">
            <label class="filter-label" for="filter-from">From</label>
            <input type="date" id="filter-from" class="filter-input">
        </div>
        <div class="filter-group">
            <label class="filter-label" for="filter-to">To</label>
            <input type="date" id="filter-to" class="filter-input">
        </div>
        <div class="filter-group" style="grid-column: 1 / -1;">
            <label class="filter-label" for="filter-q">Search</label>
            <input type="text" id="filter-q" class="filter-input" placeholder="model, conversation, url...">
        </div>
    `;

    // Add filter event listeners
    ['filter-account', 'filter-status', 'filter-from', 'filter-to', 'filter-q'].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener(id === 'filter-status' ? 'change' : 'input', debouncedApplyFilters);
        }
    });

    // Hide filters in usage view
    function showFilters(show) {
        filtersContainer.style.display = show ? 'grid' : 'none';
    }

    // Initial view - show filters only in requests view
    showFilters(false);

    // Inject filters into DOM after header
    const header = document.querySelector('.header');
    if (header) {
        header.after(filtersContainer);
    }

    // Initial load
    switchTab('usage');

    pollInterval = setInterval(refreshUsage, 5 * 60 * 1000);

    // Refresh button for both views
    refreshBtn.addEventListener('click', () => {
        if (currentView === 'usage') {
            renderLoading();
            refreshUsage();
        } else {
            applyFilters();
        }
    });
});
