const { GoogleGenAI } = require('@google/genai');
const { GEMINI_API_KEY, logger } = require('./config');
const { SYSTEM_PROMPT } = require('./prompts');

// Load and parse native Gemini API keys
const apiKeys = GEMINI_API_KEY ? GEMINI_API_KEY.split(',').map(k => k.trim()) : [];
let currentKeyIndex = 0;

// Load and parse OpenRouter API keys
const openRouterKeys = process.env.OPENROUTER_API_KEYS ? process.env.OPENROUTER_API_KEYS.split(',').map(k => k.trim()) : [];
let currentOpenRouterIndex = 0;

/**
 * Returns a GoogleGenAI client instance using the currently active native key.
 */
function getAIClient() {
  if (apiKeys.length === 0) {
    throw new Error('No native Gemini API keys found in the environment configuration.');
  }
  const key = apiKeys[currentKeyIndex];
  return new GoogleGenAI({ apiKey: key });
}

/**
 * Rotates to the next native Gemini API key.
 */
function rotateAPIKey() {
  if (apiKeys.length <= 1) return false;
  currentKeyIndex = (currentKeyIndex + 1) % apiKeys.length;
  logger.warn(`Native Gemini API key rotated. New index: ${currentKeyIndex} (${apiKeys[currentKeyIndex].substring(0, 10)}...)`);
  return true;
}

/**
 * Returns the currently active OpenRouter API key.
 */
function getOpenRouterKey() {
  if (openRouterKeys.length === 0) return null;
  return openRouterKeys[currentOpenRouterIndex];
}

/**
 * Rotates to the next OpenRouter API key.
 */
function rotateOpenRouterKey() {
  if (openRouterKeys.length <= 1) return false;
  currentOpenRouterIndex = (currentOpenRouterIndex + 1) % openRouterKeys.length;
  logger.warn(`OpenRouter API key rotated. New index: ${currentOpenRouterIndex} (${openRouterKeys[currentOpenRouterIndex].substring(0, 10)}...)`);
  return true;
}

/**
 * Executes a fallback request to OpenRouter using OpenAI format compatibilities.
 */
async function callOpenRouter(contents, tools) {
  const apiKey = getOpenRouterKey();
  if (!apiKey) {
    throw new Error('No OpenRouter API keys configured for failover fallback.');
  }

  // Map Gemini contents format to OpenAI messages format
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT }
  ];
  for (const turn of contents) {
    const role = turn.role === 'model' ? 'assistant' : 'user';
    let text = '';
    if (turn.parts && turn.parts.length > 0) {
      if (typeof turn.parts[0] === 'string') {
        text = turn.parts[0];
      } else if (turn.parts[0].text) {
        text = turn.parts[0].text;
      }
    }
    messages.push({ role, content: text });
  }

  // Convert Gemini tools to OpenAI tool definitions
  const openAITools = tools ? tools.map(t => {
    return {
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters
      }
    };
  }) : undefined;

  const requestBody = {
    model: 'meta-llama/llama-3.1-8b-instruct:free', // Fast free model supporting tool calling
    messages,
    tools: openAITools
  };

  logger.info(`Sending fallback completion request to OpenRouter using key index: ${currentOpenRouterIndex}`);
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://github.com/techhanuorg/VardanAI',
      'X-Title': 'Vardan AI Receptionist',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenRouter HTTP ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const choice = data.choices && data.choices[0];
  if (!choice) {
    throw new Error('OpenRouter API returned empty choices.');
  }

  const msg = choice.message;
  const result = {
    text: msg.content || '',
    functionCalls: []
  };

  if (msg.tool_calls && msg.tool_calls.length > 0) {
    result.functionCalls = msg.tool_calls.map(tc => {
      let args = {};
      try {
        args = typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments) : tc.function.arguments;
      } catch (e) {
        logger.error(`Error parsing OpenRouter tool call args: ${e.message}`);
      }
      return {
        name: tc.function.name,
        args
      };
    });
  }

  return result;
}

