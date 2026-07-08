const { dbEvents } = require('./db');
const { logger } = require('./config');
const https = require('https');
const { URL } = require('url');

const WEBHOOK_URL = process.env.GOOGLE_SHEETS_WEBHOOK_URL;
const SHARED_SECRET = "vardan_secure_sync_2026";

if (!WEBHOOK_URL) {
  logger.warn('Google Sheets secure sync is inactive: GOOGLE_SHEETS_WEBHOOK_URL is not set in your .env file.');
} else {
  logger.info('Google Sheets secure sync initialized and listening for event logs.');
  
  dbEvents.on('change', async (event) => {
    try {
      if (event.type === 'APPOINTMENT_BOOKED') {
        const appt = event.data;
        const patient = require('./db').db.prepare('SELECT * FROM patients WHERE id = ?').get(appt.patient_id);
        const payload = {
          token: SHARED_SECRET,
          type: 'PATIENT_OR_BOOKING',
          data: {
            phone: patient?.phone || '',
            name: patient?.name || '',
            age: patient?.age || '',
            gender: patient?.gender || '',
            language: patient?.language || '',
            doctor: appt.doctor,
            date: appt.date,
            time: appt.time,
            problem: appt.problem
          }
        };
        await postToWebhook(WEBHOOK_URL, payload);
      } 
      else if (event.type === 'PATIENT_UPDATED') {
        const patient = event.data;
        const payload = {
          token: SHARED_SECRET,
          type: 'PATIENT_OR_BOOKING',
          data: {
            phone: patient.phone,
            name: patient.name,
            age: patient.age,
            gender: patient.gender,
            language: patient.language,
            doctor: '',
            date: '',
            time: '',
            problem: ''
          }
        };
        await postToWebhook(WEBHOOK_URL, payload);
      }
      else if (event.type === 'NEW_LOG') {
        const msg = event.data;
        if (msg.message) {
          const payload = {
            token: SHARED_SECRET,
            type: 'CHAT_LOG',
            data: {
              phone: msg.phone,
              sender: 'Patient',
              text: msg.message
            }
          };
          await postToWebhook(WEBHOOK_URL, payload);
        }
        if (msg.reply) {
          const payload = {
            token: SHARED_SECRET,
            type: 'CHAT_LOG',
            data: {
              phone: msg.phone,
              sender: 'AI Receptionist',
              text: msg.reply
            }
          };
          await postToWebhook(WEBHOOK_URL, payload);
        }
      }
    } catch (err) {
      logger.error(`Failed to execute Google Sheets sync for ${event.type}: ${err.message}`);
    }
  });
}

function postToWebhook(url, payload) {
  return new Promise((resolve, reject) => {
    try {
      const parsedUrl = new URL(url);
      const data = JSON.stringify(payload);
      
      const options = {
        hostname: parsedUrl.hostname,
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data)
        }
      };
      
      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => resolve(body));
      });
      
      req.on('error', (err) => reject(err));
      req.write(data);
      req.end();
    } catch (err) {
      reject(err);
    }
  });
}
