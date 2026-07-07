const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcodeTerminal = require('qrcode-terminal');
const path = require('path');
const fs = require('fs');
const { logger } = require('./config');
const { detectCriticalSymptom, EMERGENCY_REPLY } = require('./critical');
const db = require('./db');
const { getOrCreateSession, updateProfile, addMessageToHistory } = require('./memory');
const { generateReceptionistResponse } = require('./gemini');
const { executeAppointmentBooking } = require('./appointments');

let sock = null;
let isConnected = false;
let currentQr = null;

/**
 * Initializes and starts the WhatsApp bot socket connection.
 */
async function startBot() {
  logger.info('Starting WhatsApp AI Bot...');
  
  // Ensure the auth directory exists
  const authPath = path.join(__dirname, '../auth');
  if (!fs.existsSync(authPath)) {
    fs.mkdirSync(authPath, { recursive: true });
  }

  // Load auth state from auth/ folder
  const { state, saveCreds } = await useMultiFileAuthState(authPath);

  // Initialize Socket connection
  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false, // We will print it ourselves with custom style
    defaultQueryTimeoutMs: 60000,
    connectTimeoutMs: 60000
  });

  // Track credentials updates
  sock.ev.on('creds.update', saveCreds);

  // Connection Update Event Listener
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      currentQr = qr;
      logger.info('--- Scan QR Code below to connect the WhatsApp AI Receptionist ---');
      qrcodeTerminal.generate(qr, { small: true });
    }

    if (connection === 'close') {
      isConnected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      
      logger.warn(`WhatsApp connection closed. Status Code: ${statusCode}. Reconnecting: ${shouldReconnect}`);

      if (shouldReconnect) {
        // Delay reconnecting to avoid tight loops on disconnect
        setTimeout(() => {
          startBot();
        }, 5000);
      } else {
        logger.error('WhatsApp Session Logged Out. Please delete auth/ folder and restart to scan new QR code.');
      }
    } else if (connection === 'open') {
      isConnected = true;
      currentQr = null; // Clear QR when connected
      logger.info('WhatsApp AI Receptionist successfully connected and active!');
    }
  });

  // Incoming Messages Event Listener
  sock.ev.on('messages.upsert', async (m) => {
    try {
      if (m.type !== 'notify') return;

      for (const msg of m.messages) {
        // Filter out messages from self, group chats, or status updates
        const remoteJid = msg.key.remoteJid;
        if (!remoteJid || msg.key.fromMe || remoteJid.endsWith('@g.us') || remoteJid === 'status@broadcast') {
          continue;
        }

        // Extract message text
        const text = msg.message?.conversation || 
                     msg.message?.extendedTextMessage?.text || 
                     msg.message?.imageMessage?.caption || 
                     msg.message?.videoMessage?.caption || 
                     '';

        if (!text.trim()) continue;

        const phone = remoteJid.split('@')[0];
        logger.info(`Received WhatsApp message from [${phone}]: "${text}"`);

        // 1. Immediately log incoming message to SQLite messages table
        const messageId = db.saveIncomingMessage(phone, text);

        // 2. Check for Critical Symptoms
        const criticalSymptom = detectCriticalSymptom(text);
        if (criticalSymptom) {
          logger.warn(`Critical alert detected from [${phone}]. Symptom matched: ${criticalSymptom}`);

          // Save critical alert to SQLite critical_cases table
          db.saveCriticalCase(phone, criticalSymptom);

          // Reply with Emergency Message
          await sock.sendMessage(remoteJid, { text: EMERGENCY_REPLY });
          db.saveOutgoingReply(messageId, EMERGENCY_REPLY);
          continue;
        }

        try {
          // 3. Normal conversation -> Forward to Gemini AI Receptionist
          const session = getOrCreateSession(phone);

          // Define callbacks for tool calling
          const onProfileUpdate = async (patientPhone, args) => {
            updateProfile(patientPhone, args);
            // Sync profile update back to SQLite patients table
            db.savePatient({
              phone: patientPhone,
              name: session.profile.name,
              age: session.profile.age,
              gender: session.profile.gender
            });
          };

          const onBookAppointment = async (patientPhone) => {
            return await executeAppointmentBooking(patientPhone);
          };

          // Call Gemini (handles recursive tool calls under the hood)
          const replyText = await generateReceptionistResponse(
            phone,
            text,
            session.history,
            onProfileUpdate,
            onBookAppointment
          );

          if (replyText.trim()) {
            // Send response via WhatsApp
            await sock.sendMessage(remoteJid, { text: replyText });
            logger.info(`Sent reply to [${phone}]: "${replyText}"`);

            // Log outgoing message reply to SQLite
            db.saveOutgoingReply(messageId, replyText);

            // Append exchange to patient session memory
            addMessageToHistory(phone, 'user', text);
            addMessageToHistory(phone, 'model', replyText);
          }
        } catch (innerErr) {
          logger.error(`Error processing message from [${phone}]:`, innerErr);
          try {
            const fallbackText = "Namaste. Hospital server par temporary high traffic hai. Kripya ek baar fir se message likhein, ya direct call karein: +91-9876543210.";
            await sock.sendMessage(remoteJid, { text: fallbackText });
            db.saveOutgoingReply(messageId, fallbackText);
          } catch (sendErr) {
            logger.error('Failed to send fallback reply:', sendErr);
          }
        }
      }
    } catch (err) {
      logger.error('Error processing messages.upsert event:', err);
    }
  });
}

module.exports = {
  startBot,
  getSock: () => sock,
  getIsConnected: () => isConnected,
  getCurrentQr: () => currentQr
};
