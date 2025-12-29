const fs = require('fs');
const path = './index.js';
let content = fs.readFileSync(path, 'utf8');

// Fix the ElevenLabs init message - dynamic_variables should be at top level
const oldInit = `// Send initial configuration with customer data
        const config = {
          type: 'conversation_initiation_client_data',
          conversation_config_override: {
            agent: {
              prompt: {
                dynamic_variables: currentLead ? {
                  first_name: currentLead.firstName || 'Customer',
                  last_name: currentLead.lastName || '',
                  phone_number: currentLead.phone || currentLead.altPhone || '',
                  appointment_date: formatDate(currentLead.appointmentDate) || 'your scheduled date',
                  appointment_time: formatTime(currentLead.appointmentTime) || 'your scheduled time',
                  product: currentLead.product || 'home improvement service',
                  company_name: 'Expert Home Builders',
                  record_id: String(currentLead.recordId || ''),
                  new_date: '',
                  new_time: ''
                } : {}
              }
            }
          }
        };`;

const newInit = `// Send initial configuration with customer data
        // Dynamic variables go at top level, not nested under conversation_config_override
        const config = {
          type: 'conversation_initiation_client_data',
          dynamic_variables: currentLead ? {
            first_name: currentLead.firstName || 'Customer',
            last_name: currentLead.lastName || '',
            phone_number: currentLead.phone || currentLead.altPhone || '',
            appointment_date: formatDate(currentLead.appointmentDate) || 'your scheduled date',
            appointment_time: formatTime(currentLead.appointmentTime) || 'your scheduled time',
            product: currentLead.product || 'home improvement service',
            company_name: 'Expert Home Builders',
            record_id: String(currentLead.recordId || ''),
            new_date: '',
            new_time: ''
          } : {}
        };`;

if (content.includes(oldInit)) {
  content = content.replace(oldInit, newInit);
  console.log('Fixed dynamic_variables structure');
} else {
  console.log('Pattern not found - checking current content...');
  if (content.includes('conversation_config_override')) {
    console.log('Found conversation_config_override - needs manual fix');
  }
}

// Also fix the log line
const oldLog = `console.log('Sending ElevenLabs init with customer:', currentLead?.firstName, currentLead?.lastName);
        console.log('Dynamic variables:', JSON.stringify(config.conversation_config_override?.agent?.prompt?.dynamic_variables || {}, null, 2));`;

const newLog = `console.log('Sending ElevenLabs init with customer:', currentLead?.firstName, currentLead?.lastName);
        console.log('Dynamic variables:', JSON.stringify(config.dynamic_variables || {}, null, 2));`;

if (content.includes(oldLog)) {
  content = content.replace(oldLog, newLog);
  console.log('Fixed logging');
}

fs.writeFileSync(path, content);
console.log('Done!');
