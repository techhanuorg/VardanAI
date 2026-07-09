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
      
      // Run pending follow-ups check on startup
      setTimeout(checkAndSendFollowups, 5000);
    }
  });

  // Incoming Messages Event Listener
  sock.ev.on('messages.upsert', async (m) => {
    try {
      if (m.type !== 'notify') return;

      for (const msg of m.messages) {
        const remoteJid = msg.key.remoteJid;
        if (!remoteJid || msg.key.fromMe || remoteJid.endsWith('@g.us') || remoteJid === 'status@broadcast') {
          continue;
        }

        const text = msg.message?.conversation || 
                     msg.message?.extendedTextMessage?.text || 
                     msg.message?.imageMessage?.caption || 
                     msg.message?.videoMessage?.caption || 
                     '';

        if (!text.trim()) continue;

        const phone = remoteJid.split('@')[0];
        logger.info(`Received WhatsApp message from [${phone}]: "${text}"`);

        // 1. Retrieve or create patient session memory
        const session = getOrCreateSession(phone);

        // 2. Immediately log incoming message to SQLite messages table
        const messageId = db.saveIncomingMessage(phone, text);

        // 3. Check for Critical Symptoms
        const criticalSymptom = detectCriticalSymptom(text);
        if (criticalSymptom) {
          logger.warn(`Critical alert detected from [${phone}]. Symptom matched: ${criticalSymptom}`);
          db.saveCriticalCase(phone, criticalSymptom);
          await sock.sendMessage(remoteJid, { text: EMERGENCY_REPLY });
          db.saveOutgoingReply(messageId, EMERGENCY_REPLY);
          continue;
        }

        // 3.5. Check for Reset/Change Language Commands
        const checkText = text.trim().toLowerCase();
        const changeLanguageKeywords = ['change language', 'change bhasha', 'bhasha badlein', 'language change', '/language', 'भाषा बदलें', 'bhasha badlo', 'change language please'];
        if (changeLanguageKeywords.includes(checkText)) {
          session.profile.language = null;
          db.savePatientLanguage(phone, null);
          
          const menu = "Namaste! Welcome to Vardan Hospital. 😊\nकृपया बातचीत के लिए अपनी पसंदीदा भाषा चुनें / Please choose your preferred language:\n\n*1. Hinglish* (Hindi written in English Script)\n*2. Hindi* (हिंदी - देवनागरी लिपि)\n*3. English* (Pure English)\n\n👉 Reply with *1*, *2* or *3* to select.";
          await sock.sendMessage(remoteJid, { text: menu });
          db.saveOutgoingReply(messageId, menu);
          continue;
        }

        // 4. Intercept for Language Preference Selection if not set
        if (!session.profile.language) {
          const cleanText = text.trim();
          if (cleanText === '1' || cleanText.toLowerCase() === 'hinglish') {
            session.profile.language = 'hinglish';
            db.savePatientLanguage(phone, 'hinglish');
            
            const reply = "Dhanyawad! Ab hum Hinglish me baat karenge. 😊\n\nKripya apna naam aur aapko kya medical dikkat hai, ye batayein.";
            await sock.sendMessage(remoteJid, { text: reply });
            db.saveOutgoingReply(messageId, reply);
            addMessageToHistory(phone, 'model', reply);
            continue;
          } else if (cleanText === '2' || cleanText.toLowerCase() === 'hindi') {
            session.profile.language = 'hindi';
            db.savePatientLanguage(phone, 'hindi');
            
            const reply = "धन्यवाद! अब हम हिंदी में बात करेंगे। 😊\n\nकृपया अपना नाम और आपको क्या शारीरिक समस्या/लक्षण हैं, यह बताएं।";
            await sock.sendMessage(remoteJid, { text: reply });
            db.saveOutgoingReply(messageId, reply);
            addMessageToHistory(phone, 'model', reply);
            continue;
          } else if (cleanText === '3' || cleanText.toLowerCase() === 'english') {
            session.profile.language = 'english';
            db.savePatientLanguage(phone, 'english');
            
            const reply = "Thank you! We will now communicate in English. 😊\n\nPlease share your name and the medical problem or symptoms you are experiencing.";
            await sock.sendMessage(remoteJid, { text: reply });
            db.saveOutgoingReply(messageId, reply);
            addMessageToHistory(phone, 'model', reply);
            continue;
          } else {
            const menu = "Namaste! Welcome to Vardan Hospital. 😊\nकृपया बातचीत के लिए अपनी पसंदीदा भाषा चुनें / Please choose your preferred language:\n\n*1. Hinglish* (Hindi written in English Script)\n*2. Hindi* (हिंदी - देवनागरी लिपि)\n*3. English* (Pure English)\n\n👉 Reply with *1*, *2* or *3* to select.";
            await sock.sendMessage(remoteJid, { text: menu });
            db.saveOutgoingReply(messageId, menu);
            continue;
          }
        }

        try {
          // Define callbacks for tool calling
          const onProfileUpdate = async (patientPhone, args) => {
            updateProfile(patientPhone, args);
            db.savePatient({
              phone: patientPhone,
              name: session.profile.name,
              age: session.profile.age,
              gender: session.profile.gender
            });
          };

          const onBookAppointment = async (patientPhone) => {
            const appt = await executeAppointmentBooking(patientPhone);
            
            // Notify the assigned doctor via WhatsApp on confirmed booking
            try {
              const docRecord = db.db.prepare('SELECT phone FROM doctors WHERE name = ?').get(appt.doctor);
              if (docRecord && docRecord.phone && docRecord.phone.trim()) {
                const docJid = `${docRecord.phone.trim()}@s.whatsapp.net`;
                const notificationMsg = `*Vardan Hospital Notification* 🏥\n\nHello Doctor, a new appointment has been scheduled:\n\n👤 *Patient:* ${appt.name}\n📅 *Date:* ${appt.date}\n⏰ *Time Slot:* ${appt.time}\n❓ *Problem:* ${appt.problem || 'N/A'}\n📱 *Patient Phone:* +${appt.phone}`;
                await sock.sendMessage(docJid, { text: notificationMsg });
                logger.info(`WhatsApp appointment notification sent to Doctor: ${appt.doctor} (${docRecord.phone})`);
              }
            } catch (sendErr) {
              logger.error(`Failed to send booking notification to doctor: ${sendErr.message}`);
            }

            return appt;
          };

          // Call Gemini (handles recursive tool calls under the hood)
          const replyText = await generateReceptionistResponse(
            phone,
            text,
            session.history,
            session.profile.language,
            onProfileUpdate,
            onBookAppointment
          );

          if (replyText.trim()) {
            await sock.sendMessage(remoteJid, { text: replyText });
            logger.info(`Sent reply to [${phone}]: "${replyText}"`);
            db.saveOutgoingReply(messageId, replyText);
            addMessageToHistory(phone, 'user', text);
            addMessageToHistory(phone, 'model', replyText);
          }
        } catch (innerErr) {
          logger.error(`Error processing message from [${phone}]: ${innerErr.message}`, innerErr);
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

/**
 * Automatically checks and sends pending follow-up alerts to patients
 */
async function checkAndSendFollowups() {
  if (!sock || !isConnected) {
    logger.warn('Follow-up check skipped: WhatsApp socket is not connected.');
    return;
  }
  
  try {
    const pendings = db.getPendingFollowups();
    if (pendings.length === 0) {
      logger.debug('No pending follow-ups scheduled for today.');
      return;
    }
    
    logger.info(`Found ${pendings.length} pending follow-up campaigns to send...`);
    
    for (const f of pendings) {
      try {
        const jid = `${f.patient_phone}@s.whatsapp.net`;
        await sock.sendMessage(jid, { text: f.message });
        db.updateFollowupStatus(f.id, 'Sent');
        logger.info(`Follow-up alert sent successfully to +${f.patient_phone}`);
      } catch (err) {
        logger.error(`Error sending follow-up alert to +${f.patient_phone}: ${err.message}`);
        db.updateFollowupStatus(f.id, 'Failed');
      }
    }
  } catch (error) {
    logger.error('Error running checkAndSendFollowups:', error);
  }
}

// Run the follow-ups checker every 4 hours (4 * 60 * 60 * 1000 = 14400000ms)
setInterval(checkAndSendFollowups, 14400000);

module.exports = {
  startBot,
  getSock: () => sock,
  getIsConnected: () => isConnected,
  getCurrentQr: () => currentQr
};
