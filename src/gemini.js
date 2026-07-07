const { GoogleGenAI } = require('@google/genai');
const { GEMINI_API_KEY, logger } = require('./config');
const { SYSTEM_PROMPT } = require('./prompts');

// Load and parse API keys from environment config (handles single key or comma-separated list)
const apiKeys = GEMINI_API_KEY ? GEMINI_API_KEY.split(',').map(k => k.trim()) : [];
let currentKeyIndex = 0;

/**
 * Returns a GoogleGenAI client instance using the currently active API key.
 */
function getAIClient() {
  if (apiKeys.length === 0) {
    throw new Error('No Gemini API keys found in the environment configuration.');
  }
  const key = apiKeys[currentKeyIndex];
  return new GoogleGenAI({ apiKey: key });
}

/**
 * Rotates to the next API key in the list. Returns true if rotation was successful.
 */
function rotateAPIKey() {
  if (apiKeys.length <= 1) return false;
  currentKeyIndex = (currentKeyIndex + 1) % apiKeys.length;
  logger.warn(`Gemini API limit or error hit. Rotating to API Key Index: ${currentKeyIndex} (${apiKeys[currentKeyIndex].substring(0, 10)}...)`);
  return true;
}

/**
 * Sends a message to Gemini and handles function calling if requested.
 * 
 * @param {string} phone - Patient's phone number.
 * @param {string} userMessage - The new text message from the patient.
 * @param {Array} chatHistory - Array of previous messages formatted for Gemini.
 * @param {Function} onProfileUpdate - Callback when updatePatientProfile is called.
 * @param {Function} onBookAppointment - Callback when bookAppointment is called.
 * @returns {Promise<string>} - The natural text reply from Gemini.
 */
async function generateReceptionistResponse(phone, userMessage, chatHistory, onProfileUpdate, onBookAppointment) {
  // Build the contents history array
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
    logger.debug(`Gemini API call iteration ${iteration} for ${phone}`);

    try {
      let response;
      let retries = 3;
      let delay = 1500;
      
      while (retries > 0) {
        try {
          const aiClient = getAIClient();
          response = await aiClient.models.generateContent({
            model: 'gemini-flash-latest',
            contents: contents,
            config: {
              systemInstruction: SYSTEM_PROMPT,
              tools: [
                {
                  functionDeclarations: [
                    {
                      name: 'updatePatientProfile',
                      description: 'Call this whenever the patient shares details about themselves (Name, Age, Gender, Problem, Preferred Doctor, Preferred Date or Time). Call this as soon as any information is extracted.',
                      parameters: {
                        type: 'OBJECT',
                        properties: {
                          name: { type: 'STRING', description: 'Patient\'s full name' },
                          age: { type: 'STRING', description: 'Patient\'s age (e.g. 25, 40)' },
                          gender: { type: 'STRING', description: 'Patient\'s gender (Male, Female, Other)' },
                          problem: { type: 'STRING', description: 'The medical problem, symptoms or reason for visit' },
                          doctor: { type: 'STRING', description: 'Preferred doctor from hospital list, e.g. Dr. Alok Sharma, Dr. Sunita Verma, Dr. Vikas Gupta, Dr. Rajesh Iyer' },
                          preferredDate: { type: 'STRING', description: 'Preferred appointment date (YYYY-MM-DD or tomorrow, next Monday)' },
                          preferredTime: { type: 'STRING', description: 'Preferred appointment time slot (e.g. 10:00 AM, Evening)' }
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
                    }
                  ]
                }
              ]
            }
          });
          break;
        } catch (err) {
          // If we hit a rate limit or API error, try rotating the API key first
          const rotated = rotateAPIKey();
          if (rotated) {
            logger.info('Rotated API Key, retrying content generation immediately...');
            // Don't decrement retries since we successfully rotated to a fresh key
            continue;
          }
          
          retries--;
          if (retries === 0) throw err;
          logger.warn(`Gemini API error (remaining retries: ${retries}): ${err.message}. Retrying in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          delay *= 2;
        }
      }

      const functionCalls = response.functionCalls;
      if (functionCalls && functionCalls.length > 0) {
        // Build model's turn with functionCall parts
        const modelParts = functionCalls.map(call => ({
          functionCall: {
            name: call.name,
            args: call.args
          }
        }));
        
        contents.push({ role: 'model', parts: modelParts });

        const responseParts = [];
        for (const call of functionCalls) {
          logger.info(`Gemini requested tool call: ${call.name} with args: ${JSON.stringify(call.args)}`);
          
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
          }

          responseParts.push({
            functionResponse: {
              name: call.name,
              response: result
            }
          });
        }

        // Add user response with functionResponse parts to the sequence
        contents.push({ role: 'user', parts: responseParts });
      } else {
        // No function calls, this is the final textual answer
        finalResponseText = response.text || '';
        loop = false;
      }
    } catch (error) {
      logger.error(`Error during Gemini generation: ${error.message}`);
      throw error;
    }
  }

  if (iteration >= maxIterations) {
    logger.warn(`Max iterations reached (${maxIterations}) for Gemini response loop.`);
  }

  return finalResponseText;
}

module.exports = {
  generateReceptionistResponse
};
