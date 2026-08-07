// Loads .env BEFORE any route module evaluates, so settings.mjs sees
// ENCRYPT_SECRET at import time (it derives its AES key at module scope).
import dotenv from 'dotenv';
dotenv.config();
