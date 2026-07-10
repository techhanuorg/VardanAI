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

// Heuristic script and vocabulary language detector
function detectLanguage(text) {
  const clean = text.trim();
  
  // 1. Devanagari script Unicode check for Hindi
  if (/[\u0900-\u097F]/.test(clean)) {
    return 'hindi';
  }

  // 2. Common Hinglish loanwords and particles check
  const lower = clean.toLowerCase();
  const hinglishKeywords = [
    'hai', 'tha', 'raha', 'rahi', 'kya', 'kaha', 'kab', 'kaun', 'kaise', 
    'ko', 'se', 'ka', 'ki', 'ke', 'mujhe', 'apna', 'naam', 'umar', 'dikkat', 
    'kal', 'aana', 'dikhana', 'dawa', 'dawaein', 'daktar', 'hospital', 'reception',
    'namaste', 'pranam', 'ram', 'shyam', 'aaj', 'parso', 'baje', 'baji', 'ghanta',
    'takleef', 'dard', 'pet', 'sir', 'khansi', 'bukhar', 'sardi', 'kamjori'
  ];
  
  const matchesHinglish = hinglishKeywords.some(kw => {
    const regex = new RegExp(`\\b${kw}\\b`, 'i');
    return regex.test(lower);
  });

  if (matchesHinglish) {
    return 'hinglish';
  }

  // 3. Fallback to English
  return 'english';
}

/**
 * Initializes and starts the WhatsApp bot socket connection.
 */
