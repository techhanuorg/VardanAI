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
    connectTimeoutMs: 60000,
    syncFullHistory: false,
    markOnlineOnConnect: true
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
        logger.warn('WhatsApp Session permanently logged out or credentials invalid. Wiping auth/ folder and restarting automatically...');
        try {
          fs.rmSync(path.join(__dirname, '../auth'), { recursive: true, force: true });
        } catch (e) {
          logger.error(`Failed to delete auth directory: ${e.message}`);
        }
        setTimeout(() => {
          startBot();
        }, 5000);
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
    logger.info(`messages.upsert event: type=${m.type}, messages=${m.messages?.length || 0}`);
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

        // 2.5. Check if the message is from a registered doctor and matches a command
        const cleanDoctorPhone = phone.replace(/\D/g, '');
        const doctorRecord = db.db.prepare('SELECT * FROM doctors WHERE replace(phone, "+", "") = ?').get(cleanDoctorPhone);
        
        if (doctorRecord) {
          const commandText = text.trim().toLowerCase();
          
          if (commandText.startsWith('accept ') || commandText.startsWith('deny ') || commandText.startsWith('time ')) {
            const parts = text.trim().split(/\s+/);
            const cmd = parts[0].toLowerCase();
            const apptId = parseInt(parts[1]);
            
            if (apptId) {
              const appt = db.db.prepare('SELECT * FROM appointments WHERE id = ?').get(apptId);
              if (appt) {
                const patient = db.db.prepare('SELECT * FROM patients WHERE id = ?').get(appt.patient_id);
                const patientJid = `${patient.phone}@s.whatsapp.net`;
                
                if (cmd === 'accept') {
                  db.db.prepare("UPDATE appointments SET status = 'Confirmed' WHERE id = ?").run(apptId);
                  
                  const patientMsg = `Namaste ${patient.name} ji, aapka appointment Dr. ${doctorRecord.name} ke sath ${appt.date} ko ${appt.time} baje doctor dwara confirm kar diya gaya hai. Dhanyawad! - Vardan Hospital`;
                  await sock.sendMessage(patientJid, { text: patientMsg });
                  
                  const docReply = `Appointment #${apptId} for ${patient.name} has been Confirmed successfully. Patient has been notified.`;
                  await sock.sendMessage(remoteJid, { text: docReply });
                  db.saveOutgoingReply(messageId, docReply);
                  
                  const updatedAppt = db.db.prepare('SELECT * FROM appointments WHERE id = ?').get(apptId);
                  db.dbEvents.emit('change', { type: 'APPOINTMENT_BOOKED', data: updatedAppt });
                  
                } else if (cmd === 'deny') {
                  db.db.prepare("UPDATE appointments SET status = 'Denied' WHERE id = ?").run(apptId);
                  
                  const docReply = `Appointment #${apptId} has been Denied. Kripya alternative time batayein.\nFormat: "TIME ${apptId} [New Time]"\nExample: "TIME ${apptId} 4:00 PM"`;
                  await sock.sendMessage(remoteJid, { text: docReply });
                  db.saveOutgoingReply(messageId, docReply);
                  
                } else if (cmd === 'time') {
                  const newTime = parts.slice(2).join(' ');
                  if (newTime) {
                    db.db.prepare("UPDATE appointments SET status = 'Confirmed', time = ? WHERE id = ?").run(newTime, apptId);
                    
                    const patientMsg = `Namaste ${patient.name} ji, aapka appointment timing update kiya gaya hai. Dr. ${doctorRecord.name} ke sath naya samay ${newTime} confirm ho gaya hai. Dhanyawad! - Vardan Hospital`;
                    await sock.sendMessage(patientJid, { text: patientMsg });
                    
                    const docReply = `Appointment #${apptId} has been updated to ${newTime} and Confirmed successfully. Patient has been notified.`;
                    await sock.sendMessage(remoteJid, { text: docReply });
                    db.saveOutgoingReply(messageId, docReply);
                    
                    const updatedAppt = db.db.prepare('SELECT * FROM appointments WHERE id = ?').get(apptId);
                    db.dbEvents.emit('change', { type: 'APPOINTMENT_BOOKED', data: updatedAppt });
                  } else {
                    const docReply = `Error: Kripya new time provide karein. Format: "TIME ${apptId} [New Time]"`;
                    await sock.sendMessage(remoteJid, { text: docReply });
                    db.saveOutgoingReply(messageId, docReply);
                  }
                }
                continue;
              } else {
                const docReply = `Error: Appointment ID ${apptId} nahi mila.`;
                await sock.sendMessage(remoteJid, { text: docReply });
                db.saveOutgoingReply(messageId, docReply);
                continue;
              }
            }
          }
        }

        // 3. Check for Critical Symptoms
        const criticalSymptom = detectCriticalSymptom(text);
        if (criticalSymptom) {
          logger.warn(`Critical alert detected from [${phone}]. Symptom matched: ${criticalSymptom}`);
          db.saveCriticalCase(phone, criticalSymptom);
          await sock.sendMessage(remoteJid, { text: EMERGENCY_REPLY });
          db.saveOutgoingReply(messageId, EMERGENCY_REPLY);
          continue;
        }

        // 3.5. Check for Reset/Change Language Commands (Supports phrase matches)
        const checkText = text.trim().toLowerCase();
        const changeLanguageKeywords = [
          'change language', 'change bhasha', 'bhasha badlein', 'language change', '/language', 
          'भाषा बदलें', 'bhasha badlo', 'change language please', 'language badlo', 'bhasha change', 
          'language change kro', 'भाषा बदल दो', 'change bhasha please', 'bhasha badalna hai', 'language reset'
        ];
        const matchesKeyword = changeLanguageKeywords.some(kw => checkText.includes(kw)) ||
                              (checkText.includes('language') && (checkText.includes('change') || checkText.includes('reset') || checkText.includes('badle') || checkText.includes('badlo') || checkText.includes('select'))) ||
                              (checkText.includes('bhasha') && (checkText.includes('change') || checkText.includes('badle') || checkText.includes('badlo') || checkText.includes('reset')));

        if (matchesKeyword) {
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

          const onScheduleFollowup = async (patientPhone, medicationDurationDays) => {
            const patientName = session.profile.name || "Patient";
            const daysToWait = Math.max(1, medicationDurationDays - 1); // e.g., 9 days for 10-day meds
            
            const scheduledDate = new Date();
            scheduledDate.setDate(scheduledDate.getDate() + daysToWait);
            const dateStr = scheduledDate.toISOString().split('T')[0]; // YYYY-MM-DD
            
            const followupMessage = `Namaste ${patientName} ji, aapki ${medicationDurationDays} din ki dawaiyo ki course kal poori ho rahi hai. Kripya naye stocks lene ke liye ya doctor se consult karne ke liye Vardan Hospital visit karein. Aap direct call bhi kar sakte hain: +91-9876543210. Dhanyawad!`;
            
            db.saveFollowup({
              patient_phone: patientPhone,
              patient_name: patientName,
              message: followupMessage,
              scheduled_date: dateStr
            });
            
            logger.info(`Scheduled follow-up reminder for +${patientPhone} on ${dateStr} (in ${daysToWait} days)`);
            return { success: true, date: dateStr };
          };

          // Call Gemini (handles recursive tool calls under the hood)
          const replyText = await generateReceptionistResponse(
            phone,
            text,
            session.history,
            session.profile.language,
            onProfileUpdate,
            onBookAppointment,
            onScheduleFollowup
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
