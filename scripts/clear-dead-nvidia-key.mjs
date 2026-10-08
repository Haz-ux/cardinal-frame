// Server now uses the .env ENCRYPT_SECRET (roundtrip MATCH confirmed).
// The stored NVIDIA key was encrypted under a PREVIOUS boot's random key →
// undecryptable garbage. Fix: clear the dead key (set to empty) so the
// Settings→env sync path can repopulate it, and prepare for the user to
// paste the real nvapi key.
import Database from 'better-sqlite3';
const db = new Database('data/cardinal.db');
const nvidia = db.prepare("SELECT id, name, api_key FROM llm_providers WHERE type='nvidia'").get();
console.log('BEFORE:', nvidia.name, 'api_key len:', nvidia.api_key.length, 'starts:', nvidia.api_key.slice(0, 8));
// Clear the dead ciphertext
db.prepare("UPDATE llm_providers SET api_key = '', enabled = 0 WHERE type = 'nvidia'").run();
const after = db.prepare("SELECT id, name, api_key, enabled FROM llm_providers WHERE type='nvidia'").get();
console.log('AFTER:', after.name, 'api_key:', JSON.stringify(after.api_key), 'enabled:', after.enabled);
console.log('Dead key cleared — save NVIDIA_API_KEY via Settings or the LLM Models page to repopulate.');
