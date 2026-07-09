const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const { PORT, logger } = require('./config');
const db = require('./db');

const app = express();
app.use(express.json());
app.use(cookieParser());

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Vardan@2026';

// Auth verification middleware
function requireAuth(req, res, next) {
  const bypassPaths = [
    '/login.html',
    '/login.css',
    '/login.js',
    '/api/login',
    '/favicon.ico'
  ];
  
  if (bypassPaths.includes(req.path)) {
    return next();
  }

  if (req.cookies && req.cookies.session_token === 'authorized') {
    return next();
  }

  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  res.redirect('/login.html');
}

// Apply authentication shield
app.use(requireAuth);

// Serve dashboard static files
app.use(express.static(path.join(__dirname, '../public')));

// Root route redirects to dashboard
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/dashboard.html'));
});

/**
 * API: Security Authentication Login
 */
app.post('/api/login', (req, res) => {
  try {
    const { password } = req.body;
    if (password === ADMIN_PASSWORD) {
      res.cookie('session_token', 'authorized', { maxAge: 30 * 24 * 60 * 60 * 1000, httpOnly: true });
      res.json({ success: true });
    } else {
      res.status(401).json({ success: false, error: 'Incorrect password.' });
    }
  } catch (error) {
    logger.error('Login API error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * API: Security Authentication Logout
 */
app.post('/api/logout', (req, res) => {
  res.clearCookie('session_token');
  res.json({ success: true });
});

// List of connected SSE clients
let sseClients = [];

/**
 * Server-Sent Events (SSE) endpoint for real-time dashboard updates.
 */
app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  // Send initial connection message
  res.write('data: {"type":"CONNECTED"}\n\n');

  sseClients.push(res);
  logger.debug(`Dashboard client connected to SSE. Total clients: ${sseClients.length}`);

  // Handle client disconnect
  req.on('close', () => {
    sseClients = sseClients.filter(client => client !== res);
    logger.debug(`Dashboard client disconnected from SSE. Total clients: ${sseClients.length}`);
  });
});

/**
 * Broadcasts an event to all connected SSE clients.
 */
function broadcast(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  sseClients.forEach(client => {
    try {
      client.write(payload);
    } catch (err) {
      logger.error('Error sending event to SSE client:', err);
    }
  });
}

// Bind SQLite updates to our SSE broadcast
db.dbEvents.on('change', (event) => {
  broadcast(event);
});

// SSE Heartbeat to keep connections alive
setInterval(() => {
  sseClients.forEach(client => {
    try {
      client.write(':keepalive\n\n');
    } catch (e) {
      // ignore, closed clients handled by req.on('close')
    }
  });
}, 25000);

/**
 * API: Get current WhatsApp QR code connection status
 */
app.get('/api/qr', (req, res) => {
  try {
    const bot = require('./bot');
    const qr = bot.getCurrentQr ? bot.getCurrentQr() : null;
    const isConnected = bot.getIsConnected ? bot.getIsConnected() : false;
    res.json({
      success: true,
      qr,
      isConnected
    });
  } catch (error) {
    logger.error('Error fetching QR status:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * API: Get card stats
 */
app.get('/api/stats', (req, res) => {
  try {
    const stats = db.getStats();
    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    logger.error('Error generating dashboard stats:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * API: Get all patients
 */
app.get('/api/patients', (req, res) => {
  try {
    const patients = db.getPatients();
    res.json({ success: true, data: patients });
  } catch (error) {
    logger.error('Error fetching patients:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * API: Get all appointments
 */
app.get('/api/appointments', (req, res) => {
  try {
    const appointments = db.getAppointments();
    res.json({ success: true, data: appointments });
  } catch (error) {
    logger.error('Error fetching appointments:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * API: Get all messages (logs)
 */
app.get('/api/messages', (req, res) => {
  try {
    const messages = db.getMessages();
    res.json({ success: true, data: messages });
  } catch (error) {
    logger.error('Error fetching messages:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * API: Get all critical cases
 */
app.get('/api/critical', (req, res) => {
  try {
    const critical = db.getCriticalCases();
    res.json({ success: true, data: critical });
  } catch (error) {
    logger.error('Error fetching critical cases:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * API: Get all active doctors
 */
app.get('/api/doctors', (req, res) => {
  try {
    const doctors = db.getDoctors();
    res.json({ success: true, data: doctors });
  } catch (error) {
    logger.error('Error fetching doctors:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * API: Add a new doctor
 */
app.post('/api/doctors', (req, res) => {
  try {
    const { name, specialty, department, phone } = req.body;
    if (!name || !specialty || !department) {
      return res.status(400).json({ success: false, error: 'Missing required doctor fields (name, specialty, department).' });
    }
    const doc = db.saveDoctor({ name, specialty, department, phone: phone || '' });
    res.json({ success: true, data: doc });
  } catch (error) {
    logger.error('Error adding doctor:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * API: Delete a doctor
 */
app.delete('/api/doctors/:id', (req, res) => {
  try {
    const { id } = req.params;
    const doc = db.deleteDoctor(Number(id));
    res.json({ success: true, data: doc });
  } catch (error) {
    logger.error('Error deleting doctor:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * API: Manual appointment booking
 */
app.post('/api/book', async (req, res) => {
  try {
    const { name, phone, age, gender, doctor, date, time, problem } = req.body;
    
    if (!name || !phone || !doctor || !date || !time) {
      return res.status(400).json({ success: false, error: 'Missing required booking fields (name, phone, doctor, date, time).' });
    }

    const appt = db.saveAppointment({
      phone,
      name,
      age: age || '',
      gender: gender || '',
      doctor,
      date,
      time,
      problem: problem || ''
    });

    // Notify the doctor via WhatsApp if their phone number is registered
    try {
      const docRecord = db.db.prepare('SELECT phone FROM doctors WHERE name = ?').get(doctor);
      const botInstance = require('./bot');
      const sock = botInstance.getSock();
      if (sock && docRecord && docRecord.phone && docRecord.phone.trim()) {
        const docJid = `${docRecord.phone.trim()}@s.whatsapp.net`;
        const notificationMsg = `*Vardan Hospital Notification* 🏥\n\nHello Doctor, a new appointment has been booked manually from the dashboard:\n\n👤 *Patient:* ${name}\n📅 *Date:* ${date}\n⏰ *Time Slot:* ${time}\n❓ *Problem:* ${problem || 'N/A'}\n📱 *Patient Phone:* +${phone}`;
        await sock.sendMessage(docJid, { text: notificationMsg });
        logger.info(`Manually booked appointment notification sent to Doctor: ${doctor} (${docRecord.phone})`);
      }
    } catch (sendErr) {
      logger.error(`Failed to send manual booking notification to doctor: ${sendErr.message}`);
    }

    res.json({ success: true, data: appt });
  } catch (error) {
    logger.error('Error booking manual appointment:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * API: Get all follow-ups
 */
app.get('/api/followups', (req, res) => {
  try {
    const list = db.getFollowups();
    res.json({ success: true, data: list });
  } catch (error) {
    logger.error('Error fetching follow-ups:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * API: Schedule a new follow-up
 */
app.post('/api/followups', (req, res) => {
  try {
    const { patient_phone, patient_name, message, scheduled_date } = req.body;
    if (!patient_phone || !patient_name || !message || !scheduled_date) {
      return res.status(400).json({ success: false, error: 'Missing required follow-up fields (patient_phone, patient_name, message, scheduled_date).' });
    }
    const followup = db.saveFollowup({ patient_phone, patient_name, message, scheduled_date });
    res.json({ success: true, data: followup });
  } catch (error) {
    logger.error('Error scheduling follow-up:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * API: Delete a scheduled follow-up
 */
app.delete('/api/followups/:id', (req, res) => {
  try {
    const { id } = req.params;
    const item = db.deleteFollowup(Number(id));
    res.json({ success: true, data: item });
  } catch (error) {
    logger.error('Error deleting follow-up:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * API: Send Bulk Broadcast/Promotions to all registered patients
 */
app.post('/api/broadcast', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message || !message.trim()) {
      return res.status(400).json({ success: false, error: 'Message content is required.' });
    }
    
    // Fetch all patients from SQLite
    const patientsList = db.getPatients();
    if (patientsList.length === 0) {
      return res.json({ success: true, sentCount: 0, message: 'No registered patients to broadcast to.' });
    }
    
    const botInstance = require('./bot');
    const sock = botInstance.getSock();
    if (!sock) {
      return res.status(503).json({ success: false, error: 'WhatsApp is not connected.' });
    }
    
    // Respond immediately so client is not kept waiting
    res.json({ success: true, targetCount: patientsList.length });
    
    // Trigger message dispatch in the background with a 1.5-second anti-spam delay
    (async () => {
      logger.info(`Starting bulk broadcast dispatch of "${message.substring(0, 30)}..." to ${patientsList.length} patients.`);
      let sentSuccess = 0;
      for (const patient of patientsList) {
        if (!patient.phone) continue;
        try {
          const jid = `${patient.phone.trim()}@s.whatsapp.net`;
          await sock.sendMessage(jid, { text: message });
          sentSuccess++;
          
          // 1.5-second delay to comply with WhatsApp spam restrictions
          await new Promise(resolve => setTimeout(resolve, 1500));
        } catch (err) {
          logger.error(`Failed to send broadcast to +${patient.phone}: ${err.message}`);
        }
      }
      logger.info(`Broadcast campaign complete. Successfully dispatched to ${sentSuccess}/${patientsList.length} patients.`);
    })();
    
  } catch (error) {
    logger.error('Error initiating broadcast campaign:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * API: Get active chats threads summary
 */
app.get('/api/chats', (req, res) => {
  try {
    const chats = db.getRecentChats();
    const activeChats = chats.map(chat => {
      const lastMessage = chat.reply || chat.message || '';
      const lastSender = chat.reply ? 'AI' : 'Patient';

      return {
        phone: chat.phone,
        name: chat.name || 'Unknown Patient',
        age: chat.age || 'N/A',
        gender: chat.gender || 'N/A',
        lastMessage,
        lastSender,
        timestamp: chat.timestamp
      };
    });

    res.json({ success: true, data: activeChats });
  } catch (error) {
    logger.error('Error fetching chat threads:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * API: Get detailed conversation log for a patient
 */
app.get('/api/chats/:phone', (req, res) => {
  try {
    const { phone } = req.params;
    const history = db.getChatHistory(phone);
    
    // Split message/reply rows into individual timeline bubbles
    const formattedLogs = [];
    for (const row of history) {
      if (row.message) {
        formattedLogs.push({
          sender: 'Patient',
          message: row.message,
          timestamp: row.created_at
        });
      }
      if (row.reply) {
        formattedLogs.push({
          sender: 'AI',
          message: row.reply,
          timestamp: row.created_at
        });
      }
    }
    
    res.json({ success: true, data: formattedLogs });
  } catch (error) {
    logger.error('Error fetching chat history:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Starts the express dashboard server.
 */
function startDashboard() {
  return new Promise((resolve) => {
    app.listen(PORT, () => {
      logger.info(`Express Dashboard server is running on http://localhost:${PORT}`);
      resolve();
    });
  });
}

module.exports = {
  startDashboard,
  broadcast
};
