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

// Configure WAL mode and busy timeout for high concurrency
try {
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 7000;');
  logger.info('SQLite database: configured WAL mode and busy_timeout successfully.');
} catch (pragmaErr) {
  logger.warn(`Failed to configure SQLite pragmas: ${pragmaErr.message}`);
}

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
    language TEXT,
    preferred_language TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS appointments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    patient_id INTEGER,
    doctor TEXT,
    doctor_id INTEGER,
    date TEXT,
    time TEXT,
    time_slot TEXT,
    problem TEXT,
    status TEXT DEFAULT 'Booked',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(patient_id) REFERENCES patients(id),
    FOREIGN KEY(doctor_id) REFERENCES doctors(id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT,
    message TEXT,
    reply TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    patient_id INTEGER,
    role TEXT,
    message TEXT,
    agent_used TEXT,
    language TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(patient_id) REFERENCES patients(id)
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
    phone TEXT,
    weekly_schedule_json TEXT,
    active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS follow_up_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    patient_id INTEGER NOT NULL,
    trigger_date TEXT NOT NULL,
    message_template TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    doctor_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(patient_id) REFERENCES patients(id),
    FOREIGN KEY(doctor_id) REFERENCES doctors(id)
  );

  CREATE TABLE IF NOT EXISTS knowledge_base (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT,
    question_variants TEXT,
    answer_hi TEXT,
    answer_en TEXT,
    answer_hinglish TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS pending_queries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    patient_id INTEGER,
    question TEXT,
    status TEXT DEFAULT 'pending',
    answered_by TEXT,
    answer TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(patient_id) REFERENCES patients(id)
  );

  CREATE TABLE IF NOT EXISTS llm_call_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT,
    key_index INTEGER,
    latency_ms INTEGER,
    success INTEGER DEFAULT 1,
    error TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS admin_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    email TEXT UNIQUE,
    role TEXT DEFAULT 'Staff',
    password_hash TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS followups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    patient_phone TEXT NOT NULL,
    patient_name TEXT NOT NULL,
    message TEXT NOT NULL,
    scheduled_date TEXT NOT NULL,
    status TEXT DEFAULT 'Pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Run dynamic schema migrations for existing SQLite databases
try { db.exec('ALTER TABLE patients ADD COLUMN language TEXT;'); } catch (e) {}
try { db.exec('ALTER TABLE patients ADD COLUMN preferred_language TEXT;'); } catch (e) {}
try { db.exec('ALTER TABLE doctors ADD COLUMN phone TEXT;'); } catch (e) {}
try { db.exec('ALTER TABLE doctors ADD COLUMN weekly_schedule_json TEXT;'); } catch (e) {}
try { db.exec('ALTER TABLE doctors ADD COLUMN active INTEGER DEFAULT 1;'); } catch (e) {}
try { db.exec('ALTER TABLE appointments ADD COLUMN doctor_id INTEGER REFERENCES doctors(id);'); } catch (e) {}
try { db.exec('ALTER TABLE appointments ADD COLUMN time_slot TEXT;'); } catch (e) {}

// Seed default doctors list if empty
const countDocs = db.prepare("SELECT COUNT(*) as count FROM doctors").get().count;
if (countDocs === 0) {
  const seedStmt = db.prepare("INSERT INTO doctors (name, specialty, department, phone, weekly_schedule_json, active) VALUES (?, ?, ?, ?, ?, 1)");
  const defaults = [
    { name: 'Dr. Alok Sharma', specialty: 'MD - General Medicine', department: 'General Physician', phone: '', weekly_schedule_json: '{"Monday":"9:00 AM - 2:00 PM","Tuesday":"9:00 AM - 2:00 PM","Wednesday":"9:00 AM - 2:00 PM","Thursday":"9:00 AM - 2:00 PM","Friday":"9:00 AM - 2:00 PM","Saturday":"9:00 AM - 2:00 PM"}' },
    { name: 'Dr. Sunita Verma', specialty: 'MD - Pediatrics', department: 'Pediatrician', phone: '', weekly_schedule_json: '{"Monday":"10:00 AM - 4:00 PM","Wednesday":"10:00 AM - 4:00 PM","Friday":"10:00 AM - 4:00 PM"}' },
    { name: 'Dr. Vikas Gupta', specialty: 'DM - Cardiology', department: 'Cardiologist', phone: '', weekly_schedule_json: '{"Tuesday":"3:00 PM - 7:00 PM","Thursday":"3:00 PM - 7:00 PM","Saturday":"3:00 PM - 7:00 PM"}' },
    { name: 'Dr. Rajesh Iyer', specialty: 'MS - Orthopedics', department: 'Orthopedic', phone: '', weekly_schedule_json: '{"Monday":"12:00 PM - 5:00 PM","Thursday":"12:00 PM - 5:00 PM"}' },
    { name: 'Dr. Naseeb', specialty: 'MD - Neurology', department: 'Neurologist', phone: '', weekly_schedule_json: '{"Wednesday":"2:00 PM - 6:00 PM","Saturday":"2:00 PM - 6:00 PM"}' },
    { name: 'Dr. Shafiq', specialty: 'MD - Neurology', department: 'Neurologist', phone: '', weekly_schedule_json: '{"Monday":"2:00 PM - 6:00 PM","Friday":"2:00 PM - 6:00 PM"}' }
  ];
  for (const d of defaults) {
    seedStmt.run(d.name, d.specialty, d.department, d.phone, d.weekly_schedule_json);
  }
  logger.info('Default doctors successfully seeded into SQLite.');
}

