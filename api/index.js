require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const { Pool } = require('pg');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── PostgreSQL Connection Pool ────────────────────────────────────────────────
// Uses DATABASE_URL (Neon/hosted) when set, otherwise falls back to local params.
const poolConfig = process.env.DATABASE_URL
  ? {
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    }
  : {
      host:     process.env.DB_HOST     || 'localhost',
      port:     parseInt(process.env.DB_PORT, 10) || 5432,
      user:     process.env.DB_USER     || 'postgres',
      password: String(process.env.DB_PASSWORD ?? ''),
      database: process.env.DB_NAME     || 'predictions',
    };

const pool = new Pool(poolConfig);

// ─── Table Auto-Creation ───────────────────────────────────────────────────────
async function initializeDatabase() {
  try {
    // 1. Create table if missing
    await pool.query(`
      CREATE TABLE IF NOT EXISTS match_predictions (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        predicted_winner VARCHAR(50) NOT NULL,
        score_argentina INT NOT NULL,
        score_spain INT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // 2. Add column IF IT DOES NOT EXIST (This is the critical fix)
    await pool.query(`
      ALTER TABLE match_predictions 
      ADD COLUMN IF NOT EXISTS organization VARCHAR(255);
    `);
    
    console.log('✅ PostgreSQL "match_predictions" schema verified.');
  } catch (err) {
    console.error('❌ Failed to initialize table:', err.message);
  }
}

// ─── Startup Connection Test ──────────────────────────────────────────────────
// When running locally (require.main), eagerly test the connection.
if (require.main === module) {
  pool.connect((err, client, release) => {
    if (err) {
      console.error('❌ PostgreSQL connection failed:', err.message);
    } else {
      console.log('✅ PostgreSQL connected successfully.');
      release();
      initializeDatabase();
    }
  });
}

// ─── Serverless-Safe Cached DB Initializer ────────────────────────────────────
// On Vercel (serverless), module-level async calls can silently fail before a
// request arrives. This runs the table check exactly once per cold start and is
// awaited by every /api route before the handler executes.
let _dbInitPromise = null;

function ensureDatabaseInitialized() {
  if (!_dbInitPromise) {
    _dbInitPromise = initializeDatabase().catch((err) => {
      _dbInitPromise = null; // allow retry on next request
      throw err;
    });
  }
  return _dbInitPromise;
}

async function dbInitMiddleware(req, res, next) {
  try {
    await ensureDatabaseInitialized();
    next();
  } catch (err) {
    console.error('❌ DB init middleware error:', err.message);
    res.status(500).json({ error: 'Database initialization failed. Please try again shortly.' });
  }
}

// ─── Core Middleware ──────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// All /api/* requests must pass through the DB init guard first
app.use('/api', dbInitMiddleware);

// ─── Static File Serving (local dev) ─────────────────────────────────────────
// On Vercel, the /public directory is served by the CDN — express.static is only
// used in local development.
app.use(express.static(path.join(__dirname, '..','public')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ─── Voting Window Middleware ─────────────────────────────────────────────────
// Allow submissions only between the configured open/close times.
function checkVotingWindow(req, res, next) {
  const now          = new Date();
  const allowedStart = new Date('2026-07-18T20:00:00+03:00');
  // Current setting: 22:00 (10:00 PM)
  const allowedEnd = new Date('2026-07-19T22:59:52+03:00');   

  if (now < allowedStart) {
    return res.status(403).json({ error: 'Predictions have not opened yet. Please check back later.' });
  }
  if (now > allowedEnd) {
    return res.status(403).json({ error: 'Voting is now closed! The match has kicked off.' });
  }
  next();
}

// ─── API: Submit Fan Prediction ───────────────────────────────────────────────
app.post('/api/predict', checkVotingWindow, async (req, res) => {
  // Add 'organization' to destructuring
  const { name, organization, predictedWinner, scoreArgentina, scoreSpain } = req.body;

  if (!name || !organization || !predictedWinner || scoreArgentina === undefined || scoreSpain === undefined) {
    return res.status(400).json({ error: 'Please provide all required fields, including organization.' });
  }

  try {
    await pool.query(
      `INSERT INTO match_predictions (name, organization, predicted_winner, score_argentina, score_spain)
       VALUES ($1, $2, $3, $4, $5)`,
      [name.trim(), organization.trim(), predictedWinner, parseInt(scoreArgentina, 10), parseInt(scoreSpain, 10)]
    );
    return res.status(200).json({ success: true, message: 'Prediction successfully locked in!' });
  } catch (err) {
    console.error('❌ /api/predict error:', err.message);
    return res.status(500).json({ error: 'Database error processing prediction.' });
  }
});

// ─── API: Live Poll Statistics ────────────────────────────────────────────────
app.get('/api/stats', async (req, res) => {
  try {
    const counts = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE predicted_winner = 'Argentina') AS argentina_votes,
         COUNT(*) FILTER (WHERE predicted_winner = 'Spain')     AS spain_votes,
         COUNT(*)                                               AS total_votes
       FROM match_predictions`
    );
    res.status(200).json({
      argentinaVotes: parseInt(counts.rows[0].argentina_votes || 0, 10),
      spainVotes:     parseInt(counts.rows[0].spain_votes     || 0, 10),
      totalVotes:     parseInt(counts.rows[0].total_votes     || 0, 10),
    });
  } catch (err) {
    console.error('❌ /api/stats error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── API: All Voters (Staff View) ─────────────────────────────────────────────
// ─── API: All Voters (Staff View) ─────────────────────────────────────────────
app.get('/api/voters', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT name, organization, predicted_winner, score_argentina, score_spain, created_at
       FROM match_predictions ORDER BY created_at DESC`
    );
    res.status(200).json({ success: true, voters: result.rows });
  } catch (err) {
    console.error('❌ /api/voters error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── API: Calculate Top 5 Winners ─────────────────────────────────────────────
// ─── API: Calculate Top 5 Winners ─────────────────────────────────────────────
app.post('/api/calculate-winners', async (req, res) => {
  const { actualWinner, actualScoreArgentina, actualScoreSpain } = req.body;

  if (!actualWinner || actualScoreArgentina === undefined || actualScoreSpain === undefined) {
    return res.status(400).json({ error: 'Missing actual final match result parameters.' });
  }

  const actArg = parseInt(actualScoreArgentina, 10);
  const actSpa = parseInt(actualScoreSpain, 10);

  try {
    const topPredictions = await pool.query(
      `SELECT name, predicted_winner, score_argentina, score_spain,
              (ABS(score_argentina - $1) + ABS(score_spain - $2)) AS score_error
       FROM match_predictions
       WHERE predicted_winner = $3
       ORDER BY score_error ASC, created_at ASC
       LIMIT 5`,
      [actArg, actSpa, actualWinner]
    );
    res.status(200).json({ success: true, winners: topPredictions.rows });
  } catch (err) {
    console.error('❌ /api/calculate-winners error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
// ─── API: Health Check ────────────────────────────────────────────────────────
app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.status(200).json({ status: 'ok', db: 'connected' });
  } catch (err) {
    res.status(500).json({ status: 'error', db: err.message });
  }
});

// ─── Server Entry Point (local dev only) ─────────────────────────────────────
if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () =>
    console.log(`🚀 Prediction Engine live on port ${PORT}`)
  );
}

module.exports = app;