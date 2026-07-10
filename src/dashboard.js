const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const { PORT, logger } = require('./config');
const db = require('./db');

const app = express();
app.use(express.json());
app.use(cookieParser());

let ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'vardan123';

// Auth verification middleware
function requireAuth(req, res, next) {
  const bypassPaths = [
    '/login.html',
    '/login.css',
    '/login.js',
    '/api/login',
    '/api/send-test',
    '/api/errors',
    '/api/qr',
    '/api/diagnose-keys',
    '/api/monitoring/health',
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

/**
 * API: Fetch tracked runtime errors (for diagnostics)
 */
app.get('/api/errors', (req, res) => {
  res.json({ success: true, errors: global.lastErrors || [] });
});

/**
 * API: Fetch WhatsApp QR session status (for connection linking)
 */
app.get('/api/qr', (req, res) => {
  try {
    const botInstance = require('./bot');
    res.json({
      success: true,
      isConnected: botInstance.getIsConnected(),
      qr: botInstance.getCurrentQr()
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * API: Diagnose Environment API keys
 */
app.get('/api/diagnose-keys', (req, res) => {
  const gemini = process.env.GEMINI_API_KEY || '';
  const groq = process.env.GROQ_API_KEYS || process.env.GROQ_API_KEY || '';
  const or = process.env.OPENROUTER_API_KEYS || '';
  
  let dbLogs = [];
  try {
    const db = require('./db');
    dbLogs = db.db.prepare('SELECT * FROM llm_call_logs ORDER BY timestamp DESC LIMIT 20').all();
  } catch (err) {
    dbLogs = [{ error: err.message }];
  }
  
  res.json({
    gemini: {
      rawLength: gemini.length,
      keysCount: gemini.split(',').filter(Boolean).length,
      preview: gemini.split(',').map(k => k.trim().substring(0, 8) + '...').join(', ')
    },
    groq: {
      rawLength: groq.length,
      keysCount: groq.split(',').filter(Boolean).length,
      preview: groq.split(',').map(k => k.trim().substring(0, 8) + '...').join(', ')
    },
    openrouter: {
      rawLength: or.length,
      keysCount: or.split(',').filter(Boolean).length,
      preview: or.split(',').map(k => k.trim().substring(0, 8) + '...').join(', ')
    },
    dbLogs
  });
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

  res.write('data: {"type":"CONNECTED"}\n\n');
  sseClients.push(res);

  req.on('close', () => {
    sseClients = sseClients.filter(client => client !== res);
  });
});

// Broadcast database events to all open dashboard screens via SSE
db.dbEvents.on('change', (payload) => {
  const data = JSON.stringify(payload);
  for (const client of sseClients) {
    client.write(`data: ${data}\n\n`);
  }
});

/**
 * API: Get basic aggregated counts
 */
app.get('/api/stats', (req, res) => {
  try {
    const stats = db.getStats();
    res.json({ success: true, data: stats });
  } catch (error) {
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
    const phone = req.params.phone.replace(/\D/g, '');
    const history = db.getChatHistory(phone);
    
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
 * API: Doctors CRUD
 */
app.get('/api/doctors', (req, res) => {
  try {
    const docs = db.getDoctors();
    res.json({ success: true, data: docs });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/doctors', (req, res) => {
  try {
    const doc = db.saveDoctor(req.body);
    res.json({ success: true, data: doc });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.put('/api/doctors/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { name, specialty, department, phone, weekly_schedule_json, active } = req.body;
    db.db.prepare('UPDATE doctors SET name = ?, specialty = ?, department = ?, phone = ?, weekly_schedule_json = ?, active = ? WHERE id = ?')
      .run(name, specialty, department, phone || '', weekly_schedule_json || '{}', active !== undefined ? active : 1, id);
    
    const updated = db.db.prepare('SELECT * FROM doctors WHERE id = ?').get(id);
    db.dbEvents.emit('change', { type: 'DOCTOR_UPDATED', data: updated });
    res.json({ success: true, data: updated });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/doctors/:id', (req, res) => {
  try {
    const doc = db.deleteDoctor(req.params.id);
    res.json({ success: true, data: doc });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * API: Appointments CRUD
 */
app.get('/api/appointments', (req, res) => {
  try {
    const list = db.getAppointments();
    res.json({ success: true, data: list });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/appointments', (req, res) => {
  try {
    const { phone, name, age, gender, doctor, date, time, problem, doctor_id, time_slot } = req.body;
    
    // Conflict Check: Query SQLite directly before manual booking
    const conflict = db.db.prepare('SELECT COUNT(*) as count FROM appointments WHERE doctor_id = ? AND date = ? AND time_slot = ? AND status = \'Booked\'').get(doctor_id, date, time_slot).count;
    if (conflict > 0) {
      return res.status(400).json({ success: false, error: 'Conflict: This slot is already booked for this doctor.' });
    }

    const appt = db.saveAppointment({
      phone,
      name,
      age,
      gender,
      doctor,
      doctor_id,
      date,
      time,
      time_slot,
      problem
    });
    res.json({ success: true, data: appt });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.put('/api/appointments/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { status, date, time, time_slot } = req.body;
    db.db.prepare('UPDATE appointments SET status = COALESCE(?, status), date = COALESCE(?, date), time = COALESCE(?, time), time_slot = COALESCE(?, time_slot) WHERE id = ?')
      .run(status || null, date || null, time || null, time_slot || null, id);
    
    const updated = db.db.prepare('SELECT a.*, p.name, p.phone FROM appointments a JOIN patients p ON a.patient_id = p.id WHERE a.id = ?').get(id);
    db.dbEvents.emit('change', { type: 'APPOINTMENT_UPDATED', data: updated });
    res.json({ success: true, data: updated });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * API: RAG Knowledge Base CRUD
 */
app.get('/api/knowledge-base', (req, res) => {
  try {
    const kb = db.getKB();
    res.json({ success: true, data: kb });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/knowledge-base', (req, res) => {
  try {
    const item = db.saveKB(req.body);
    res.json({ success: true, data: item });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/knowledge-base/:id', (req, res) => {
  try {
    db.deleteKB(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * API: Pending Queries Answers
 */
app.get('/api/pending-queries', (req, res) => {
  try {
    const list = db.getPendingQueries();
    res.json({ success: true, data: list });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/pending-queries/:id/answer', (req, res) => {
  try {
    const { id } = req.params;
    const { answer, answered_by } = req.body;
    const updated = db.answerPendingQuery(id, answer, answered_by || 'Staff');
    
    // Auto-promote answered query to KB as new category entry if requested
    if (req.body.promoteToKB) {
      db.saveKB({
        category: 'general_faq',
        question_variants: updated.question,
        answer_hi: answer,
        answer_en: answer,
        answer_hinglish: answer
      });
    }

    res.json({ success: true, data: updated });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * API: Get LLM Gateway Telemetry Health Monitor Status
 */
app.get('/api/monitoring/health', (req, res) => {
  try {
    const botInstance = require('./bot');
    const gatewayInstance = require('./llm_gateway');
    
    const waConnected = botInstance.getIsConnected();
    const qrCode = botInstance.getCurrentQr();
    const keysStatus = gatewayInstance.getKeyStatus();
    
    const recentLogs = db.getLLMLogs(100);
    let avgLatency = 0;
    let successCount = 0;
    if (recentLogs.length > 0) {
      const sum = recentLogs.reduce((acc, log) => acc + log.latency_ms, 0);
      avgLatency = Math.round(sum / recentLogs.length);
      successCount = recentLogs.filter(log => log.success === 1).length;
    }
    
    const successRate = recentLogs.length > 0 
      ? Math.round((successCount / recentLogs.length) * 100)
      : 100;
      
    res.json({
      success: true,
      data: {
        whatsapp: {
          connected: waConnected,
          qr: qrCode
        },
        keys: keysStatus,
        telemetry: {
          avgLatencyMs: avgLatency,
          successRatePercent: successRate,
          totalLoggedCalls: recentLogs.length
        }
      }
    });
  } catch (error) {
    logger.error('Health API error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * API: Diagnostic test trigger (Sends test WhatsApp text)
 */
app.post('/api/send-test', async (req, res) => {
  try {
    const { phone, text } = req.body;
    if (!phone || !text) {
      return res.status(400).json({ success: false, error: 'Phone and text fields are required.' });
    }
    const cleanPhone = phone.replace(/\D/g, '');
    const botInstance = require('./bot');
    const sock = botInstance.getSock();
    
    if (!sock) {
      return res.status(503).json({ success: false, error: 'WhatsApp socket is not initialized.' });
    }

    const jid = `${cleanPhone}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text });
    res.json({ success: true, message: `Diagnostic test message successfully sent to ${cleanPhone}` });
  } catch (error) {
    logger.error('Diagnostic test send error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * API: Patients List & Campaigns management
 */
app.get('/api/patients', (req, res) => {
  try {
    const list = db.getPatients();
    res.json({ success: true, data: list });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/followups', (req, res) => {
  try {
    const list = db.getFollowups();
    res.json({ success: true, data: list });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/followups', (req, res) => {
  try {
    const item = db.saveFollowup(req.body);
    res.json({ success: true, data: item });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/followups/:id', (req, res) => {
  try {
    const item = db.deleteFollowup(req.params.id);
    res.json({ success: true, data: item });
  } catch (error) {
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
  startDashboard
};
