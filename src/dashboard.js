const express = require('express');
const path = require('path');
const { PORT, logger } = require('./config');
const db = require('./db');

const app = express();
app.use(express.json());

// Serve dashboard static files
app.use(express.static(path.join(__dirname, '../public')));

// Root route redirects to dashboard
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/dashboard.html'));
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
 * API: Manual appointment booking
 */
app.post('/api/book', (req, res) => {
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

    res.json({ success: true, data: appt });
  } catch (error) {
    logger.error('Error booking manual appointment:', error);
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
