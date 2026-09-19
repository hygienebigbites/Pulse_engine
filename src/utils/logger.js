/* Minimal structured logger — logs to console AND to backend/debug.log so
 * troubleshooting output can be read directly from the file, no copy-paste
 * needed. */
const fs = require('fs');
const path = require('path');

const LOG_FILE = path.join(__dirname, '..', '..', 'debug.log');

function ts() {
  return new Date().toISOString();
}

function writeToFile(level, args) {
  try {
    const line = `[${ts()}] [${level}] ${args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`;
    fs.appendFileSync(LOG_FILE, line);
  } catch (e) {
    // never let logging itself crash the app
  }
}

module.exports = {
  info: (...args) => { console.log(`[${ts()}] [INFO]`, ...args); writeToFile('INFO', args); },
  warn: (...args) => { console.warn(`[${ts()}] [WARN]`, ...args); writeToFile('WARN', args); },
  error: (...args) => { console.error(`[${ts()}] [ERROR]`, ...args); writeToFile('ERROR', args); },
};