// Global functions list
const functionDeclarations = [
  {
    name: 'updatePatientProfile',
    description: 'Call this whenever the patient shares details about themselves (Name, Age, Gender, Problem, Preferred Doctor, Preferred Date or Time). Call this as soon as any information is extracted.',
    parameters: {
      type: 'OBJECT',
      properties: {
        name: { type: 'STRING', description: "Patient's full name" },
        age: { type: 'STRING', description: "Patient's age (e.g. 25, 40)" },
        gender: { type: 'STRING', description: "Patient's gender (Male, Female, Other)" },
        problem: { type: 'STRING', description: "The medical problem, symptoms or reason for visit" },
        doctor: { type: 'STRING', description: "Preferred doctor from hospital list, e.g. Dr. Alok Sharma, Dr. Sunita Verma, Dr. Vikas Gupta, Dr. Rajesh Iyer" },
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
  }
];

/**
 * Sends a message to Gemini (or OpenRouter fallback) and handles function calling if requested.
 */
async function generateReceptionistResponse(phone, userMessage, chatHistory, onProfileUpdate, onBookAppointment) {
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
    logger.debug(`LLM API call iteration ${iteration} for ${phone}`);

    try {
      let response;
      let triedOpenRouter = false;

      try {
        // Try native Google GenAI client first
        let retries = 3;
        let delay = 1000; // 1s initial delay for transient errors
        
        while (retries > 0) {
          try {
            const aiClient = getAIClient();
            response = await aiClient.models.generateContent({
              model: 'gemini-flash-latest',
              contents: contents,
              config: {
                systemInstruction: SYSTEM_PROMPT,
                tools: [{ functionDeclarations }]
              }
            });
            break;
          } catch (err) {
            // If it's a quota limit error (429), bypass retries and fallback to OpenRouter instantly
            const isQuotaError = err.status === 429 || 
                                 (err.message && (err.message.includes('429') || err.message.includes('Quota exceeded') || err.message.includes('RESOURCE_EXHAUSTED')));
            if (isQuotaError) {
              logger.warn('Gemini free tier quota exhausted. Falling back to OpenRouter instantly without retry delays.');
              throw err;
            }

            const rotated = rotateAPIKey();
            if (rotated) {
              logger.info('Rotated Gemini API Key, retrying content generation immediately...');
              continue;
            }
            
            retries--;
            if (retries === 0) throw err;
            logger.warn(`Gemini API error (remaining retries: ${retries}): ${err.message}. Retrying in ${delay}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            delay *= 2;
          }
        }
      } catch (geminiError) {
        // If native keys fail, attempt OpenRouter failover
        logger.error(`Native Gemini API failed: ${geminiError.message}. Attempting failover to OpenRouter...`);
        
        let orRetries = 3;
        while (orRetries > 0) {
          try {
            response = await callOpenRouter(contents, functionDeclarations);
            triedOpenRouter = true;
            break;
          } catch (orErr) {
            const rotated = rotateOpenRouterKey();
            if (rotated) {
              logger.info('Rotated OpenRouter API Key, retrying completion immediately...');
              continue;
            }
            orRetries--;
            if (orRetries === 0) {
              logger.error(`OpenRouter failover exhausted all attempts: ${orErr.message}`);
              throw new Error(`Both native Gemini and OpenRouter failed. Last error: ${orErr.message}`);
            }
            logger.warn(`OpenRouter error, retrying in 3000ms...`);
            await new Promise(resolve => setTimeout(resolve, 3000));
          }
        }
      }

      // Process functions/calls in a unified structure
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
          logger.info(`LLM requested tool call: ${call.name} with args: ${JSON.stringify(call.args)}`);
          
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

        // Add response parts to message history
        contents.push({ role: 'user', parts: responseParts });
      } else {
        // No function calls, return final textual answer
        finalResponseText = response.text || '';
        loop = false;
      }
    } catch (error) {
      logger.error(`Error during generation turn: ${error.message}`);
      throw error;
    }
  }

  if (iteration >= maxIterations) {
    logger.warn(`Max iterations reached (${maxIterations}) for generation response loop.`);
  }

  return finalResponseText;
}

module.exports = {
  generateReceptionistResponse
};
