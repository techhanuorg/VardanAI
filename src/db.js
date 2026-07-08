const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');
const { logger } = require('./config');

const dbPath = path.join(__dirname, '../data/hospital.db');

// Ensure data directory exists
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

// Initialize SQLite database natively using Node.js built-in engine
const db = new DatabaseSync(dbPath);

// Setup Event Emitter for real-time updates
class DBEventEmitter extends EventEmitter {}
const dbEvents = new DBEventEmitter();

// Initialize tables
db.exec(`
  CREATE TABLE IF NOT EXISTS patients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT UNIQUE,
    name TEXT,
    age TEXT,
    gender TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS appointments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    patient_id INTEGER,
    doctor TEXT,
    date TEXT,
    time TEXT,
    problem TEXT,
    status TEXT DEFAULT 'Booked',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(patient_id) REFERENCES patients(id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT,
    message TEXT,
    reply TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS critical_cases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT,
    problem TEXT,
    status TEXT DEFAULT 'Active',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS doctors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    specialty TEXT NOT NULL,
    department TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Seed default doctors list if empty
const countDocs = db.prepare("SELECT COUNT(*) as count FROM doctors").get().count;
if (countDocs === 0) {
  const seedStmt = db.prepare("INSERT INTO doctors (name, specialty, department) VALUES (?, ?, ?)");
  const defaults = [
    { name: 'Dr. Alok Sharma', specialty: 'MD - General Medicine', department: 'General Physician' },
    { name: 'Dr. Sunita Verma', specialty: 'MD - Pediatrics', department: 'Pediatrician' },
    { name: 'Dr. Vikas Gupta', specialty: 'DM - Cardiology', department: 'Cardiologist' },
    { name: 'Dr. Rajesh Iyer', specialty: 'MS - Orthopedics', department: 'Orthopedic' },
    { name: 'Dr. Naseeb', specialty: 'MD - Neurology', department: 'Neurologist' },
    { name: 'Dr. Shafiq', specialty: 'MD - Neurology', department: 'Neurologist' }
  ];
  for (const d of defaults) {
    seedStmt.run(d.name, d.specialty, d.department);
  }
  logger.info('Default doctors successfully seeded into SQLite.');
}

logger.info('Native SQLite Database and schemas initialized successfully.');

/**
 * Inserts or updates a patient profile.
 */
function savePatient({ phone, name, age, gender }) {
  const selectStmt = db.prepare('SELECT * FROM patients WHERE phone = ?');
  const existing = selectStmt.get(phone);

  let patientId;
  
  if (existing) {
    const updateStmt = db.prepare(`
      UPDATE patients 
      SET name = COALESCE(?, name), 
          age = COALESCE(?, age), 
          gender = COALESCE(?, gender)
      WHERE phone = ?
    `);
    updateStmt.run(name || null, age || null, gender || null, phone);
    patientId = existing.id;
  } else {
    const insertStmt = db.prepare(`
      INSERT INTO patients (phone, name, age, gender) 
      VALUES (?, ?, ?, ?)
    `);
    const info = insertStmt.run(phone, name || '', age || '', gender || '');
    patientId = info.lastInsertRowid;
  }

  const updatedPatient = db.prepare('SELECT * FROM patients WHERE id = ?').get(patientId);
  dbEvents.emit('change', { type: 'PATIENT_UPDATED', data: updatedPatient });
  return updatedPatient;
}

/**
 * Books an appointment and registers the patient if not exists.
 */
function saveAppointment({ phone, name, age, gender, doctor, date, time, problem }) {
  // Ensure patient exists in registry
  const patient = savePatient({ phone, name, age, gender });

  const insertStmt = db.prepare(`
    INSERT INTO appointments (patient_id, doctor, date, time, problem, status) 
    VALUES (?, ?, ?, ?, ?, 'Booked')
  `);
  const info = insertStmt.run(patient.id, doctor, date, time, problem);
  
  const appt = db.prepare(`
    SELECT a.*, p.name, p.phone, p.age, p.gender 
    FROM appointments a
    JOIN patients p ON a.patient_id = p.id
    WHERE a.id = ?
  `).get(info.lastInsertRowid);

  dbEvents.emit('change', { type: 'APPOINTMENT_BOOKED', data: appt });
  return appt;
}

/**
 * Saves a critical case.
 */
function saveCriticalCase(phone, problem) {
  const insertStmt = db.prepare(`
    INSERT INTO critical_cases (phone, problem, status) 
    VALUES (?, ?, 'Active')
  `);
  const info = insertStmt.run(phone, problem);

  const critical = db.prepare('SELECT * FROM critical_cases WHERE id = ?').get(info.lastInsertRowid);
  dbEvents.emit('change', { type: 'CRITICAL_CASE', data: critical });
  return critical;
}

/**
 * Saves an incoming message from the patient.
 * Returns the message row ID to link with future replies.
 */
function saveIncomingMessage(phone, msgText) {
  const stmt = db.prepare('INSERT INTO messages (phone, message) VALUES (?, ?)');
  const info = stmt.run(phone, msgText);
  
  const newMsg = db.prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid);
  dbEvents.emit('change', { type: 'NEW_LOG', data: newMsg });
  return info.lastInsertRowid;
}

/**
 * Updates a message log with the outgoing response reply from the bot.
 */
function saveOutgoingReply(messageId, replyText) {
  const stmt = db.prepare('UPDATE messages SET reply = ? WHERE id = ?');
  stmt.run(replyText, messageId);

  const updatedMsg = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
  dbEvents.emit('change', { type: 'NEW_LOG', data: updatedMsg });
}

/**
 * Returns basic aggregated statistics for dashboard cards.
 */
function getStats() {
  const today = new Date().toISOString().split('T')[0];

  const patientsToday = db.prepare("SELECT COUNT(*) as count FROM patients WHERE date(created_at) = date(?)").get(today).count;
  const appointmentsToday = db.prepare("SELECT COUNT(*) as count FROM appointments WHERE date = ?").get(today).count;
  const activeCritical = db.prepare("SELECT COUNT(*) as count FROM critical_cases WHERE status = 'Active'").get().count;
  const uniqueChats = db.prepare("SELECT COUNT(DISTINCT phone) as count FROM messages").get().count;

  return {
    patientsToday,
    appointmentsToday,
    activeCritical,
    uniqueChats
  };
}

/**
 * Query Lists for API routes
 */
function getPatients() {
  return db.prepare('SELECT * FROM patients ORDER BY created_at DESC').all();
}

function getAppointments() {
  return db.prepare(`
    SELECT a.*, p.name, p.phone, p.age, p.gender 
    FROM appointments a
    JOIN patients p ON a.patient_id = p.id
    ORDER BY a.created_at DESC
  `).all();
}

function getMessages() {
  return db.prepare('SELECT * FROM messages ORDER BY created_at DESC').all();
}

function getCriticalCases() {
  return db.prepare('SELECT * FROM critical_cases ORDER BY created_at DESC').all();
}

/**
 * Fetches recent chat threads for threads list view.
 */
function getRecentChats() {
  return db.prepare(`
    SELECT m.phone, m.message, m.reply, m.created_at as timestamp, p.name, p.age, p.gender
    FROM messages m
    LEFT JOIN patients p ON m.phone = p.phone
    INNER JOIN (
      SELECT phone, MAX(created_at) as max_time
      FROM messages
      GROUP BY phone
    ) latest ON m.phone = latest.phone AND m.created_at = latest.max_time
    ORDER BY m.created_at DESC
  `).all();
}

/**
 * Gets conversation log for a specific patient.
 */
function getChatHistory(phone) {
  return db.prepare('SELECT * FROM messages WHERE phone = ? ORDER BY created_at ASC').all();
}

/**
 * Doctors queries
 */
function getDoctors() {
  return db.prepare('SELECT * FROM doctors ORDER BY name ASC').all();
}

function saveDoctor({ name, specialty, department }) {
  const stmt = db.prepare('INSERT INTO doctors (name, specialty, department) VALUES (?, ?, ?)');
  const info = stmt.run(name, specialty, department);
  const doc = db.prepare('SELECT * FROM doctors WHERE id = ?').get(info.lastInsertRowid);
  dbEvents.emit('change', { type: 'DOCTOR_ADDED', data: doc });
  return doc;
}

function deleteDoctor(id) {
  const doc = db.prepare('SELECT * FROM doctors WHERE id = ?').get(id);
  const stmt = db.prepare('DELETE FROM doctors WHERE id = ?');
  stmt.run(id);
  if (doc) {
    dbEvents.emit('change', { type: 'DOCTOR_DELETED', data: doc });
  }
  return doc;
}

module.exports = {
  db,
  dbEvents,
  savePatient,
  saveAppointment,
  saveCriticalCase,
  saveIncomingMessage,
  saveOutgoingReply,
  getStats,
  getPatients,
  getAppointments,
  getMessages,
  getCriticalCases,
  getRecentChats,
  getChatHistory,
  getDoctors,
  saveDoctor,
  deleteDoctor
};
