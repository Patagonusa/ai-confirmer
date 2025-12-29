const fs = require('fs');
let content = fs.readFileSync('index.js', 'utf8');

// Check if SMS endpoints already exist
if (content.includes('/api/sms/send')) {
  console.log('SMS endpoints already exist');
  process.exit(0);
}

// Add SMS endpoints before Health check
const smsCode = `
// SMS/Texting endpoints
const smsHistory = []; // In-memory SMS storage

// Send SMS
app.post('/api/sms/send', async (req, res) => {
  try {
    const { to, message } = req.body;
    if (!to || !message) {
      return res.status(400).json({ error: 'Phone and message required' });
    }

    let phoneNumber = to.replace(/\D/g, '');
    if (phoneNumber.length === 10) phoneNumber = '1' + phoneNumber;
    if (!phoneNumber.startsWith('+')) phoneNumber = '+' + phoneNumber;

    const sms = await twilioClient.messages.create({
      body: message,
      from: TWILIO_PHONE,
      to: phoneNumber
    });

    smsHistory.push({
      sid: sms.sid,
      phone: phoneNumber,
      text: message,
      direction: 'outgoing',
      timestamp: new Date()
    });

    res.json({ success: true, sid: sms.sid });
  } catch (error) {
    console.error('Error sending SMS:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get SMS threads
app.get('/api/sms/threads', (req, res) => {
  const threads = {};
  smsHistory.forEach(msg => {
    if (!threads[msg.phone]) {
      threads[msg.phone] = {
        phone: msg.phone,
        name: msg.name || msg.phone,
        lastMessage: msg.text,
        lastTime: msg.timestamp
      };
    } else if (new Date(msg.timestamp) > new Date(threads[msg.phone].lastTime)) {
      threads[msg.phone].lastMessage = msg.text;
      threads[msg.phone].lastTime = msg.timestamp;
    }
  });
  res.json(Object.values(threads));
});

// Get messages for a phone
app.get('/api/sms/messages', (req, res) => {
  const { phone } = req.query;
  if (!phone) return res.json([]);

  let cleanPhone = phone.replace(/\D/g, '');
  if (cleanPhone.length === 10) cleanPhone = '1' + cleanPhone;
  if (!cleanPhone.startsWith('+')) cleanPhone = '+' + cleanPhone;

  const messages = smsHistory.filter(m => m.phone === cleanPhone);
  res.json(messages);
});

// Twilio SMS webhook for incoming messages
app.post('/api/sms/incoming', (req, res) => {
  const { From, Body } = req.body;
  smsHistory.push({
    phone: From,
    text: Body,
    direction: 'incoming',
    timestamp: new Date()
  });
  res.type('text/xml').send('<Response></Response>');
});

`;

// Insert before Health check
content = content.replace(
  "// Health check\n// Test call endpoint",
  smsCode + "// Health check\n// Test call endpoint"
);

fs.writeFileSync('index.js', content);
console.log('SMS endpoints added successfully');
