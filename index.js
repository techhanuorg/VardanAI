const { startDashboard } = require('./src/dashboard');
const { startBot } = require('./src/bot');
const { logger } = require('./src/config');
// Initialize database on boot
require('./src/db');
// Initialize Google Sheets Sync logger on boot
require('./src/sheets');

/**
 * Main application bootstrapper.
 */
async function main() {
  try {
    logger.info('============================================================');
    logger.info('   VARDAN CLINIC WHATSAPP AI RECEPTIONIST SYSTEM BOOTING    ');
    logger.info('============================================================');

    // 2. Start Express Web Server Dashboard
    await startDashboard();

    // 3. Connect Baileys WhatsApp client and start the AI loop
    await startBot();

    logger.info('Clinic Receptionist System initialized and listening for requests.');
    logger.info('============================================================');
  } catch (error) {
    logger.error('CRITICAL: Clinic system boot failed:', error);
    process.exit(1);
  }
}

// Global unhandled promise rejection handler
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

main();