// Seed Knowledge Base if empty
const countKB = db.prepare("SELECT COUNT(*) as count FROM knowledge_base").get().count;
if (countKB === 0) {
  const seedKB = db.prepare(`
    INSERT INTO knowledge_base (category, question_variants, answer_hi, answer_en, answer_hinglish) 
    VALUES (?, ?, ?, ?, ?)
  `);
  
  seedKB.run(
    'location',
    'location, address, path, rasta, hospital kaha hai, pata, directions, address kya hai',
    'वरदान हॉस्पिटल, बहराइच, उत्तर प्रदेश में स्थित है। यह बहराइच के मुख्य बाजार/मुख्य मार्ग के पास स्थित है।',
    'Vardan Hospital is located in Bahraich, Uttar Pradesh (Near City Center).',
    'Vardan Hospital Bahraich, Uttar Pradesh me located hai. Aap Google Maps par "Vardan Hospital Bahraich" search kar ke aaram se aa sakte hain.'
  );

  seedKB.run(
    'timings',
    'timings, open, close, kab khulta hai, Sunday timing, hospital timings, opening hours, schedule',
    'वरदान हॉस्पिटल सोमवार से शनिवार सुबह 9:00 बजे से रात 8:00 बजे तक और रविवार को सुबह 10:00 बजे से दोपहर 2:00 बजे तक खुला रहता है।',
    'Vardan Hospital is open Monday to Saturday from 9:00 AM to 8:00 PM, and on Sundays from 10:00 AM to 2:00 PM.',
    'Vardan Hospital Monday se Saturday subah 9:00 baje se raat 8:00 baje tak aur Sunday ko subah 10:00 baje se dopahar 2:00 baje tak khula rehta hai.'
  );

  seedKB.run(
    'fees',
    'fees, consultation fee, doctor fee, parcha fee, price, charges, fee kitni hai',
    'वरदान हॉस्पिटल में सामान्य डॉक्टर की परामर्श फीस ₹300 है और स्पेशलिस्ट डॉक्टर की फीस ₹500 है।',
    'The general physician consultation fee is ₹300, and the specialist doctor fee is ₹500.',
    'Vardan Hospital me general consultation fee ₹300 aur specialist doctors ki fee ₹500 hai.'
  );

  seedKB.run(
    'reports',
    'reports, pathology, lab test, blood test, report kab milegi, xray, ultrasound',
    'सभी पैथोलॉजी और ब्लड टेस्ट रिपोर्ट्स उसी दिन शाम 6:00 बजे तक मिल जाती हैं। एक्स-रे और अल्ट्रासाउंड रिपोर्ट आधे घंटे में मिल जाती हैं।',
    'All pathology and blood test reports are available on the same day by 6:00 PM. X-Ray and Ultrasound reports are ready within 30 minutes.',
    'Sabhi pathology aur blood test reports usi din shaam 6:00 baje tak mil jati hain. X-ray aur ultrasound reports 30 minutes me taiyar ho jati hain.'
  );

  seedKB.run(
    'emergency',
    'emergency, 24 hours, ambulance, critical case, ICU',
    'आपातकालीन सेवाएं 24 घंटे उपलब्ध हैं। गंभीर मामलों के लिए हमारे पास आपातकालीन वार्ड और एम्बुलेंस की सुविधा उपलब्ध है।',
    'Emergency services are active 24/7. We have emergency wards and ambulance services for critical cases.',
    'Emergency services 24/7 active hain. Emergency help ya ambulance ke liye aap direct call kar sakte hain.'
  );
  logger.info('Knowledge base default data successfully seeded.');
}

logger.info('Native SQLite Database and schemas initialized successfully.');

/**
 * Inserts or updates a patient profile.
 */
