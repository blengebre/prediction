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
// ─── Security & Static Middleware ───────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;"
  );
  next();
});

// Explicitly handle favicon.ico to prevent 404 errors in the console
app.get('/favicon.ico', (req, res) => res.status(204).end());

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
    await pool.query(`
      ALTER TABLE match_predictions 
      ADD COLUMN IF NOT EXISTS feedback TEXT;
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
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});
// ─── Static File Serving (local dev) ─────────────────────────────────────────
// On Vercel, the /public directory is served by the CDN — express.static is only
// used in local development.
// 1. Remove: app.get('/', (req, res) => { ... }); (if it exists)
// 2. Keep the static middleware for assets, but we will make index.html inaccessible via the root
app.use(express.static(path.join(__dirname, '..', 'public'), { index: false }));

// ─── Route: Public Predictor (RESTRICTED) ───────────────────────────────────
app.post('/api/feedback', async (req, res) => {
  const { name, message } = req.body;

  if (!name || !message) {
    return res.status(400).json({ error: 'Please provide both name and message.' });
  }

  try {
    // Check if the user exists in the predictions table
    const checkUser = await pool.query(
      'SELECT id FROM match_predictions WHERE name ILIKE $1 ORDER BY created_at DESC LIMIT 1',
      [name.trim()]
    );

    if (checkUser.rows.length > 0) {
      // User found: Update the feedback column for that user
      await pool.query(
        'UPDATE match_predictions SET feedback = $1 WHERE id = $2',
        [message.trim(), checkUser.rows[0].id]
      );
    } else {
      // User not found: Insert new row with feedback, set others to placeholders
      await pool.query(
        `INSERT INTO match_predictions (name, feedback, predicted_winner, score_argentina, score_spain, organization) 
         VALUES ($1, $2, 'N/A', 0, 0, 'N/A')`,
        [name.trim(), message.trim()]
      );
    }

    return res.status(200).json({ success: true, message: 'Feedback saved!' });
  } catch (err) {
    console.error('❌ /api/feedback error:', err.message);
    return res.status(500).json({ error: 'Database error.' });
  }
});

// ─── Routes: Staff Portals (UNRESTRICTED) ───────────────────────────────────
app.get('/staff', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'staff.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'dashboard.html'));
});

// ─── Route: Thank You / Feedback Page ────────────────────────────────────────
app.get('/thank-you', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'thank-you.html'));
});

// ─── API: Submit Fan Prediction ───────────────────────────────────────────────
app.post('/api/predict', async (req, res) => {
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
app.post('/api/calculate-winners', async (req, res) => {
  const { actualWinner, actualScoreArgentina, actualScoreSpain } = req.body;

  if (!actualWinner || actualScoreArgentina === undefined || actualScoreSpain === undefined) {
    return res.status(400).json({ error: 'Missing result parameters.' });
  }

  const rArg = parseInt(actualScoreArgentina, 10);
  const rSpa = parseInt(actualScoreSpain, 10);
  const rWinner = actualWinner;

  try {
    const { rows } = await pool.query('SELECT * FROM match_predictions');

    const ranked = rows.map(p => {
      let points = 0;
      const pArg = p.score_argentina;
      const pSpa = p.score_spain;
      const pWinner = pArg > pSpa ? 'Argentina' : (pSpa > pArg ? 'Spain' : 'Draw');

      // Scoring Logic
      if (pArg === rArg && pSpa === rSpa) points += 1000;
      if (pWinner === rWinner) points += 300;
      if ((pArg - pSpa) === (rArg - rSpa)) points += 200;
      if ((pArg + pSpa) === (rArg + rSpa)) points += 100;

      const totalError = Math.abs(pArg - rArg) + Math.abs(pSpa - rSpa);
      points -= (totalError * 20);

      return { ...p, points };
    });

    // REFINED SORTING:
    // 1. Higher points first
    // 2. If points are tied, earliest submission (created_at ASC) wins
    ranked.sort((a, b) => {
      if (b.points !== a.points) {
        return b.points - a.points;
      }
      return new Date(a.created_at) - new Date(b.created_at);
    });

    res.status(200).json({ success: true, winners: ranked.slice(0, 5) });
  } catch (err) {
    console.error('❌ /api/calculate-winners error:', err.message);
    res.status(500).json({ error: 'Database calculation error.' });
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