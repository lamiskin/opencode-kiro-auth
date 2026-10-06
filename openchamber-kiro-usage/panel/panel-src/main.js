import { connectHost } from "@openchamber/sdk";
import { applyHostReady } from "@openchamber/sdk/ui";

const host = connectHost();
const contentEl = document.getElementById('content');
const refreshBtn = document.getElementById('refresh');
const tabs = document.querySelectorAll('.tab');

let pollInterval;
let currentView = 'usage';
let debounceTimer;

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
    contentEl.innerHTML = `<div class="error-message">${message}</div>`;
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

// ====== USAGE REFRESH (existing) ======

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
        
        // Compute monthly workday pace
        const { totalWorkdays, elapsedWorkdays } = computeWorkdayPace();
        const expectedByNow = totalWorkdays > 0 ? (totalLimit / totalWorkdays) * elapsedWorkdays : 0;
        const paceOk = totalUsed <= expectedByNow;
        
        renderAccounts(entries, totalUsed, totalLimit, totalPct, expectedByNow, paceOk, elapsedWorkdays, totalWorkdays);
        updateLastUpdated();
        
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
