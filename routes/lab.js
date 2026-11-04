const crypto = require('crypto');
const express = require('express');

const lab = require('../services/labBus');
const staffing = require('../services/staffing');
const campaign = require('../services/campaign');
const relayConfig = require('../services/relayConfig');
const { placeShiftCall, getNumberConfig } = require('../services/twilio');
const { buildRelayTwiml } = require('./voice');
const { buildActionTwiml } = require('./action');

/**
 * ConversationRelay Lab API — powers the learning UI at /lab.
 * Mounted behind localOnly() in server.js: never reachable through the tunnel.
 */
const router = express.Router();

// GET /lab/api/events — Server-Sent Events: replay recent events, then stream live
router.get('/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  lab.recent().forEach(send);
  const unsubscribe = lab.subscribe(send);
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => {
    unsubscribe();
    clearInterval(keepAlive);
  });
});

router.post('/events/clear', (req, res) => {
  lab.clear();
  res.json({ ok: true });
});

// GET /lab/api/status — what's configured, so the UI can say what will work
router.get('/status', (req, res) => {
  res.json({
    openai: Boolean(process.env.OPENAI_API_KEY),
    twilio: Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER),
    twilioNumber: process.env.TWILIO_PHONE_NUMBER || null,
    coordinator: Boolean(process.env.STAFFING_COORDINATOR_NUMBER),
    serverUrl: process.env.SERVER_URL || null,
    tunnelLooksReal: /^https:\/\/(?!your-tunnel)/.test(process.env.SERVER_URL || ''),
    validateSignature: process.env.VALIDATE_TWILIO_SIGNATURE !== 'false',
    hospital: process.env.HOSPITAL_NAME || 'the hospital',
    agent: process.env.AGENT_NAME || 'Ava',
  });
});

// GET /lab/api/callbacks — every URL Twilio calls for this app, and who configures it.
// Inbound URLs come from the number's Console config (read via REST); outbound ones
// are set by this app's code. Nothing is sent anywhere — this only reads config.
router.get('/callbacks', async (req, res) => {
  const serverUrl = process.env.SERVER_URL || '';
  const wsUrl = serverUrl.replace(/^https/, 'wss').replace(/^http/, 'ws');
  let number = null;
  let error = null;
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER) {
    try {
      number = await getNumberConfig();
      if (!number) error = `${process.env.TWILIO_PHONE_NUMBER} isn't on this Twilio account`;
    } catch (err) {
      error = err.message;
    }
  } else {
    error = 'Twilio credentials not set in .env';
  }

  const hostOf = (u) => {
    try {
      return new URL(u).host;
    } catch {
      return null;
    }
  };
  const owner = (u) => (!u ? 'unset' : serverUrl && hostOf(u) === hostOf(serverUrl) ? 'app' : 'external');
  const callbacks = [
    {
      name: 'A call comes in',
      flow: 'inbound',
      setIn: 'Twilio Console → Phone number → Voice Configuration',
      url: number?.voiceUrl,
      method: number?.voiceMethod,
      expected: `${serverUrl}/voice`,
      purpose: 'Twilio asks for TwiML when someone calls your number. This app answers with <Connect><ConversationRelay> for known nurses.',
    },
    {
      name: 'Call status changes',
      flow: 'inbound',
      setIn: 'Twilio Console → Phone number → Voice Configuration',
      url: number?.statusCallback,
      method: number?.statusCallbackMethod,
      purpose: 'Twilio posts the lifecycle of calls TO your number (e.g. completed, with duration) here. It goes straight from Twilio to this URL; this app never sees it.',
    },
    {
      name: 'Primary handler fails',
      flow: 'inbound',
      setIn: 'Twilio Console → Phone number → Voice Configuration',
      url: number?.voiceFallbackUrl,
      method: 'POST',
      purpose: 'Backup TwiML if "A call comes in" errors or times out. Worth setting in production so callers never hear an application error.',
    },
    {
      name: 'Url (answer webhook)',
      flow: 'outbound',
      setIn: 'App code: calls.create() in services/twilio.js',
      url: `${serverUrl}/voice/outbound?nurseId=…&shiftId=…`,
      method: 'POST',
      purpose: 'Fetched when the nurse answers (after answering machine detection). Returns the ConversationRelay TwiML or a voicemail <Say>.',
    },
    {
      name: 'StatusCallback',
      flow: 'outbound',
      setIn: 'App code: calls.create() in services/twilio.js',
      url: `${serverUrl}/status`,
      method: 'POST',
      purpose: 'Final status of each campaign call (no-answer, busy, completed…). It frees a calling slot and dials the next nurse. Outbound REST calls only use this parameter; the Console status callback applies to inbound calls only.',
    },
    {
      name: '<Connect action>',
      flow: 'both',
      setIn: 'App TwiML: routes/voice.js',
      url: `${serverUrl}/action`,
      method: 'POST',
      purpose: 'Posted when the ConversationRelay session ends (SessionStatus, HandoffData). Returns <Dial> to transfer or <Hangup>.',
    },
    {
      name: '<ConversationRelay url>',
      flow: 'both',
      setIn: 'App TwiML: routes/voice.js',
      url: `${wsUrl}/ws`,
      method: 'WebSocket',
      purpose: 'The live conversation: setup, prompt, interrupt, text, end.',
    },
  ].map((c) => ({ ...c, owner: owner(c.url) }));

  const warnings = [];
  if (number && number.voiceUrl !== `${serverUrl}/voice`)
    warnings.push(`"A call comes in" is ${number.voiceUrl || 'empty'}, but this app expects ${serverUrl}/voice. Inbound calls won't reach it. Did the ngrok URL change?`);
  if (number?.voiceApplicationSid)
    warnings.push(`The number uses TwiML App ${number.voiceApplicationSid}, which overrides the URLs above.`);

  res.json({ serverUrl, number, error, callbacks, warnings });
});

