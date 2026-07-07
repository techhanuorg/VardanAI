require('dotenv').config();
const pino = require('pino');

const logger = pino({
  level: process.env.LOG_LEVEL || 'info'
});

// Validate required environment variables
const requiredEnv = [
  'GEMINI_API_KEY'
];

const missing = requiredEnv.filter(key => !process.env[key]);
if (missing.length > 0) {
  logger.error(`Critical configuration error: Missing environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

module.exports = {
  PORT: process.env.PORT || 3000,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  logger
};
