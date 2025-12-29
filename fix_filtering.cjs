const fs = require('fs');

// Fix backend time comparison to handle format differences
const indexPath = './index.js';
let content = fs.readFileSync(indexPath, 'utf8');

// Fix time filtering - normalize times for comparison
const oldTimeFilter = `// Apply time filter if provided
    const { timeFrom, timeTo } = req.query;
    let filteredLeads = leads;
    if (timeFrom || timeTo) {
      filteredLeads = leads.filter(l => {
        if (!l.appointmentTime) return false;
        const time = l.appointmentTime;
        if (timeFrom && time < timeFrom) return false;
        if (timeTo && time > timeTo) return false;
        return true;
      });
    }`;

const newTimeFilter = `// Apply time filter if provided
    const { timeFrom, timeTo } = req.query;
    let filteredLeads = leads;
    if (timeFrom || timeTo) {
      // Normalize time format for comparison (HH:MM -> HH:MM:SS)
      const normalizeTime = (t) => {
        if (!t) return null;
        // Remove seconds if present, then add :00
        const parts = t.split(':');
        return parts[0].padStart(2, '0') + ':' + (parts[1] || '00').padStart(2, '0') + ':00';
      };
      const fromNorm = normalizeTime(timeFrom);
      const toNorm = normalizeTime(timeTo);

      filteredLeads = leads.filter(l => {
        if (!l.appointmentTime) return false;
        const time = normalizeTime(l.appointmentTime);
        if (fromNorm && time < fromNorm) return false;
        if (toNorm && time > toNorm) return false;
        return true;
      });
    }`;

if (content.includes(oldTimeFilter)) {
  content = content.replace(oldTimeFilter, newTimeFilter);
  console.log('Fixed time filtering with normalization');
}

fs.writeFileSync(indexPath, content);

// Now fix the frontend to show clearer information
const appPath = './public/app.js';
let appContent = fs.readFileSync(appPath, 'utf8');

// Improve the previewLeads function to show filter info
const oldPreviewSuccess = `allLeads = data.leads || [];
        document.getElementById('leadsCount').textContent = data.total + ' leads';`;

const newPreviewSuccess = `allLeads = data.leads || [];
        let countText = data.total + ' leads';
        if (timeFrom || timeTo) {
          countText += ' (filtered: ' + (timeFrom || 'any') + ' - ' + (timeTo || 'any') + ')';
        }
        document.getElementById('leadsCount').textContent = countText;`;

if (appContent.includes(oldPreviewSuccess)) {
  appContent = appContent.replace(oldPreviewSuccess, newPreviewSuccess);
  console.log('Improved leads count display');
}

fs.writeFileSync(appPath, appContent);

console.log('Filtering fixes complete!');