function savePatient({ phone, name, age, gender }) {
  const cleanPhone = phone.replace(/\D/g, '');
  const selectStmt = db.prepare('SELECT * FROM patients WHERE phone = ?');
  const existing = selectStmt.get(cleanPhone);

  let patientId;
  
  if (existing) {
    const updateStmt = db.prepare(`
      UPDATE patients 
      SET name = COALESCE(?, name), 
          age = COALESCE(?, age), 
          gender = COALESCE(?, gender)
      WHERE phone = ?
    `);
    updateStmt.run(name || null, age || null, gender || null, cleanPhone);
    patientId = existing.id;
  } else {
    const insertStmt = db.prepare(`
      INSERT INTO patients (phone, name, age, gender) 
      VALUES (?, ?, ?, ?)
    `);
    const info = insertStmt.run(cleanPhone, name || '', age || '', gender || '');
    patientId = info.lastInsertRowid;
  }

  const updatedPatient = db.prepare('SELECT * FROM patients WHERE id = ?').get(patientId);
  dbEvents.emit('change', { type: 'PATIENT_UPDATED', data: updatedPatient });
  return updatedPatient;
}

/**
 * Books an appointment and registers the patient if not exists.
 */
function saveAppointment({ phone, name, age, gender, doctor, date, time, problem, doctor_id, time_slot }) {
  const patient = savePatient({ phone, name, age, gender });

  const insertStmt = db.prepare(`
    INSERT INTO appointments (patient_id, doctor, doctor_id, date, time, time_slot, problem, status) 
    VALUES (?, ?, ?, ?, ?, ?, ?, 'Booked')
  `);
  const info = insertStmt.run(patient.id, doctor, doctor_id || null, date, time, time_slot || null, problem);
  
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
  const cleanPhone = phone.replace(/\D/g, '');
  return db.prepare('SELECT * FROM messages WHERE phone = ? ORDER BY created_at ASC').all(cleanPhone);
}

/**
 * Doctors queries
 */
function getDoctors() {
  return db.prepare('SELECT * FROM doctors ORDER BY name ASC').all();
}

