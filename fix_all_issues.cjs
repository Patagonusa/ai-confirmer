const fs = require('fs');

// ==================== FIX INDEX.JS ====================
const indexPath = './index.js';
let content = fs.readFileSync(indexPath, 'utf8');

// FIX 1: Correct the leads mapping - field 6 is full name, field 7 is notes
const oldLeadsMapping = `const leads = data.data.map(row => ({
      recordId: row['3']?.value,
      firstName: row['6']?.value || '',
      lastName: row['7']?.value || '',
      phone: row['109']?.value || '',
      altPhone: row['108']?.value || '',
      status: row['9']?.value || '',
      appointmentDate: row['11']?.value,
      appointmentTime: row['126']?.value,
      product: row['15']?.value || '',
      address: row['94']?.value || '',
      street: row['95']?.value || '',
      city: row['97']?.value || '',
      state: row['98']?.value || '',
      zip: row['99']?.value || ''
    }));`;

const newLeadsMapping = `// Parse name into first/last - field 6 contains full name like "John Smith / Jane Smith"
    const leads = data.data.map(row => {
      const fullName = row['6']?.value || '';
      // Split on / or & to get primary contact, then split into first/last
      const primaryName = fullName.split(/[\/&]/)[0].trim();
      const nameParts = primaryName.split(/\\s+/);
      const firstName = nameParts[0] || '';
      const lastName = nameParts.slice(1).join(' ') || '';

      return {
        recordId: row['3']?.value,
        fullName: primaryName,
        firstName,
        lastName,
        phone: row['109']?.value || '',
        altPhone: row['108']?.value || '',
        status: row['9']?.value || '',
        appointmentDate: row['11']?.value,
        appointmentTime: row['126']?.value,
        product: row['15']?.value || '',
        address: row['94']?.value || '',
        street: row['95']?.value || '',
        city: row['97']?.value || '',
        state: row['98']?.value || '',
        zip: row['99']?.value || ''
      };
    });`;

if (content.includes(oldLeadsMapping)) {
  content = content.replace(oldLeadsMapping, newLeadsMapping);
  console.log('Fixed leads name mapping in /api/leads');
}

// FIX 2: Also fix the campaign start leads mapping
const oldCampaignMapping = `const leads = data.data.map(row => ({
      recordId: row['3']?.value,
      firstName: row['6']?.value || '',
      lastName: row['7']?.value || '',
      phone: row['109']?.value || '',
      altPhone: row['108']?.value || '',
      status: row['9']?.value || '',
      appointmentDate: row['11']?.value,
      appointmentTime: row['126']?.value,
      product: row['15']?.value || '',
      street: row['95']?.value || '',
      city: row['97']?.value || '',
      state: row['98']?.value || '',
      zip: row['99']?.value || ''
    }));`;

const newCampaignMapping = `// Parse name into first/last
    const leads = data.data.map(row => {
      const fullName = row['6']?.value || '';
      const primaryName = fullName.split(/[\/&]/)[0].trim();
      const nameParts = primaryName.split(/\\s+/);
      const firstName = nameParts[0] || '';
      const lastName = nameParts.slice(1).join(' ') || '';

      return {
        recordId: row['3']?.value,
        fullName: primaryName,
        firstName,
        lastName,
        phone: row['109']?.value || '',
        altPhone: row['108']?.value || '',
        status: row['9']?.value || '',
        appointmentDate: row['11']?.value,
        appointmentTime: row['126']?.value,
        product: row['15']?.value || '',
        street: row['95']?.value || '',
        city: row['97']?.value || '',
        state: row['98']?.value || '',
        zip: row['99']?.value || ''
      };
    });`;

if (content.includes(oldCampaignMapping)) {
  content = content.replace(oldCampaignMapping, newCampaignMapping);
  console.log('Fixed leads name mapping in /api/campaign/start');
}

// FIX 3: Fix call history name - use fullName instead of combining first+last
const oldCallHistoryName = `name: \`\${lead.firstName} \${lead.lastName}\`,`;
const newCallHistoryName = `name: lead.fullName || \`\${lead.firstName} \${lead.lastName}\`.trim(),
      appointmentDate: lead.appointmentDate,
      appointmentTime: lead.appointmentTime,
      product: lead.product,`;

content = content.replace(new RegExp(oldCallHistoryName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), newCallHistoryName);
console.log('Fixed call history name field');

