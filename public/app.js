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
    const timeFrom = document.getElementById('timeFrom')?.value || '';
    const timeTo = document.getElementById('timeTo')?.value || '';
    try {
        const params = new URLSearchParams({ date });
        if (dispositions.length > 0) params.append('dispositions', dispositions.join(','));
        if (timeFrom) params.append('timeFrom', timeFrom);
        if (timeTo) params.append('timeTo', timeTo);
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
    const search = (document.getElementById('leadsSearch')?.value || '').toLowerCase();
    let filtered = allLeads;
    if (search) {
        filtered = allLeads.filter(l =>
            (l.firstName||'').toLowerCase().includes(search) ||
            (l.lastName||'').toLowerCase().includes(search) ||
            (l.phone||'').includes(search) ||
            (l.altPhone||'').includes(search)
        );
    }
    if (!filtered.length) { tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:40px;color:#a1a1aa">No leads found</td></tr>'; return; }
    tbody.innerHTML = filtered.map(l => '<tr><td>'+(l.appointmentTime||'-')+'</td><td>'+(l.appointmentDate||'-')+'</td><td>'+(l.fullName || ((l.firstName||'')+ ' ' + (l.lastName||'')).trim() || '-')+'</td><td>'+(l.phone||l.altPhone||'-')+'</td><td>'+(l.product||'-')+'</td><td><span class="status-badge">'+(l.status||'-')+'</span></td></tr>').join('');
}

function filterLeadsTable() { renderLeadsTable(); }

function selectAllDispositions() {
    document.querySelectorAll('#dispositionGrid input[type=checkbox]').forEach(cb => cb.checked = true);
}

function clearAllDispositions() {
    document.querySelectorAll('#dispositionGrid input[type=checkbox]').forEach(cb => cb.checked = false);
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
    if (!callHistoryData.length) { tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:40px;color:#a1a1aa">No call history</td></tr>'; return; }
    tbody.innerHTML = callHistoryData.map((c, idx) => {
        const rec = c.recordingUrl ? '<a href="'+c.recordingUrl+'" target="_blank" class="recording-link">Play</a>' : '-';
        const trans = c.transcript && c.transcript.length > 0 ? '<button class="transcript-btn" onclick="showTranscript('+idx+')">View</button>' : '-';
        const appDate = c.appointmentDate ? new Date(c.appointmentDate).toLocaleDateString() : '-';
        const appTime = c.appointmentTime ? c.appointmentTime.substring(0,5) : '-';
        const statusClass = c.status === 'completed' ? 'completed' : (c.status === 'no-answer' || c.status === 'busy' || c.status === 'failed' ? 'failed' : '');
        return '<tr><td>'+(c.name||'-')+'</td><td>'+appDate+' '+appTime+'</td><td>'+(c.product||'-')+'</td><td>'+(c.phone||'-')+'</td><td><span class="status-badge '+statusClass+'">'+c.status+'</span></td><td>'+(c.duration?c.duration+'s':'-')+'</td><td>'+rec+'</td><td>'+trans+'</td></tr>';
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
            document.getElementById('currentName').textContent = data.currentLead.fullName || ((data.currentLead.firstName||'') + ' ' + (data.currentLead.lastName||'')).trim();
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

// Transcript Modal
function showTranscript(idx) {
    const call = callHistoryData[idx];
    if (!call || !call.transcript) return;
    const modal = document.getElementById('transcriptModal');
    const content = document.getElementById('transcriptContent');
    let html = '';
    if (Array.isArray(call.transcript)) {
        html = call.transcript.map(t => '<div class="transcript-line"><span class="transcript-speaker">' + (t.speaker || 'Unknown') + ':</span><span class="transcript-text">' + (t.text || '') + '</span></div>').join('');
    } else if (typeof call.transcript === 'string') {
        html = '<div class="transcript-text">' + call.transcript.replace(/\\n/g, '<br>') + '</div>';
    }
    content.innerHTML = html || 'No transcript available';
    modal.classList.add('active');
}

function closeTranscriptModal() {
    document.getElementById('transcriptModal').classList.remove('active');
}

// Texting Interface
let currentThread = null;
let threads = [];

function newTextMessage() {
    document.getElementById('newMessageModal').classList.add('active');
}

function closeNewMessageModal() {
    document.getElementById('newMessageModal').classList.remove('active');
    document.getElementById('newMessagePhone').value = '';
    document.getElementById('newMessageText').value = '';
}

async function sendNewMessage() {
    const phone = document.getElementById('newMessagePhone').value.trim();
    const text = document.getElementById('newMessageText').value.trim();
    if (!phone || !text) { alert('Please enter phone and message'); return; }
    try {
        await fetch(API_BASE + '/api/sms/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ to: phone, message: text })
        });
        closeNewMessageModal();
        loadThreads();
    } catch (e) { console.error(e); alert('Failed to send message'); }
}

async function loadThreads() {
    try {
        const response = await fetch(API_BASE + '/api/sms/threads');
        threads = await response.json();
        renderThreads();
    } catch (e) { console.error(e); }
}

function renderThreads() {
    const list = document.getElementById('threadsList');
    if (!threads.length) {
        list.innerHTML = '<div style="text-align:center;color:#a1a1aa;padding:20px;">No conversations yet</div>';
        return;
    }
    list.innerHTML = threads.map((t, i) => '<div class="thread-item' + (currentThread === i ? ' active' : '') + '" onclick="selectThread(' + i + ')"><div class="thread-name">' + (t.name || t.phone) + '</div><div class="thread-preview">' + (t.lastMessage || '') + '</div><div class="thread-time">' + (t.lastTime ? new Date(t.lastTime).toLocaleString() : '') + '</div></div>').join('');
}

function selectThread(idx) {
    currentThread = idx;
    renderThreads();
    loadMessages(idx);
}

async function loadMessages(idx) {
    const thread = threads[idx];
    if (!thread) return;
    document.getElementById('chatTitle').textContent = thread.name || 'Conversation';
    document.getElementById('chatPhone').textContent = thread.phone || '';
    document.getElementById('chatInputArea').style.display = 'flex';
    try {
        const response = await fetch(API_BASE + '/api/sms/messages?phone=' + encodeURIComponent(thread.phone));
        const messages = await response.json();
        renderMessages(messages);
    } catch (e) { console.error(e); }
}

function renderMessages(messages) {
    const container = document.getElementById('chatMessages');
    if (!messages.length) {
        container.innerHTML = '<div style="text-align:center;color:#a1a1aa;padding:40px;">No messages</div>';
        return;
    }
    container.innerHTML = messages.map(m => '<div class="message ' + (m.direction === 'outgoing' ? 'outgoing' : 'incoming') + '"><div>' + m.text + '</div><div class="message-time">' + new Date(m.timestamp).toLocaleTimeString() + '</div></div>').join('');
    container.scrollTop = container.scrollHeight;
}

async function sendTextMessage() {
    const input = document.getElementById('messageInput');
    const text = input.value.trim();
    if (!text || currentThread === null) return;
    const thread = threads[currentThread];
    try {
        await fetch(API_BASE + '/api/sms/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ to: thread.phone, message: text })
        });
        input.value = '';
        loadMessages(currentThread);
    } catch (e) { console.error(e); }
}

loadDispositions();
updateStatus();
