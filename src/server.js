const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const config = require('./config');
const { migrate } = require('./db');
const { requireAuth } = require('./middleware');
const { startJobs } = require('./jobs');

const app = express();
app.set('trust proxy', 1);
// Acessado por http (IP da rede interna): não força HTTPS nos arquivos do front
const isHttps = config.appUrl.startsWith('https');
app.use(helmet({
  hsts: isHttps,
  crossOriginOpenerPolicy: isHttps,
  originAgentCluster: isHttps,
  contentSecurityPolicy: {
    directives: {
      upgradeInsecureRequests: isHttps ? [] : null,
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      scriptSrc: ["'self'"],
    },
  },
}));
app.use(express.json({ limit: '200kb' }));
app.use(cookieParser());

app.use('/api/auth', require('./routes/auth'));
app.use('/api/users', requireAuth, require('./routes/users'));
app.use('/api/rooms', requireAuth, require('./routes/rooms'));
app.use('/api/bookings', requireAuth, require('./routes/bookings'));
app.use('/api/checkin', requireAuth, require('./routes/checkin'));
app.use('/api/notifications', requireAuth, require('./routes/notifications'));
app.use('/api/admin', requireAuth, require('./routes/admin'));
app.get('/api/health', (req, res) => res.json({ ok: true }));

const pub = path.join(__dirname, '..', 'public');
app.use(express.static(pub, { index: 'index.html' }));
app.get('/app', (req, res) => res.sendFile(path.join(pub, 'app.html')));
app.get('/checkin', (req, res) => res.sendFile(path.join(pub, 'checkin.html')));
app.use('/vendor/jsqr', express.static(path.join(__dirname, '..', 'node_modules', 'jsqr', 'dist')));

app.use('/api', (req, res) => res.status(404).json({ error: 'Rota não encontrada' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Erro interno. Tente novamente.' : err.message });
});

(async () => {
  await migrate();
  startJobs();
  app.listen(config.port, () => console.log(`VR Salas rodando em ${config.appUrl} (porta ${config.port})`));
})().catch((e) => {
  console.error('Falha ao iniciar:', e);
  process.exit(1);
});
