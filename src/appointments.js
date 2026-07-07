const { getOrCreateSession, clearSessionProfile } = require('./memory');
const db = require('./db');
const { logger } = require('./config');

/**
 * Validates session state and books an appointment in SQLite.
 * 
 * @param {string} phone - Patient's phone number.
 * @returns {Promise<object>} - The completed appointment details.
 */
async function executeAppointmentBooking(phone) {
  const session = getOrCreateSession(phone);
  const { name, age, gender, problem, doctor, preferredDate, preferredTime } = session.profile;

  // Validate that all fields are collected
  const missing = [];
  if (!name) missing.push('name');
  if (!age) missing.push('age');
  if (!gender) missing.push('gender');
  if (!problem) missing.push('problem');
  if (!doctor) missing.push('doctor');
  if (!preferredDate) missing.push('preferredDate');
  if (!preferredTime) missing.push('preferredTime');

  if (missing.length > 0) {
    logger.warn(`Failed booking attempt for ${phone}. Missing: ${missing.join(', ')}`);
    throw new Error(`Profile details are incomplete. Missing: ${missing.join(', ')}`);
  }

  logger.info(`Booking confirmed for ${phone}: ${name} with ${doctor}`);

  // Save patient and appointment to SQLite
  const appt = db.saveAppointment({
    phone,
    name,
    age,
    gender,
    doctor,
    date: preferredDate,
    time: preferredTime,
    problem
  });

  // Reset booking-specific fields in cache session, keeping name/age/gender for future ease
  clearSessionProfile(phone);

  return appt;
}

module.exports = {
  executeAppointmentBooking
};
