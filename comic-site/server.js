require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const compression = require('compression');
const { initDb } = require('./database/db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(compression());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// Cache static assets (CSS, JS, images) for 7 days in browsers
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '7d' }));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use('/api', require('./routes/comics'));
app.use('/api/admin', require('./routes/admin'));

app.get('/comic/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'comic.html')));
app.get('/reader/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'reader.html')));
app.get('/browse', (req, res) => res.sendFile(path.join(__dirname, 'public', 'browse.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

initDb()
  .then(() => app.listen(PORT, () => {
    console.log(`\n Comic Site running at http://localhost:${PORT}`);
    console.log(` Admin panel: http://localhost:${PORT}/admin\n`);
  }))
  .catch(err => { console.error('Failed to connect to database:', err.message); process.exit(1); });
