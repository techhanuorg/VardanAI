const { GoogleGenAI } = require('@google/genai');
const db = require('./db');
const { logger } = require('./config');

// Parse key pools from environment variables
const geminiPool = (process.env.GEMINI_API_KEY || '').split(',')
  .map((k, idx) => ({ key: k.trim(), cooldownUntil: 0, usageCount: 0, index: idx }))
  .filter(item => item.key);

const groqPool = (process.env.GROQ_API_KEYS || process.env.GROQ_API_KEY || '').split(',')
  .map((k, idx) => ({ key: k.trim(), cooldownUntil: 0, usageCount: 0, index: idx }))
  .filter(item => item.key);

const openRouterPool = (process.env.OPENROUTER_API_KEYS || '').split(',')
  .map((k, idx) => ({ key: k.trim(), cooldownUntil: 0, usageCount: 0, index: idx }))
  .filter(item => item.key);

logger.info(`LLMGateway initialized with ${geminiPool.length} Gemini, ${groqPool.length} Groq, and ${openRouterPool.length} OpenRouter keys.`);

/**
 * Timeout wrapper for a Promise.
 */
function withTimeout(promise, ms, name = 'Request') {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${name} timed out after ${ms}ms`));
    }, ms);
  });
  return Promise.race([
    promise.then(res => {
      clearTimeout(timeoutId);
      return res;
    }),
    timeoutPromise
  ]);
}

/**
 * Call standard Gemini models using the native GoogleGenAI SDK
 */
async function callGeminiKey(keyItem, contents, functionDeclarations, systemInstruction) {
  const start = Date.now();
  keyItem.usageCount++;
  
  try {
    const aiClient = new GoogleGenAI({ apiKey: keyItem.key });
    const requestPromise = aiClient.models.generateContent({
      model: 'gemini-3.5-flash',
      contents: contents,
      config: {
        systemInstruction: systemInstruction,
        tools: functionDeclarations && functionDeclarations.length > 0 ? [{ functionDeclarations }] : undefined
      }
    });

    const response = await withTimeout(requestPromise, 8000, `Gemini Key ${keyItem.index}`);
    
    // Log success
    const latency = Date.now() - start;
    db.saveLLMLog({
      provider: 'Gemini',
      key_index: keyItem.index,
      latency_ms: latency,
      success: 1
    });

    return { response, index: keyItem.index, provider: 'Gemini' };
  } catch (err) {
    const latency = Date.now() - start;
    logger.warn(`Gemini Key ${keyItem.index} failed: ${err.message}`);
    
    // Put key in cooldown for 60 seconds
    keyItem.cooldownUntil = Date.now() + 60000;
    
    db.saveLLMLog({
      provider: 'Gemini',
      key_index: keyItem.index,
      latency_ms: latency,
      success: 0,
      error: err.message
    });
    throw err;
  }
}

/**
 * Call Groq API via standard Fetch (OpenAI format)
 */
async function callGroqKey(keyItem, contents, tools, systemInstruction) {
  const start = Date.now();
  keyItem.usageCount++;

  // Map Gemini contents format to OpenAI messages format
  const messages = [
    { role: 'system', content: systemInstruction }
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
  const openAITools = tools ? tools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters
    }
  })) : undefined;

  const requestBody = {
    model: 'llama-3.3-70b-specdec',
    messages,
    tools: openAITools
  };

  const controller = new AbortController();
  
  try {
    const requestPromise = fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${keyItem.key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });

    const response = await withTimeout(requestPromise, 8000, `Groq Key ${keyItem.index}`);

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Groq HTTP ${response.status}: ${errText}`);
    }

    const data = await response.json();
    const choice = data.choices && data.choices[0];
    if (!choice) {
      throw new Error('Groq returned empty choices.');
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
          args = typeof tc.function.arguments === 'string' 
            ? JSON.parse(tc.function.arguments) 
            : tc.function.arguments;
        } catch (e) {
          logger.error(`Error parsing Groq tool args: ${e.message}`);
        }
        return {
          name: tc.function.name,
          args
        };
      });
    }

    const latency = Date.now() - start;
    db.saveLLMLog({
      provider: 'Groq',
      key_index: keyItem.index,
      latency_ms: latency,
      success: 1
    });

    return { response: result, index: keyItem.index, provider: 'Groq' };
  } catch (err) {
    controller.abort();
    const latency = Date.now() - start;
    logger.warn(`Groq Key ${keyItem.index} failed: ${err.message}`);
    
    keyItem.cooldownUntil = Date.now() + 60000;
    
    db.saveLLMLog({
      provider: 'Groq',
      key_index: keyItem.index,
      latency_ms: latency,
      success: 0,
      error: err.message
    });
    throw err;
  }
}

/**
 * Call OpenRouter API via Fetch (OpenAI format)
 */
