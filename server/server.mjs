import dotenv from 'dotenv';
import dotenv from 'dotenv';
dotenv.config();
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import winston from 'winston';
import rateLimit from 'express-rate-limit';

const app = express();
const PORT = process.env.PORT || 3000;

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [new winston.transports.Console()]
});

app.use(morgan('combined'));
app.use(cors());
app.use(express.json());

const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many auth attempts. Try again in 1 minute.' },
  skip: () => process.env.NODE_ENV === 'test'
});

app.get('/api/health', (req, res) => {
  logger.info('Health check requested');
  res.json({
    status: 'ok',
    mode: 'AI-Powered',
    timestamp: new Date().toISOString(),
  });
});

app.post('/api/auth/login', authLimiter, (req, res) => {
  const { username, password } = req.body;
  // For demo purposes, accept any credentials
  return res.json({ token: 'dummy-token', user: username });
});

app.listen(PORT, '0.0.0.0', () => {
  logger.info(`Server running on http://localhost:${PORT}`);
});
    status: 'ok',
    mode: 'AI-Powered',
    timestamp: new Date().toISOString(),
  });
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  // Dummy check – in real app verify against DB
  if (username === 'admin' && password === 'admin123') {
    // In real app, generate JWT token and send back
    return res.json({ token: 'dummy-token', user: username });
  }

  return res.status(401).json({ error: 'Invalid credentials' });
});

app.listen(PORT, '0.0.0.0', () => {
  logger.info(`Server running on http://localhost:${PORT}`);
});