// FIX 4: Fix status callback logic - remove auto-confirm based on duration
const oldStatusLogic = `if (CallStatus === 'completed' && CallDuration > 30) {
      // Likely a successful call
      activeCampaign.confirmed++;
    } else if (CallStatus === 'no-answer' || CallStatus === 'busy') {
      activeCampaign.noAnswer++;
    }`;

const newStatusLogic = `// Don't auto-confirm - wait for actual conversation outcome
    // Status will be updated by AI agent via tool call
    if (CallStatus === 'no-answer' || CallStatus === 'busy' || CallStatus === 'failed') {
      activeCampaign.noAnswer++;
      // Add to retry queue if configured
      if (call && call.recordId) {
        addToRetryQueue(call.recordId, CallStatus);
      }
    }`;

if (content.includes(oldStatusLogic)) {
  content = content.replace(oldStatusLogic, newStatusLogic);
  console.log('Fixed status callback logic');
}

// FIX 5: Add retry queue for no-answer calls
const beforeHealthFunctions = `// Helper functions for formatting`;
const addRetryQueue = `// Retry queue for failed/no-answer calls
const retryQueue = [];
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 300000; // 5 minutes

function addToRetryQueue(recordId, reason) {
  const existing = retryQueue.find(r => r.recordId === recordId);
  if (existing) {
    existing.attempts++;
    if (existing.attempts >= MAX_RETRIES) {
      console.log(\`Max retries reached for \${recordId}\`);
      return;
    }
  } else {
    retryQueue.push({ recordId, reason, attempts: 1, scheduledTime: Date.now() + RETRY_DELAY_MS });
  }
  console.log(\`Added \${recordId} to retry queue (reason: \${reason})\`);
}

// Helper functions for formatting`;

if (content.includes(beforeHealthFunctions) && !content.includes('retryQueue')) {
  content = content.replace(beforeHealthFunctions, addRetryQueue);
  console.log('Added retry queue logic');
}

// FIX 6: Add logging for dynamic variables
const oldElevenLabsLog = `console.log('Sending ElevenLabs init with customer:', currentLead?.firstName);`;
const newElevenLabsLog = `console.log('Sending ElevenLabs init with customer:', currentLead?.firstName, currentLead?.lastName);
        console.log('Dynamic variables:', JSON.stringify(config.conversation_config_override?.agent?.prompt?.dynamic_variables || {}, null, 2));`;

if (content.includes(oldElevenLabsLog)) {
  content = content.replace(oldElevenLabsLog, newElevenLabsLog);
  console.log('Added dynamic variables logging');
}

fs.writeFileSync(indexPath, content);

// ==================== FIX APP.JS (FRONTEND) ====================
const appPath = './public/app.js';
let appContent = fs.readFileSync(appPath, 'utf8');

// FIX 7: Improve renderLeadsTable to show parsed names
const oldLeadsTableRender = `tbody.innerHTML = filtered.map(l => '<tr><td>'+(l.appointmentTime||'-')+'</td><td>'+(l.appointmentDate||'-')+'</td><td>'+(l.firstName||'-')+'</td><td>'+(l.lastName||'-')+'</td><td>'+(l.phone||l.altPhone||'-')+'</td><td>'+(l.product||'-')+'</td><td><span class=\"status-badge\">'+(l.status||'-')+'</span></td></tr>').join('');`;

const newLeadsTableRender = `tbody.innerHTML = filtered.map(l => '<tr><td>'+(l.appointmentTime||'-')+'</td><td>'+(l.appointmentDate||'-')+'</td><td>'+(l.fullName || ((l.firstName||'')+ ' ' + (l.lastName||'')).trim() || '-')+'</td><td>'+(l.phone||l.altPhone||'-')+'</td><td>'+(l.product||'-')+'</td><td><span class=\"status-badge\">'+(l.status||'-')+'</span></td></tr>').join('');`;

if (appContent.includes(oldLeadsTableRender)) {
  appContent = appContent.replace(oldLeadsTableRender, newLeadsTableRender);
  console.log('Fixed leads table to combine name column');
}

// FIX 8: Improve renderCallHistory to show better formatted data
const oldCallHistoryRender = `tbody.innerHTML = callHistoryData.map((c, idx) => {
        const rec = c.recordingUrl ? '<a href=\"'+c.recordingUrl+'\" target=\"_blank\" class=\"recording-link\">Play</a>' : '-';
        const trans = c.transcript ? '<button class=\"transcript-btn\" onclick=\"showTranscript('+idx+')\">View</button>' : '-';
        return '<tr><td>'+new Date(c.timestamp).toLocaleString()+'</td><td>'+c.name+'</td><td>'+c.phone+'</td><td><span class=\"status-badge '+c.status+'\">'+c.status+'</span></td><td>'+(c.duration?c.duration+'s':'-')+'</td><td>'+rec+'</td><td>'+trans+'</td></tr>';
    }).join('');`;

