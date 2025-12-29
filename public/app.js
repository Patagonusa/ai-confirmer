const API_BASE = '';
let statusInterval = null, callTimerInterval = null, callStartTime = null;
let allLeads = [], callHistoryData = [];
document.getElementById('appointmentDate').valueAsDate = new Date();

function showPage(btn, page) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.getElementById('page-' + page).classList.add('active');
    btn.classList.add('active');
    if (page === 'leads') renderLeadsTable();
    if (page === 'history') loadCallHistory();
}

async function loadDispositions() {
    try {
        const response = await fetch(API_BASE + '/api/statuses');
        const statuses = await response.json();
        const grid = document.getElementById('dispositionGrid');
        grid.innerHTML = '';
        const preSelected = ['Pre Confirmed', 'No Confirmation - Set', 'LL/MO', 'Call Back to Reschedule'];
        statuses.forEach(status => {
            const item = document.createElement('label');
            item.className = 'disposition-item';
            item.innerHTML = '<input type="checkbox" value="' + status.name + '"' + (preSelected.includes(status.name) ? ' checked' : '') + '><span>' + status.name + '</span>';
            grid.appendChild(item);
        });
    } catch (e) { console.error(e); }
}

async function previewLeads() {
    const date = document.getElementById('appointmentDate').value;
    if (!date) { alert('Please select a date'); return; }
    const dispositions = Array.from(document.querySelectorAll('#dispositionGrid input:checked')).map(cb => cb.value);
    try {
        const params = new URLSearchParams({ date });
        if (dispositions.length > 0) params.append('dispositions', dispositions.join(','));
        const response = await fetch(API_BASE + '/api/leads?' + params);
        const data = await response.json();
        allLeads = data.leads || [];
        document.getElementById('leadsCount').textContent = data.total + ' leads';
        renderLeadsTable();
        document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
        document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
        document.getElementById('page-leads').classList.add('active');
        document.querySelectorAll('.nav-btn')[1].classList.add('active');
    } catch (e) { console.error(e); }
}

