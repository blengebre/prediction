require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── PostgreSQL Connection Pool ────────────────────────────────────────────────
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
      database: process.env.DB_NAME     || 'rsvp',
    };

const pool = new Pool(poolConfig);

// Initialize Tables
async function initializeDatabase() {
  const createTableSQL = `
    CREATE TABLE IF NOT EXISTS match_predictions (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) NOT NULL UNIQUE,
      organization VARCHAR(255) DEFAULT '',
      predicted_winner VARCHAR(50) NOT NULL,
      score_argentina INT NOT NULL,
      score_spain INT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `;
  try {
    await pool.query(createTableSQL);
    console.log('✅ PostgreSQL "match_predictions" table verified.');
  } catch (err) {
    console.error('❌ Database init error:', err.message);
  }
}
initializeDatabase();

app.use(cors());
app.use(express.json());

// ─── Static Routing Engine Patch (Local Host Fallbacks) ────────────────────────
// Serves static assets seamlessly from the new /public folder when running locally
app.use(express.static(path.join(__dirname, 'public')));

// Explicit fallback rule to guarantee index.html resolves correctly at the root path '/'
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});


// ─── Middleware: Enforce Custom Active Match Timeline ────────────────────────
function checkVotingWindow(req, res, next) {
  const now = new Date();
  
  // Set timeframe window: Open NOW (July 18) until Sunday Night Kickoff (July 19 at 10:00 PM EAT)
  const allowedStart = new Date('2026-07-18T20:00:00+03:00'); // Open immediately (Set to earlier tonight)
  const allowedEnd = new Date('2026-07-19T22:00:00+03:00');   // Match Kickoff Sunday 10:00 PM EAT

  if (now < allowedStart) {
    return res.status(403).json({ error: 'Predictions have not opened yet.' });
  }
  if (now > allowedEnd) {
    return res.status(403).json({ error: 'Voting is now closed! The match has kicked off.' });
  }
  next();
}

// ─── API: Submit Fan Prediction ───────────────────────────────────────────────
app.post('/api/predict', checkVotingWindow, async (req, res) => {
  const { name, email, organization, predictedWinner, scoreArgentina, scoreSpain } = req.body;

  if (!name || !email || !predictedWinner || scoreArgentina === undefined || scoreSpain === undefined) {
    return res.status(400).json({ error: 'Please provide all required fields and scores.' });
  }

  try {
    // Save submission to database
    await pool.query(
      `INSERT INTO match_predictions (name, email, organization, predicted_winner, score_argentina, score_spain)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [name.trim(), email.trim().toLowerCase(), (organization || '').trim(), predictedWinner, parseInt(scoreArgentina), parseInt(scoreSpain)]
    );

    return res.status(200).json({ success: true, message: 'Prediction successfully locked in!' });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ error: 'This email address has already submitted a prediction!' });
    }
    console.error(err);
    return res.status(500).json({ error: 'Database error processing prediction.' });
  }
});

// ─── API: Get Live Poll Statistics (Total Counts & Distribution) ──────────────
app.get('/api/stats', async (req, res) => {
  try {
    const counts = await pool.query(
      `SELECT 
         COUNT(*) FILTER (WHERE predicted_winner = 'Argentina') as argentina_votes,
         COUNT(*) FILTER (WHERE predicted_winner = 'Spain') as spain_votes,
         COUNT(*) as total_votes
       FROM match_predictions`
    );
    
    res.status(200).json({
      argentinaVotes: parseInt(counts.rows[0].argentina_votes || 0),
      spainVotes: parseInt(counts.rows[0].spain_votes || 0),
      totalVotes: parseInt(counts.rows[0].total_votes || 0)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── API: Get All Historical Voters (Staff Directory View) ───────────────────
app.get('/api/voters', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT name, organization, predicted_winner, score_argentina, score_spain, created_at 
       FROM match_predictions ORDER BY created_at DESC`
    );
    res.status(200).json({ success: true, voters: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── API: Calculate Top 5 Winners Based on Exact/Approximate Scores ───────────
app.post('/api/calculate-winners', async (req, res) => {
  const { actualWinner, actualScoreArgentina, actualScoreSpain } = req.body;

  if (!actualWinner || actualScoreArgentina === undefined || actualScoreSpain === undefined) {
    return res.status(400).json({ error: 'Missing actual final match results parameters.' });
  }

  const actArg = parseInt(actualScoreArgentina);
  const actSpa = parseInt(actualScoreSpain);

  try {
    // SQL query calculates absolute mathematical deviation error distance:
    // Error = Absolute(Predicted_Arg - Actual_Arg) + Absolute(Predicted_Spa - Actual_Spa)
    // Filters only those who picked the correct team winner, sorting by lowest error rate first.
    const topPredictions = await pool.query(
      `SELECT name, organization, email, predicted_winner, score_argentina, score_spain,
       (ABS(score_argentina - $1) + ABS(score_spain - $2)) as score_error
       FROM match_predictions
       WHERE predicted_winner = $3
       ORDER BY score_error ASC, created_at ASC
       LIMIT 5`,
      [actArg, actSpa, actualWinner]
    );

    res.status(200).json({ success: true, winners: topPredictions.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Prediction Engine live on port ${PORT}`));
module.exports = app;