const newCallHistoryRender = `tbody.innerHTML = callHistoryData.map((c, idx) => {
        const rec = c.recordingUrl ? '<a href=\"'+c.recordingUrl+'\" target=\"_blank\" class=\"recording-link\">Play</a>' : '-';
        const trans = c.transcript && c.transcript.length > 0 ? '<button class=\"transcript-btn\" onclick=\"showTranscript('+idx+')\">View</button>' : '-';
        const appDate = c.appointmentDate ? new Date(c.appointmentDate).toLocaleDateString() : '-';
        const appTime = c.appointmentTime ? c.appointmentTime.substring(0,5) : '-';
        const statusClass = c.status === 'completed' ? 'completed' : (c.status === 'no-answer' || c.status === 'busy' || c.status === 'failed' ? 'failed' : '');
        return '<tr>' +
          '<td>'+(c.name||'-')+'</td>' +
          '<td>'+appDate+' '+appTime+'</td>' +
          '<td>'+(c.product||'-')+'</td>' +
          '<td>'+(c.phone||'-')+'</td>' +
          '<td><span class=\"status-badge '+statusClass+'\">'+c.status+'</span></td>' +
          '<td>'+(c.duration?c.duration+'s':'-')+'</td>' +
          '<td>'+rec+'</td>' +
          '<td>'+trans+'</td>' +
        '</tr>';
    }).join('');`;

if (appContent.includes(oldCallHistoryRender)) {
  appContent = appContent.replace(oldCallHistoryRender, newCallHistoryRender);
  console.log('Improved call history table format');
}

fs.writeFileSync(appPath, appContent);

// ==================== FIX INDEX.HTML ====================
const htmlPath = './public/index.html';
let htmlContent = fs.readFileSync(htmlPath, 'utf8');

// FIX 9: Update leads table headers (remove separate first/last name columns)
const oldLeadsHeaders = `<thead><tr><th>Time</th><th>Date</th><th>First Name</th><th>Last Name</th><th>Phone</th><th>Product</th><th>Status</th></tr></thead>`;
const newLeadsHeaders = `<thead><tr><th>Time</th><th>Date</th><th>Name</th><th>Phone</th><th>Product</th><th>Status</th></tr></thead>`;

if (htmlContent.includes(oldLeadsHeaders)) {
  htmlContent = htmlContent.replace(oldLeadsHeaders, newLeadsHeaders);
  console.log('Updated leads table headers');
}

// FIX 10: Update call history headers
const oldHistoryHeaders = `<thead><tr><th>Date/Time</th><th>Customer</th><th>Phone</th><th>Status</th><th>Duration</th><th>Recording</th><th>Transcript</th></tr></thead>`;
const newHistoryHeaders = `<thead><tr><th>Name</th><th>Appt Date/Time</th><th>Product</th><th>Phone</th><th>Status</th><th>Duration</th><th>Recording</th><th>Transcript</th></tr></thead>`;

if (htmlContent.includes(oldHistoryHeaders)) {
  htmlContent = htmlContent.replace(oldHistoryHeaders, newHistoryHeaders);
  console.log('Updated call history headers');
}

// Also fix the colspan for empty state
htmlContent = htmlContent.replace('colspan=\"7\" style=\"text-align:center; color:#a1a1aa; padding:40px;\">No call history',
                                  'colspan=\"8\" style=\"text-align:center; color:#a1a1aa; padding:40px;\">No call history');
htmlContent = htmlContent.replace('colspan=\"7\" style=\"text-align:center;padding:40px;color:#a1a1aa\">No leads found',
                                  'colspan=\"6\" style=\"text-align:center;padding:40px;color:#a1a1aa\">No leads found');

fs.writeFileSync(htmlPath, htmlContent);

console.log('\\n=== All fixes applied! ===');
console.log('1. Fixed name parsing from Quickbase');
console.log('2. Fixed call history format');
console.log('3. Removed auto-confirm logic');
console.log('4. Added retry queue for no-answer');
console.log('5. Added dynamic variables logging');
console.log('6. Updated table headers');
