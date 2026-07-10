const { getSystemPrompt } = require('./prompts');
const db = require('./db');
const { logger } = require('./config');
const llmGateway = require('./llm_gateway');

/**
 * Generates response for the VardanAI Multi-Agent system.
 * Uses llm_gateway under-the-hood for multi-key failover and parallel races.
 */
async function generateReceptionistResponse(phone, userMessage, chatHistory, onProfileUpdate, onBookAppointment, onScheduleFollowup, language) {
  // 1. Fetch active doctors list from the database
  let doctorsList = [];
  try {
    doctorsList = db.getDoctors().filter(d => d.active !== 0);
  } catch (err) {
    logger.error(`Failed to fetch doctors list for prompt: ${err.message}`);
  }

  // 2. Load cached Knowledge Base facts from database
  let kbContext = '';
  try {
    const kbEntries = db.getKB();
    kbContext = kbEntries.map(entry => {
      return `Category: ${entry.category}\nQuestion Variants: ${entry.question_variants}\n- Hindi: ${entry.answer_hi}\n- English: ${entry.answer_en}\n- Hinglish: ${entry.answer_hinglish}`;
    }).join('\n\n');
  } catch (err) {
    logger.error(`Failed to load knowledge base for prompt: ${err.message}`);
  }

  const doctorsDescription = doctorsList && doctorsList.length > 0 
    ? doctorsList.map(doc => `Dr. ${doc.name} (${doc.department})`).join(', ')
    : 'No doctors currently available.';

  // Build the dynamic system prompt instructions
  const systemInstruction = getSystemPrompt({
    doctorsList,
    kbContext,
    language: language || 'hinglish'
  });

  // Setup tool/function definitions compatible with Gemini Schema format
  const functionDeclarations = [
    {
      name: 'updatePatientProfile',
      description: 'Call this as soon as any patient details (name, age, gender, problem, preferred doctor, preferred date/time) are mentioned by the patient. Do NOT wait for all details to be present to call this tool.',
      parameters: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING', description: "Patient's full name" },
          age: { type: 'STRING', description: "Patient's age (e.g. 25, 40)" },
          gender: { type: 'STRING', description: "Patient's gender (Male, Female, Other)" },
          problem: { type: 'STRING', description: "The medical problem, symptoms or reason for visit" },
          doctor: { type: 'STRING', description: `Preferred doctor from hospital list. Available options: ${doctorsDescription}` },
          preferredDate: { type: 'STRING', description: "Preferred appointment date (YYYY-MM-DD or tomorrow, next Monday)" },
          preferredTime: { type: 'STRING', description: "Preferred appointment time slot (e.g. 10:00 AM, Evening)" }
        }
      }
    },
    {
      name: 'bookAppointment',
      description: 'Call this ONLY after all required details (name, age, gender, problem, doctor, date, time) have been collected, repeated back, and the patient has confirmed they want to proceed with the booking.',
      parameters: {
        type: 'OBJECT',
        properties: {}
      }
    },
    {
      name: 'scheduleFollowup',
      description: 'Call this ONLY when the patient mentions they have been prescribed or are taking medication for a specific number of days, or they need a follow-up reminder. For example, if a patient says "Doctor ne 10 din ki dawa di hai" or similar.',
      parameters: {
        type: 'OBJECT',
        properties: {
          medicationDurationDays: { type: 'INTEGER', description: 'The number of days the medication lasts (e.g., 10, 7, 5, etc.)' }
        },
        required: ['medicationDurationDays']
      }
    }
  ];

  // Map incoming message history to GenAI SDK contents format
  const contents = [
    ...chatHistory,
    { role: 'user', parts: [{ text: userMessage }] }
  ];

  let loop = true;
  const maxIterations = 5;
  let iteration = 0;
  let finalResponseText = '';

  while (loop && iteration < maxIterations) {
    iteration++;
    logger.debug(`VardanAI execution turn ${iteration} for patient: ${phone}`);

    try {
      // Execute the request through the gateway (handles keys rotation, cooldowns, and fallback)
      const response = await llmGateway.generateResponse(contents, functionDeclarations, systemInstruction);

      // Check if LLM requested any tool/function calls
      const functionCalls = response.functionCalls;
      if (functionCalls && functionCalls.length > 0) {
        
        // Add model's functionCall turn to contents history
        const modelParts = functionCalls.map(call => ({
          functionCall: {
            name: call.name,
            args: call.args
          }
        }));
        contents.push({ role: 'model', parts: modelParts });

        // Execute tools
        const responseParts = [];
        for (const call of functionCalls) {
          logger.info(`Executing tool: ${call.name} with args: ${JSON.stringify(call.args)}`);
          let result = { success: false, message: 'Invalid tool' };

          if (call.name === 'updatePatientProfile') {
            try {
              await onProfileUpdate(phone, call.args);
              result = { success: true, message: 'Profile details updated in cache' };
            } catch (err) {
              logger.error(`Error in updatePatientProfile tool: ${err.message}`);
              result = { success: false, message: err.message };
            }
          } else if (call.name === 'bookAppointment') {
            try {
              const details = await onBookAppointment(phone);
              result = { success: true, message: 'Appointment booked successfully', details };
            } catch (err) {
              logger.error(`Error in bookAppointment tool: ${err.message}`);
              result = { success: false, message: err.message };
            }
          } else if (call.name === 'scheduleFollowup') {
            try {
              const resultData = await onScheduleFollowup(phone, call.args.medicationDurationDays);
              result = { success: true, message: 'Follow-up reminder successfully scheduled', details: resultData };
            } catch (err) {
              logger.error(`Error in scheduleFollowup tool: ${err.message}`);
              result = { success: false, message: err.message };
            }
          }

          responseParts.push({
            functionResponse: {
              name: call.name,
              response: result
            }
          });
        }

        // Add tool execution response back to contents history
        contents.push({ role: 'user', parts: responseParts });
      } else {
        // No function call, capture text answer and break the loop
        finalResponseText = response.text || '';
        loop = false;
      }
    } catch (error) {
      logger.error(`Error during generation turn: ${error.message}`);
      throw error;
    }
  }

  if (iteration >= maxIterations) {
    logger.warn(`Max loop iterations reached (${maxIterations}) for receptionist response.`);
  }

  return finalResponseText;
}

module.exports = {
  generateReceptionistResponse
};
