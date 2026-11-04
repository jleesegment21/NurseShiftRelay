require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const twilio = require('twilio');
const { WebSocketServer } = require('ws');

const voiceRoute = require('./routes/voice');
const actionRoute = require('./routes/action');
const statusRoute = require('./routes/status');
const campaignRoute = require('./routes/campaign');
const labRoute = require('./routes/lab');
const lab = require('./services/labBus');
const { handleRelayConnection } = require('./websocket/relayHandler');

const PORT = process.env.PORT || 3000;
const SERVER_URL = process.env.SERVER_URL || '';

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Twilio webhooks: verify X-Twilio-Signature against the public tunnel URL
const twilioWebhook = twilio.webhook({
  validate: process.env.VALIDATE_TWILIO_SIGNATURE !== 'false',
  protocol: 'https',
  host: SERVER_URL ? new URL(SERVER_URL).host : undefined,
});

// Admin API: shared-secret header when ADMIN_API_KEY is set
function requireApiKey(req, res, next) {
  const key = process.env.ADMIN_API_KEY;
  if (key && req.get('x-api-key') !== key) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// Mirror every Twilio webhook (params in, TwiML out) to the Lab UI
function labCapture(req, res, next) {
  const send = res.send.bind(res);
  res.send = (body) => {
    lab.emit('http', {
      callSid: req.body?.CallSid,
      method: req.method,
      path: req.originalUrl,
      params: { ...req.query, ...req.body },
      status: res.statusCode,
      response: typeof body === 'string' ? body : '',
    });
    return send(body);
  };
  next();
}

// The Lab exposes live transcripts and config: only serve it to this machine,
// never to requests arriving through the tunnel (which carry forwarding headers).
function localOnly(req, res, next) {
  const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
  const forwarded = req.get('cf-connecting-ip') || req.get('x-forwarded-for');
  if (!loopback || forwarded) return res.status(404).end();
  next();
}

app.use('/voice', labCapture, twilioWebhook, voiceRoute);
app.use('/action', labCapture, twilioWebhook, actionRoute);
app.use('/status', labCapture, twilioWebhook, statusRoute);
app.use('/lab/api', localOnly, labRoute);
app.use('/lab', localOnly, express.static(path.join(__dirname, 'public', 'lab')));
app.use('/', requireApiKey, campaignRoute);

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'Nurse Shift Relay' }));

const server = http.createServer(app);

// WebSocket server — ConversationRelay connects here at /ws
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const { pathname } = new URL(request.url, 'http://localhost');
  if (pathname === '/ws') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

wss.on('connection', (ws, request) => {
  lab.emit('session', { event: 'connected' });
  handleRelayConnection(ws);
});

server.listen(PORT, () => {
  console.log(`[Nurse Shift Relay] Server listening on port ${PORT}`);
  console.log(`[Nurse Shift Relay] Inbound voice webhook: ${SERVER_URL}/voice`);
  console.log(`[Nurse Shift Relay] WebSocket:             ${SERVER_URL.replace('https', 'wss')}/ws`);
  console.log(`[Nurse Shift Relay] Start a campaign:      POST ${SERVER_URL}/campaign/<shiftId>/start`);
  console.log(`[Nurse Shift Relay] ConversationRelay Lab: http://localhost:${PORT}/lab`);
});