function saveDoctor({ name, specialty, department, phone, weekly_schedule_json, active }) {
  const stmt = db.prepare('INSERT INTO doctors (name, specialty, department, phone, weekly_schedule_json, active) VALUES (?, ?, ?, ?, ?, ?)');
  const info = stmt.run(name, specialty, department, phone || '', weekly_schedule_json || '{}', active !== undefined ? active : 1);
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

/**
 * Patient Language preference update
 */
function savePatientLanguage(phone, language) {
  const cleanPhone = phone.replace(/\D/g, '');
  const selectStmt = db.prepare('SELECT * FROM patients WHERE phone = ?');
  const existing = selectStmt.get(cleanPhone);
  if (existing) {
    db.prepare('UPDATE patients SET language = ?, preferred_language = ? WHERE phone = ?').run(language, language, cleanPhone);
  } else {
    db.prepare('INSERT INTO patients (phone, language, preferred_language) VALUES (?, ?, ?)').run(cleanPhone, language, language);
  }
}

/**
 * Follow-up Campaign queries
 */
function getFollowups() {
  return db.prepare('SELECT * FROM followups ORDER BY scheduled_date DESC').all();
}

function getPendingFollowups() {
  return db.prepare("SELECT * FROM followups WHERE date(scheduled_date) <= date('now', 'localtime') AND status = 'Pending'").all();
}

function saveFollowup({ patient_phone, patient_name, message, scheduled_date }) {
  const stmt = db.prepare('INSERT INTO followups (patient_phone, patient_name, message, scheduled_date, status) VALUES (?, ?, ?, ?, ?)');
  const info = stmt.run(patient_phone, patient_name, message, scheduled_date, 'Pending');
  const newFollow = db.prepare('SELECT * FROM followups WHERE id = ?').get(info.lastInsertRowid);
  dbEvents.emit('change', { type: 'FOLLOWUP_SCHEDULED', data: newFollow });
  return newFollow;
}

function updateFollowupStatus(id, status) {
  db.prepare('UPDATE followups SET status = ? WHERE id = ?').run(status, id);
  const updated = db.prepare('SELECT * FROM followups WHERE id = ?').get(id);
  dbEvents.emit('change', { type: 'FOLLOWUP_STATUS_UPDATED', data: updated });
}

function deleteFollowup(id) {
  const item = db.prepare('SELECT * FROM followups WHERE id = ?').get(id);
  db.prepare('DELETE FROM followups WHERE id = ?').run(id);
  if (item) {
    dbEvents.emit('change', { type: 'FOLLOWUP_DELETED', data: item });
  }
  return item;
}

/**
 * NEW: Conversation History Helpers
 */
function saveConversation(patient_id, role, message, agent_used, language) {
  const stmt = db.prepare('INSERT INTO conversations (patient_id, role, message, agent_used, language) VALUES (?, ?, ?, ?, ?)');
  stmt.run(patient_id, role, message, agent_used || 'Router', language || 'hinglish');
}

function getConversationHistory(patient_id, limit = 20) {
  return db.prepare('SELECT * FROM conversations WHERE patient_id = ? ORDER BY timestamp ASC LIMIT ?').all(patient_id, limit);
}

/**
 * NEW: SQLite-Backed crash-safe follow-up jobs
 */
function saveFollowUpJob({ patient_id, trigger_date, message_template, doctor_id }) {
  const stmt = db.prepare('INSERT INTO follow_up_jobs (patient_id, trigger_date, message_template, status, doctor_id) VALUES (?, ?, ?, \'pending\', ?)');
  const info = stmt.run(patient_id, trigger_date, message_template, doctor_id || null);
  return db.prepare('SELECT * FROM follow_up_jobs WHERE id = ?').get(info.lastInsertRowid);
}

function getPendingFollowUpJobs() {
  return db.prepare("SELECT j.*, p.name as patient_name, p.phone as patient_phone FROM follow_up_jobs j JOIN patients p ON j.patient_id = p.id WHERE j.status = 'pending' AND date(j.trigger_date) <= date('now', 'localtime')").all();
}

function updateFollowUpJobStatus(id, status) {
  db.prepare('UPDATE follow_up_jobs SET status = ? WHERE id = ?').run(status, id);
}

/**
 * NEW: LLM call logging telemetry
 */
function saveLLMLog({ provider, key_index, latency_ms, success, error }) {
  const stmt = db.prepare('INSERT INTO llm_call_logs (provider, key_index, latency_ms, success, error) VALUES (?, ?, ?, ?, ?)');
  stmt.run(provider, key_index, latency_ms, success !== undefined ? success : 1, error || null);
}

function getLLMLogs(limit = 100) {
  return db.prepare('SELECT * FROM llm_call_logs ORDER BY timestamp DESC LIMIT ?').all(limit);
}

/**
 * NEW: RAG Knowledge Base Editor Helpers
 */
function getKB() {
  return db.prepare('SELECT * FROM knowledge_base ORDER BY category ASC').all();
}

function saveKB({ id, category, question_variants, answer_hi, answer_en, answer_hinglish }) {
  if (id) {
    const stmt = db.prepare('UPDATE knowledge_base SET category = ?, question_variants = ?, answer_hi = ?, answer_en = ?, answer_hinglish = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
    stmt.run(category, question_variants, answer_hi, answer_en, answer_hinglish, id);
    return db.prepare('SELECT * FROM knowledge_base WHERE id = ?').get(id);
  } else {
    const stmt = db.prepare('INSERT INTO knowledge_base (category, question_variants, answer_hi, answer_en, answer_hinglish) VALUES (?, ?, ?, ?, ?)');
    const info = stmt.run(category, question_variants, answer_hi, answer_en, answer_hinglish);
    return db.prepare('SELECT * FROM knowledge_base WHERE id = ?').get(info.lastInsertRowid);
  }
}

function deleteKB(id) {
  db.prepare('DELETE FROM knowledge_base WHERE id = ?').run(id);
}

/**
 * NEW: Pending queries helpers (RAG fallback)
 */
function getPendingQueries() {
  return db.prepare('SELECT q.*, p.name as patient_name, p.phone as patient_phone FROM pending_queries q JOIN patients p ON q.patient_id = p.id ORDER BY q.created_at DESC').all();
}

function savePendingQuery(patient_id, question) {
  const stmt = db.prepare('INSERT INTO pending_queries (patient_id, question, status) VALUES (?, ?, \'pending\')');
  const info = stmt.run(patient_id, question);
  return db.prepare('SELECT * FROM pending_queries WHERE id = ?').get(info.lastInsertRowid);
}

function answerPendingQuery(id, answer, answered_by) {
  db.prepare('UPDATE pending_queries SET answer = ?, answered_by = ?, status = \'answered\' WHERE id = ?').run(answer, answered_by, id);
  return db.prepare('SELECT * FROM pending_queries WHERE id = ?').get(id);
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
  deleteDoctor,
  savePatientLanguage,
  getFollowups,
  getPendingFollowups,
  saveFollowup,
  updateFollowupStatus,
  deleteFollowup,
  
  // NEW EXPORTS
  saveConversation,
  getConversationHistory,
  saveFollowUpJob,
  getPendingFollowUpJobs,
  updateFollowUpJobStatus,
  saveLLMLog,
  getLLMLogs,
  getKB,
  saveKB,
  deleteKB,
  getPendingQueries,
  savePendingQuery,
  answerPendingQuery
};