async function startBot() {
  logger.info('Starting WhatsApp AI Bot...');
  
  const authPath = path.join(__dirname, '../auth');
  if (!fs.existsSync(authPath)) {
    fs.mkdirSync(authPath, { recursive: true });
  }

  const { state, saveCreds } = await useMultiFileAuthState(authPath);

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    defaultQueryTimeoutMs: 60000,
    connectTimeoutMs: 60000,
    syncFullHistory: false,
    markOnlineOnConnect: true
  });

  sock.ev.on('creds.update', saveCreds);

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
        setTimeout(() => {
          startBot();
        }, 5000);
      } else {
        logger.warn('WhatsApp Session permanently logged out. Wiping auth/ folder and restarting...');
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
      currentQr = null;
      logger.info('WhatsApp AI Receptionist successfully connected and active!');
      
      // Initial background job trigger
      setTimeout(checkAndSendFollowups, 5000);
    }
  });

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

        const session = getOrCreateSession(phone);
        const messageId = db.saveIncomingMessage(phone, text);

        // Check if message is from doctor
        const cleanDoctorPhone = phone.replace(/\D/g, '');
        const doctorRecord = db.db.prepare("SELECT * FROM doctors WHERE replace(phone, '+', '') = ?").get(cleanDoctorPhone);
        
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

        // Check for Critical Symptoms
        const criticalSymptom = detectCriticalSymptom(text);
        if (criticalSymptom) {
          logger.warn(`Critical alert detected from [${phone}]. Symptom matched: ${criticalSymptom}`);
          db.saveCriticalCase(phone, criticalSymptom);
          await sock.sendMessage(remoteJid, { text: EMERGENCY_REPLY });
          db.saveOutgoingReply(messageId, EMERGENCY_REPLY);
          continue;
        }

        // Retrieve or create patient profile
        const cleanPhone = phone.replace(/\D/g, '');
        let patient = db.db.prepare('SELECT * FROM patients WHERE phone = ?').get(cleanPhone);
        
        if (!patient) {
          patient = db.savePatient({ phone: cleanPhone, name: '', age: '', gender: '' });
        }

        // Script-based language detection per message
        const detectedLang = detectLanguage(text);
        if (patient.preferred_language !== detectedLang) {
          db.savePatientLanguage(cleanPhone, detectedLang);
          patient.preferred_language = detectedLang;
        }
        session.profile.language = detectedLang;

        // Log message to conversations history
        db.saveConversation(patient.id, 'user', text, 'Router', detectedLang);

        // Load profile data into memory session
        session.profile.name = patient.name || '';
        session.profile.age = patient.age || '';
        session.profile.gender = patient.gender || '';

        try {
          // Callback: Profile tool execution
          const onProfileUpdate = async (patientPhone, args) => {
            updateProfile(patientPhone, args);
            db.savePatient({
              phone: patientPhone,
              name: session.profile.name,
              age: session.profile.age,
              gender: session.profile.gender
            });
          };

          // Callback: Appointment booking tool execution
          const onBookAppointment = async (patientPhone) => {
            const tempDoctor = session.profile.doctor || "General Physician";
            
            // Re-query doctor record to fetch details
            const matchedDoctor = db.db.prepare("SELECT * FROM doctors WHERE name LIKE ? OR department LIKE ?").get(`%${tempDoctor}%`, `%${tempDoctor}%`);
            
            const doctorId = matchedDoctor ? matchedDoctor.id : null;
            const doctorName = matchedDoctor ? matchedDoctor.name : tempDoctor;

            // Conflict Check: Query SQLite directly before final confirm
            const conflict = db.db.prepare('SELECT COUNT(*) as count FROM appointments WHERE doctor_id = ? AND date = ? AND time_slot = ? AND status = \'Booked\'').get(doctorId, session.profile.preferredDate, session.profile.preferredTime).count;
            if (conflict > 0) {
              throw new Error("Conflict: This exact time slot is already booked for this doctor. Please pick an alternative time slot.");
            }

            const appt = await db.saveAppointment({
              phone: patientPhone,
              name: session.profile.name,
              age: session.profile.age,
              gender: session.profile.gender,
              doctor: doctorName,
              doctor_id: doctorId,
              date: session.profile.preferredDate,
              time: session.profile.preferredTime,
              time_slot: session.profile.preferredTime,
              problem: session.profile.problem || 'Checkup'
            });
            
            // Send doctor WhatsApp booking alert
            if (matchedDoctor && matchedDoctor.phone && matchedDoctor.phone.trim()) {
              try {
                const docJid = `${matchedDoctor.phone.trim()}@s.whatsapp.net`;
                const notificationMsg = `*Vardan Hospital Notification* 🏥\n\nHello Doctor, a new appointment has been scheduled:\n\n👤 *Patient:* ${appt.name}\n📅 *Date:* ${appt.date}\n⏰ *Time Slot:* ${appt.time}\n❓ *Problem:* ${appt.problem || 'N/A'}\n📱 *Patient Phone:* +${appt.phone}`;
                await sock.sendMessage(docJid, { text: notificationMsg });
                logger.info(`WhatsApp appointment notification sent to Doctor: ${doctorName}`);
              } catch (sendErr) {
                logger.error(`Failed to send booking notification to doctor: ${sendErr.message}`);
              }
            }

            return appt;
          };

          // Callback: Follow-up tool execution
          const onScheduleFollowup = async (patientPhone, medicationDurationDays) => {
            const patientName = session.profile.name || "Patient";
            const daysToWait = Math.max(1, medicationDurationDays - 1);
            
            const scheduledDate = new Date();
            scheduledDate.setDate(scheduledDate.getDate() + daysToWait);
            const dateStr = scheduledDate.toISOString().split('T')[0];

            // Build dynamic follow-up template
            const followupMessage = detectedLang === 'hindi'
              ? `नमस्ते ${patientName} जी, आपके ${medicationDurationDays} दिनों के दवाई का कोर्स कल समाप्त हो रहा है। कृपया नया स्टॉक लेने या डॉक्टर से दोबारा मिलने के लिए वरदान हॉस्पिटल आएं। धन्यवाद!`
              : detectedLang === 'english'
                ? `Hello ${patientName}, your ${medicationDurationDays} days medication course is ending tomorrow. Please visit Vardan Hospital for checkup or medicine refills. Thank you!`
                : `Namaste ${patientName} ji, aapki ${medicationDurationDays} din ki dawa ka course kal khatam ho raha hai. Kripya follow-up consult ya medicine stock refill ke liye Vardan Hospital visit karein. Dhanyawad!`;
            
            db.saveFollowUpJob({
              patient_id: patient.id,
              trigger_date: dateStr,
              message_template: followupMessage,
              doctor_id: null
            });
            
            logger.info(`Scheduled follow-up reminder for +${patientPhone} on ${dateStr} (in ${daysToWait} days)`);
            return { success: true, date: dateStr };
          };

          // Map model agent used
          let activeAgent = 'FAQ';
          if (text.toLowerCase().includes('book') || text.toLowerCase().includes('appoint') || text.toLowerCase().includes('millna')) {
            activeAgent = 'Booking';
          }

          // Call the Unified LLM gateway
          const replyText = await generateReceptionistResponse(
            phone,
            text,
            session.history,
            onProfileUpdate,
            onBookAppointment,
            onScheduleFollowup,
            detectedLang
          );

          if (replyText.trim()) {
            await sock.sendMessage(remoteJid, { text: replyText });
            logger.info(`Sent reply to [${phone}]: "${replyText}"`);
            
            db.saveOutgoingReply(messageId, replyText);
            addMessageToHistory(phone, 'user', text);
            addMessageToHistory(phone, 'model', replyText);

            // Log response to conversations history
            db.saveConversation(patient.id, 'model', replyText, activeAgent, detectedLang);
          }
        } catch (innerErr) {
          logger.error(`Error processing message from [${phone}]: ${innerErr.message}`, innerErr);
          if (!global.lastErrors) global.lastErrors = [];
          global.lastErrors.push({
            timestamp: new Date().toISOString(),
            context: `inner message processing for phone ${phone}`,
            message: innerErr.message,
            stack: innerErr.stack
          });
          if (global.lastErrors.length > 50) global.lastErrors.shift();

          try {
            const fallbackText = detectedLang === 'hindi'
              ? "नमस्ते। हॉस्पिटल सर्वर पर अभी अधिक लोड है। कृपया कुछ देर बाद दोबारा संदेश भेजें या सीधे संपर्क करें: +91-9876543210।"
              : detectedLang === 'english'
                ? "Hello. The hospital server is experiencing temporary high traffic. Please try again in a few moments or call us: +91-9876543210."
                : "Namaste. Hospital server par temporary high traffic hai. Kripya ek baar fir se message likhein, ya direct call karein: +91-9876543210.";
            
            await sock.sendMessage(remoteJid, { text: fallbackText });
            db.saveOutgoingReply(messageId, fallbackText);
          } catch (sendErr) {
            logger.error('Failed to send fallback reply:', sendErr);
          }
        }
      }
    } catch (err) {
      logger.error(err, 'Error processing messages.upsert event');
      if (!global.lastErrors) global.lastErrors = [];
      global.lastErrors.push({
        timestamp: new Date().toISOString(),
        context: 'outer messages.upsert loop',
        message: err.message,
        stack: err.stack
      });
      if (global.lastErrors.length > 50) global.lastErrors.shift();
    }
  });
}

