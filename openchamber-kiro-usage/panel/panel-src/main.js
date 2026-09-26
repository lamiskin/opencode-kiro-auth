import { connectHost } from "@openchamber/sdk";
import { applyHostReady } from "@openchamber/sdk/ui";

const host = connectHost();
const contentEl = document.getElementById('content');
const refreshBtn = document.getElementById('refresh');

let pollInterval;

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

async function refresh() {
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

let initialized = false;

host.onReady((ctx) => {
    applyHostReady(ctx, document.documentElement);
    if (initialized) return;
    initialized = true;

    renderLoading();
    refresh();

    pollInterval = setInterval(refresh, 5 * 60 * 1000);
});

refreshBtn.addEventListener('click', () => {
    renderLoading();
    refresh();
});