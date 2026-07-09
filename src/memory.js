const db = require('./db');
const { logger } = require('./config');

const sessionMap = new Map();

/**
 * Recovers patient profile and recent chat logs from SQLite.
 * 
 * @param {string} phone - The patient's phone number.
 * @returns {object} - The reconstructed session object.
 */
function recoverSessionFromDB(phone) {
  logger.info(`Reconstructing session memory for phone: ${phone} from SQLite...`);

  // 1. Recover patient profile details from SQLite
  const patientProfile = db.db.prepare('SELECT * FROM patients WHERE phone = ?').get(phone);
  
  const profile = {
    name: patientProfile?.name || null,
    age: patientProfile?.age || null,
    gender: patientProfile?.gender || null,
    language: patientProfile?.language || null,
    problem: null,
    doctor: null,
    preferredDate: null,
    preferredTime: null
  };

  // 2. Recover last 15 conversation logs from SQLite
  const rawLogs = db.db.prepare(`
    SELECT message, reply 
    FROM messages 
    WHERE phone = ? 
    ORDER BY created_at DESC 
    LIMIT 15
  `).all();
  
  // Reverse to make it chronological (oldest first)
  rawLogs.reverse();

  const history = [];

  for (const log of rawLogs) {
    // Only add to history if we have BOTH the message and a reply,
    // maintaining the strict alternating role requirement of Gemini (user -> model).
    if (log.message && log.reply) {
      history.push({
        role: 'user',
        parts: [{ text: log.message }]
      });
      history.push({
        role: 'model',
        parts: [{ text: log.reply }]
      });
    }
  }

  logger.debug(`Recovered profile for ${phone}: ${JSON.stringify(profile)}`);
  logger.debug(`Recovered ${history.length} history items for ${phone}`);

  return { profile, history };
}

/**
 * Gets or creates a conversational session for a patient.
 * 
 * @param {string} phone - Patient's phone number.
 * @returns {object} - The session object containing profile and history.
 */
function getOrCreateSession(phone) {
  if (!sessionMap.has(phone)) {
    const session = recoverSessionFromDB(phone);
    sessionMap.set(phone, session);
  }
  const session = sessionMap.get(phone);
  session.lastActive = Date.now();
  return session;
}

// Automatically prune inactive patient sessions from memory every 10 minutes to prevent leaks under load
setInterval(() => {
  const oneHourAgo = Date.now() - (60 * 60 * 1000);
  let prunedCount = 0;
  for (const [phone, session] of sessionMap.entries()) {
    if (session.lastActive < oneHourAgo) {
      sessionMap.delete(phone);
      prunedCount++;
    }
  }
  if (prunedCount > 0) {
    logger.info(`Session Pruning: Cleared ${prunedCount} inactive patient sessions from memory.`);
  }
}, 600000);

/**
 * Updates specific fields in the patient's profile.
 * 
 * @param {string} phone - Patient's phone number.
 * @param {object} updates - Object containing the key-value updates.
 */
function updateProfile(phone, updates) {
  const session = getOrCreateSession(phone);
  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined && value !== null && value !== '') {
      session.profile[key] = value;
    }
  }
  logger.debug(`Session profile updated for ${phone}: ${JSON.stringify(session.profile)}`);
}

/**
 * Adds a simple text message to the session's conversational history.
 * 
 * @param {string} phone - Patient's phone number.
 * @param {string} role - 'user' or 'model'.
 * @param {string} text - Message text.
 */
function addMessageToHistory(phone, role, text) {
  const session = getOrCreateSession(phone);
  
  // Clean up history to keep context windows reasonable
  if (session.history.length > 40) {
    session.history = session.history.slice(-20);
  }
  
  session.history.push({
    role,
    parts: [{ text }]
  });
}

/**
 * Adds a structured Gemini message (like tool call/response) to history.
 * 
 * @param {string} phone - Patient's phone number.
 * @param {object} content - The Gemini formatted message.
 */
function addContentToHistory(phone, content) {
  const session = getOrCreateSession(phone);
  
  if (session.history.length > 40) {
    session.history = session.history.slice(-20);
  }
  
  session.history.push(content);
}

/**
 * Clears the temporary appointment profile details but keeps name, age, gender and chat history.
 * Used after an appointment is successfully booked.
 * 
 * @param {string} phone - Patient's phone number.
 */
function clearSessionProfile(phone) {
  const session = getOrCreateSession(phone);
  session.profile.problem = null;
  session.profile.doctor = null;
  session.profile.preferredDate = null;
  session.profile.preferredTime = null;
  logger.info(`Cleared booking fields from profile for phone: ${phone}`);
}

/**
 * Clears the entire session from memory.
 * 
 * @param {string} phone - Patient's phone number.
 */
function clearSession(phone) {
  sessionMap.delete(phone);
  logger.info(`Session cleared from memory for phone: ${phone}`);
}

module.exports = {
  getOrCreateSession,
  updateProfile,
  addMessageToHistory,
  addContentToHistory,
  clearSessionProfile,
  clearSession
};
