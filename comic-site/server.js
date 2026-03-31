const express = require('express');
const path = require('path');
const cors = require('cors');
const fs = require('fs');

require('./database/db');

const app = express();
const PORT = process.env.PORT || 3000;

['uploads/covers', 'uploads/comics', 'uploads/temp'].forEach(dir => {
  fs.mkdirSync(path.join(__dirname, dir), { recursive: true });
});

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.use('/api', require('./routes/comics'));
app.use('/api/admin', require('./routes/admin'));

app.get('/comic/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'comic.html')));
app.get('/reader/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'reader.html')));
app.get('/browse', (req, res) => res.sendFile(path.join(__dirname, 'public', 'browse.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

app.listen(PORT, () => {
  console.log(`\n Comic Site running at http://localhost:${PORT}`);
  console.log(` Admin panel: http://localhost:${PORT}/admin\n`);
});
