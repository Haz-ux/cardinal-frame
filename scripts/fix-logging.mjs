// Log pipeline fixes:
// 1. Winston: add rotating file transport (logs/ dir, 5MB files, keep 5)
//    → persistent structured JSON logs survive restarts.
// 2. Alert consumer: heartbeat:alert already persists to activity_log (verified).
//    Missing piece: heartbeat_rules table is EMPTY — no rules configured, so
//    nothing escalates. Seed production-grade default rules (with cooldowns).
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'fs';
import path from 'path';

const SRV = '/home/haz/cardinal-frame/cardinal-frame/src/server/server.mjs';
let srv = readFileSync(SRV, 'utf8');

// ─── 1. Winston file transport with rotation ──────────────────────
if (!/transports\.File|DailyRotateFile/.test(srv)) {
  const old = `const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [new winston.transports.Console()],
});`;
  const replacement = `const LOG_DIR = path.join(DATA_DIR, 'logs');
try { mkdirSync(LOG_DIR, { recursive: true }); } catch {}
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [
    new winston.transports.Console(),
    // Rotating file transport — structured JSON logs survive restarts,
    // 5MB per file, keep 5 (25MB ceiling). Failures never crash the server.
    new winston.transports.File({
      filename: path.join(LOG_DIR, 'server.log'),
      maxsize: 5 * 1024 * 1024,
      maxFiles: 5,
      tailable: true,
    }),
  ],
});`;
  if (srv.includes(old)) {
    srv = srv.replace(old, replacement);
    writeFileSync(SRV, srv);
    console.log('✅ Winston file transport added (logs/server.log, 5MB × 5 rotation)');
  } else {
    console.log('❌ logger block not found verbatim — patch manually');
  }
} else {
  console.log('file transport already present');
}