async function callOpenRouterKey(keyItem, contents, tools, systemInstruction) {
  const start = Date.now();
  keyItem.usageCount++;

  const messages = [
    { role: 'system', content: systemInstruction }
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

  const openAITools = tools ? tools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters
    }
  })) : undefined;

  const requestBody = {
    model: 'google/gemini-2.5-flash:free',
    messages,
    tools: openAITools
  };

  const controller = new AbortController();

  try {
    const requestPromise = fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${keyItem.key}`,
        'HTTP-Referer': 'https://github.com/techhanuorg/VardanAI',
        'X-Title': 'Vardan AI Receptionist',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });

    const response = await withTimeout(requestPromise, 8000, `OpenRouter Key ${keyItem.index}`);

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`OpenRouter HTTP ${response.status}: ${errText}`);
    }

    const data = await response.json();
    const choice = data.choices && data.choices[0];
    if (!choice) {
      throw new Error('OpenRouter returned empty choices.');
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
          args = typeof tc.function.arguments === 'string' 
            ? JSON.parse(tc.function.arguments) 
            : tc.function.arguments;
        } catch (e) {
          logger.error(`Error parsing OpenRouter tool args: ${e.message}`);
        }
        return {
          name: tc.function.name,
          args
        };
      });
    }

    const latency = Date.now() - start;
    db.saveLLMLog({
      provider: 'OpenRouter',
      key_index: keyItem.index,
      latency_ms: latency,
      success: 1
    });

    return { response: result, index: keyItem.index, provider: 'OpenRouter' };
  } catch (err) {
    controller.abort();
    const latency = Date.now() - start;
    logger.warn(`OpenRouter Key ${keyItem.index} failed: ${err.message}`);
    
    keyItem.cooldownUntil = Date.now() + 60000;
    
    db.saveLLMLog({
      provider: 'OpenRouter',
      key_index: keyItem.index,
      latency_ms: latency,
      success: 0,
      error: err.message
    });
    throw err;
  }
}

/**
 * Unified request router that schedules a parallel race within the active provider pool.
 * Falls back sequentially: Gemini -> Groq -> OpenRouter.
 */
async function generateResponse(contents, tools, systemInstruction) {
  const now = Date.now();

  // --- Tier 1: Gemini ---
  const activeGemini = geminiPool.filter(k => k.cooldownUntil <= now);
  if (activeGemini.length > 0) {
    try {
      logger.debug(`LLMGateway: Starting parallel Gemini race across ${activeGemini.length} keys...`);
      const promises = activeGemini.map(keyItem => callGeminiKey(keyItem, contents, tools, systemInstruction));
      const result = await Promise.any(promises);
      logger.info(`LLMGateway: Parallel Gemini race won by Key ${result.index}`);
      return result.response;
    } catch (err) {
      logger.warn(`LLMGateway: All active Gemini keys failed. Falling back to Groq...`);
    }
  } else {
    logger.debug('LLMGateway: No active Gemini keys (all cooling down). Falling back to Groq...');
  }

  // --- Tier 2: Groq ---
  const activeGroq = groqPool.filter(k => k.cooldownUntil <= now);
  if (activeGroq.length > 0) {
    try {
      logger.debug(`LLMGateway: Starting parallel Groq race across ${activeGroq.length} keys...`);
      const promises = activeGroq.map(keyItem => callGroqKey(keyItem, contents, tools, systemInstruction));
      const result = await Promise.any(promises);
      logger.info(`LLMGateway: Parallel Groq race won by Key ${result.index}`);
      return result.response;
    } catch (err) {
      logger.warn(`LLMGateway: All active Groq keys failed. Falling back to OpenRouter...`);
    }
  } else {
    logger.debug('LLMGateway: No active Groq keys (all cooling down). Falling back to OpenRouter...');
  }

  // --- Tier 3: OpenRouter ---
  const activeOR = openRouterPool.filter(k => k.cooldownUntil <= now);
  if (activeOR.length > 0) {
    try {
      logger.debug(`LLMGateway: Starting parallel OpenRouter race across ${activeOR.length} keys...`);
      const promises = activeOR.map(keyItem => callOpenRouterKey(keyItem, contents, tools, systemInstruction));
      const result = await Promise.any(promises);
      logger.info(`LLMGateway: Parallel OpenRouter race won by Key ${result.index}`);
      return result.response;
    } catch (err) {
      logger.error(`LLMGateway: All OpenRouter failovers failed: ${err.message}`);
      throw new Error(`All LLM API provider key pools are exhausted or failed. Last error: ${err.message}`);
    }
  } else {
    logger.error('LLMGateway: No active OpenRouter keys (all cooling down). Gateway exhausted.');
    throw new Error('All LLM keys are in cooldown. Please wait 60 seconds for keys to refresh.');
  }
}

/**
 * Returns key status metadata for dashboard monitoring views.
 */
function getKeyStatus() {
  const now = Date.now();
  return {
    gemini: geminiPool.map(k => ({ index: k.index, active: k.cooldownUntil <= now, usage: k.usageCount })),
    groq: groqPool.map(k => ({ index: k.index, active: k.cooldownUntil <= now, usage: k.usageCount })),
    openrouter: openRouterPool.map(k => ({ index: k.index, active: k.cooldownUntil <= now, usage: k.usageCount }))
  };
}

module.exports = {
  generateResponse,
  getKeyStatus
};