// Staffing data for pickers + campaign tab
router.get('/data', (req, res) => {
  res.json({
    nurses: staffing.listNurses(),
    shifts: staffing.listShifts().map((s) => ({
      ...s,
      description: staffing.describeShift(s),
      eligible: staffing.eligibleNurses(s).map((n) => n.id),
    })),
    campaigns: campaign.listCampaigns(),
  });
});

router.post('/reset-data', (req, res) => {
  staffing.reset();
  campaign.reset();
  lab.emit('system', { message: 'Staffing data reset to seed/*.json' });
  res.json({ ok: true });
});

// Parameter Playground
router.get('/params', (req, res) => res.json(relayConfig.PARAMS));
router.get('/config', (req, res) => res.json(relayConfig.snapshot(staffing.getShift(req.query.shiftId))));
router.put('/config', (req, res) => {
  const snapshot = relayConfig.setOverrides(req.body?.overrides);
  lab.emit('config', { overrides: snapshot.overrides });
  res.json(snapshot);
});

// ─── Browser simulator: the page plays the part of Twilio ────────────────────

// Returns exactly the TwiML Twilio would get for an answered outbound call.
router.post('/sim/start', (req, res) => {
  const nurse = staffing.getNurse(req.body.nurseId);
  const shift = staffing.getShift(req.body.shiftId);
  if (!nurse || !shift) return res.status(400).json({ error: 'Unknown nurse or shift' });
  if (shift.status !== 'open') return res.status(409).json({ error: `Shift ${shift.id} is already ${shift.status}. Reset data or pick another shift.` });

  const callSid = `CA${crypto.randomBytes(16).toString('hex')}`;
  const twiml = buildRelayTwiml({ nurse, shift, direction: 'outbound' });
  const params = {
    CallSid: callSid,
    AccountSid: process.env.TWILIO_ACCOUNT_SID || 'ACsimulated',
    From: process.env.TWILIO_PHONE_NUMBER || '+15550000000',
    To: nurse.phone,
    Direction: 'outbound-api',
    CallStatus: 'in-progress',
    AnsweredBy: 'human',
    nurseId: nurse.id,
    shiftId: shift.id,
  };
  lab.emit('http', {
    simulated: true,
    callSid,
    method: 'POST',
    path: `/voice/outbound?nurseId=${nurse.id}&shiftId=${shift.id}`,
    params,
    status: 200,
    response: twiml,
  });
  res.json({ callSid, twiml, from: params.From, to: params.To });
});

// What Twilio does when the session ends: POST the action URL, run the returned TwiML.
router.post('/sim/action', (req, res) => {
  const body = { ...req.body };
  const twiml = buildActionTwiml(body);
  lab.emit('http', { simulated: true, callSid: body.CallSid, method: 'POST', path: '/action', params: body, status: 200, response: twiml });
  res.json({ twiml });
});

// ─── Real calls ──────────────────────────────────────────────────────────────

// Call *your* phone, playing the part of a nurse from the roster
router.post('/call-me', async (req, res) => {
  const nurse = staffing.getNurse(req.body.nurseId);
  const shift = staffing.getShift(req.body.shiftId);
  const phone = String(req.body.phone || '').replace(/[^\d+]/g, '');
  if (!nurse || !shift) return res.status(400).json({ error: 'Unknown nurse or shift' });
  if (!/^\+\d{8,15}$/.test(phone)) return res.status(400).json({ error: 'Phone must be E.164, e.g. +14155551234' });
  try {
    const call = await placeShiftCall({ ...nurse, phone }, shift);
    res.json({ callSid: call.sid, status: call.status });
  } catch (err) {
    res.status(502).json({ error: err.message, code: err.code });
  }
});

router.post('/campaign/:shiftId/start', async (req, res) => {
  try {
    res.json(await campaign.startCampaign(req.params.shiftId));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