function renderLeadsTable() {
    const tbody = document.getElementById('leadsTable');
    if (!allLeads.length) { tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:40px;color:#a1a1aa">No leads found</td></tr>'; return; }
    tbody.innerHTML = allLeads.map(l => '<tr><td>'+(l.appointmentTime||'-')+'</td><td>'+(l.appointmentDate||'-')+'</td><td>'+(l.firstName||'')+' '+(l.lastName||'')+'</td><td>'+(l.phone||l.altPhone||'-')+'</td><td>'+(l.product||'-')+'</td><td><span class="status-badge">'+(l.status||'-')+'</span></td></tr>').join('');
}

async function loadCallHistory() {
    try {
        const response = await fetch(API_BASE + '/api/campaign/status');
        const data = await response.json();
        callHistoryData = data.recentCalls || [];
        renderCallHistory();
    } catch (e) { console.error(e); }
}

function renderCallHistory() {
    const tbody = document.getElementById('callHistory');
    document.getElementById('historyCount').textContent = callHistoryData.length + ' calls';
    if (!callHistoryData.length) { tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:40px;color:#a1a1aa">No call history</td></tr>'; return; }
    tbody.innerHTML = callHistoryData.map(c => {
        const rec = c.recordingUrl ? '<a href="'+c.recordingUrl+'" target="_blank" class="recording-link">Play</a>' : '-';
        return '<tr><td>'+new Date(c.timestamp).toLocaleString()+'</td><td>'+c.name+'</td><td>'+c.phone+'</td><td><span class="status-badge '+c.status+'">'+c.status+'</span></td><td>'+(c.duration?c.duration+'s':'-')+'</td><td>'+rec+'</td></tr>';
    }).join('');
}

async function startCampaign() {
    const date = document.getElementById('appointmentDate').value;
    if (!date) { alert('Please select a date'); return; }
    const dispositions = Array.from(document.querySelectorAll('#dispositionGrid input:checked')).map(cb => cb.value);
    if (!dispositions.length) { alert('Please select dispositions'); return; }
    try {
        const response = await fetch(API_BASE + '/api/campaign/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date, dispositions }) });
        const data = await response.json();
        if (data.success) {
            document.getElementById('startBtn').disabled = true;
            document.getElementById('stopBtn').disabled = false;
            document.getElementById('statusDot').classList.add('running');
            document.getElementById('statusText').textContent = 'Running';
            startStatusPolling();
        }
    } catch (e) { console.error(e); }
}

async function stopCampaign() {
    await fetch(API_BASE + '/api/campaign/stop', { method: 'POST' });
    document.getElementById('startBtn').disabled = false;
    document.getElementById('stopBtn').disabled = true;
    document.getElementById('statusDot').classList.remove('running');
    document.getElementById('statusText').textContent = 'Stopped';
    document.getElementById('currentCall').classList.remove('active');
    stopStatusPolling();
}

function startStatusPolling() { updateStatus(); statusInterval = setInterval(updateStatus, 2000); }
function stopStatusPolling() { if (statusInterval) clearInterval(statusInterval); if (callTimerInterval) clearInterval(callTimerInterval); }

async function updateStatus() {
    try {
        const response = await fetch(API_BASE + '/api/campaign/status');
        const data = await response.json();
        document.getElementById('statTotal').textContent = data.stats.totalLeads;
        document.getElementById('statConfirmed').textContent = data.stats.confirmed;
        document.getElementById('statCalls').textContent = data.stats.callsMade;
        document.getElementById('statNoAnswer').textContent = data.stats.noAnswer;
        document.getElementById('statRemaining').textContent = data.stats.remaining;
        document.getElementById('elapsedTime').textContent = data.stats.elapsedMinutes + ' min';
        const progress = data.stats.totalLeads > 0 ? Math.round((data.stats.callsMade / data.stats.totalLeads) * 100) : 0;
        document.getElementById('progressPercent').textContent = progress + '%';
        document.getElementById('progressFill').style.width = progress + '%';
        if (data.currentLead && data.running) {
            document.getElementById('currentCall').classList.add('active');
            document.getElementById('currentName').textContent = (data.currentLead.firstName||'') + ' ' + (data.currentLead.lastName||'');
            document.getElementById('currentPhone').textContent = data.currentLead.phone || data.currentLead.altPhone || '-';
            document.getElementById('currentTime').textContent = data.currentLead.appointmentTime || '-';
            document.getElementById('currentProduct').textContent = data.currentLead.product || '-';
            if (!callTimerInterval) { callStartTime = Date.now(); callTimerInterval = setInterval(updateCallTimer, 1000); }
        } else {
            document.getElementById('currentCall').classList.remove('active');
            if (callTimerInterval) { clearInterval(callTimerInterval); callTimerInterval = null; }
        }
        updateRecentCalls(data.recentCalls);
        if (!data.running && statusInterval) {
            document.getElementById('startBtn').disabled = false;
            document.getElementById('stopBtn').disabled = true;
            document.getElementById('statusDot').classList.remove('running');
            document.getElementById('statusText').textContent = 'Completed';
            stopStatusPolling();
        }
    } catch (e) { console.error(e); }
}

function updateCallTimer() {
    if (callStartTime) {
        const e = Math.floor((Date.now() - callStartTime) / 1000);
        document.getElementById('callTimer').textContent = String(Math.floor(e/60)).padStart(2,'0') + ':' + String(e%60).padStart(2,'0');
    }
}

function updateRecentCalls(calls) {
    const tbody = document.getElementById('recentCalls');
    document.getElementById('recentCount').textContent = (calls ? calls.length : 0) + ' calls';
    if (!calls || !calls.length) { tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:30px;color:#a1a1aa">No calls yet</td></tr>'; return; }
    tbody.innerHTML = calls.slice(0, 5).map(c => '<tr><td>'+new Date(c.timestamp).toLocaleTimeString()+'</td><td>'+c.name+'</td><td><span class="status-badge '+c.status+'">'+c.status+'</span></td><td>'+(c.duration?c.duration+'s':'-')+'</td></tr>').join('');
}

loadDispositions();
updateStatus();
