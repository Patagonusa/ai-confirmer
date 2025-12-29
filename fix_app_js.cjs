const fs = require('fs');
const path = './public/app.js';
let content = fs.readFileSync(path, 'utf8');

// Replace the renderCallHistory function
content = content.replace(
  /function renderCallHistory\(\) \{[\s\S]*?^\}/m,
  `function renderCallHistory() {
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
}`
);

// Also update currentName display to use fullName
content = content.replace(
  "document.getElementById('currentName').textContent = (data.currentLead.firstName||'') + ' ' + (data.currentLead.lastName||'');",
  "document.getElementById('currentName').textContent = data.currentLead.fullName || ((data.currentLead.firstName||'') + ' ' + (data.currentLead.lastName||'')).trim();"
);

fs.writeFileSync(path, content);
console.log('Updated app.js');
