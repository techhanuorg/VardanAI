const CRITICAL_KEYWORDS = [
  { pattern: /chest\s*pain/i, name: "Chest Pain" },
  { pattern: /heart\s*attack/i, name: "Heart Attack" },
  { pattern: /breathing\s*(problem|difficulty|issue|trouble)/i, name: "Breathing Problem" },
  { pattern: /shortness\s*of\s*breath/i, name: "Shortness of Breath" },
  { pattern: /heavy\s*bleeding/i, name: "Heavy Bleeding" },
  { pattern: /bleeding\s*heavily/i, name: "Heavy Bleeding" },
  { pattern: /accident/i, name: "Accident" },
  { pattern: /stroke/i, name: "Stroke" },
  { pattern: /seizure/i, name: "Seizure" },
  { pattern: /fits/i, name: "Fits" },
  { pattern: /unconscious/i, name: "Unconsciousness" },
  { pattern: /passed\s*out/i, name: "Unconsciousness" },
  { pattern: /fainted/i, name: "Fainting" },
  { pattern: /choking/i, name: "Choking" },
  { pattern: /cardiac\s*arrest/i, name: "Cardiac Arrest" },

  // Hindi/Hinglish regexes
  { pattern: /seene\s*(me)?\s*dard/i, name: "Chest Pain (Hindi)" },
  { pattern: /dil\s*ka\s*daura/i, name: "Heart Attack (Hindi)" },
  { pattern: /saans?\s*ki\s*(dikkat|takleef)/i, name: "Breathing Problem (Hindi)" },
  { pattern: /saans?\s*lene\s*me\s*(takleef|dikkat)/i, name: "Breathing Problem (Hindi)" },
  { pattern: /khoon\s*(beh|nikal)/i, name: "Bleeding (Hindi)" },
  { pattern: /mirgi/i, name: "Fits (Hindi)" },
  { pattern: /behosh/i, name: "Unconsciousness (Hindi)" },
  { pattern: /accident/i, name: "Accident" },
  { pattern: /heart/i, name: "Heart Issue" },
  { pattern: /severe\s*pain/i, name: "Severe Pain" },
  { pattern: /asahniya\s*dard/i, name: "Severe Pain (Hindi)" },
  { pattern: /tez\s*dard/i, name: "Severe Pain (Hindi)" }
];

const EMERGENCY_REPLY = `Your symptoms may require urgent medical attention. Please contact the doctor immediately or visit the nearest emergency department.

📞 Emergency Contact: +91-9876543210
🏥 Address: Vardan Hospital, Sector 15, Vasundhara, Ghaziabad.

Kripya turant nazdiki emergency room me jayein ya upar diye gaye number par call karein.`;

/**
 * Checks if the text contains critical emergency keywords.
 * @param {string} text - Message text to check.
 * @returns {object|null} - The matched keyword info or null.
 */
function detectCriticalSymptom(text) {
  if (!text) return null;
  for (const item of CRITICAL_KEYWORDS) {
    if (item.pattern.test(text)) {
      return item.name;
    }
  }
  return null;
}

module.exports = {
  detectCriticalSymptom,
  EMERGENCY_REPLY
};