/**
 * Hourly Cron Job: Sends pending follow-up alerts and checks for doctor escalations
 */
async function checkAndSendFollowups() {
  if (!sock || !isConnected) {
    logger.warn('Follow-up check skipped: WhatsApp socket is not connected.');
    return;
  }
  
  try {
    // 1. Process pending reminders
    const pendings = db.getPendingFollowUpJobs();
    if (pendings.length > 0) {
      logger.info(`Found ${pendings.length} pending follow-up jobs to trigger...`);
      for (const job of pendings) {
        try {
          const jid = `${job.patient_phone}@s.whatsapp.net`;
          await sock.sendMessage(jid, { text: job.message_template });
          db.updateFollowUpJobStatus(job.id, 'sent');
          logger.info(`Follow-up job ID ${job.id} sent successfully to patient: ${job.patient_name}`);
        } catch (err) {
          logger.error(`Error sending follow-up job ID ${job.id}: ${err.message}`);
        }
      }
    }

    // 2. Process escalations (jobs triggered > 24 hours ago with no user replies)
    const sentJobs = db.db.prepare(`
      SELECT j.*, p.phone as patient_phone, p.name as patient_name, d.phone as doctor_phone, d.name as doctor_name
      FROM follow_up_jobs j
      JOIN patients p ON j.patient_id = p.id
      LEFT JOIN doctors d ON j.doctor_id = d.id
      WHERE j.status = 'sent' AND datetime(j.created_at, '+24 hours') <= datetime('now', 'localtime')
    `).all();

    for (const job of sentJobs) {
      const chatCount = db.db.prepare("SELECT COUNT(*) as count FROM conversations WHERE patient_id = ? AND role = 'user' AND timestamp > ?").get(job.patient_id, job.created_at).count;
      
      if (chatCount === 0) {
        db.updateFollowUpJobStatus(job.id, 'escalated');
        logger.warn(`Escalation triggered: patient ${job.patient_name} (+${job.patient_phone}) did not respond in 24h.`);
        
        if (job.doctor_phone && job.doctor_phone.trim()) {
          try {
            const docJid = `${job.doctor_phone.trim()}@s.whatsapp.net`;
            const alertMsg = `*Vardan Hospital Escalation Alert* ⚠️\n\nHello Dr. ${job.doctor_name}, patient *${job.patient_name}* (+${job.patient_phone}) has not responded to their medication follow-up reminder sent 24 hours ago. Please review if human follow-up is required.`;
            await sock.sendMessage(docJid, { text: alertMsg });
            logger.info(`Escalation notification sent to Doctor: ${job.doctor_name}`);
          } catch (sendErr) {
            logger.error(`Failed to send escalation alert to doctor: ${sendErr.message}`);
          }
        }
      } else {
        // Patient responded, mark job as acknowledged
        db.updateFollowUpJobStatus(job.id, 'acknowledged');
      }
    }

  } catch (error) {
    logger.error('Error running checkAndSendFollowups background process:', error);
  }
}

// Run the cron scheduler loop every 1 hour (1 * 60 * 60 * 1000 = 3600000ms)
setInterval(checkAndSendFollowups, 3600000);

module.exports = {
  startBot,
  getSock: () => sock,
  getIsConnected: () => isConnected,
  getCurrentQr: () => currentQr,
  checkAndSendFollowups
};
