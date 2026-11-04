const express = require('express');
const twilio = require('twilio');

const staffing = require('../services/staffing');
const campaign = require('../services/campaign');
const relayConfig = require('../services/relayConfig');

const router = express.Router();

function hospital() {
  return process.env.HOSPITAL_NAME || 'the hospital';
}

function agentName() {
  return process.env.AGENT_NAME || 'Ava';
}

function greetingFor(nurse, direction) {
  return direction === 'outbound'
    ? `Hi, this is ${agentName()}, an automated assistant calling from the staffing office at ${hospital()}. Am I speaking with ${nurse.firstName}?`
    : `Thanks for calling the staffing office at ${hospital()}. This is ${agentName()}, an automated assistant. Am I speaking with ${nurse.firstName}?`;
}

/**
 * Append <Connect><ConversationRelay> for a shift-offer conversation.
 * Attributes come from services/relayConfig.js (editable in the Lab's Parameter Playground).
 */
function connectRelay(response, { nurse, shift, direction }) {
  const serverUrl = process.env.SERVER_URL || '';
  const wsUrl = serverUrl.replace(/^https/, 'wss').replace(/^http/, 'ws');
  const greeting = greetingFor(nurse, direction);

  const connect = response.connect({ action: `${serverUrl}/action` });
  const relay = connect.conversationRelay({
    url: `${wsUrl}/ws`,
    welcomeGreeting: greeting,
    ...relayConfig.attributes(shift),
  });
  relay.parameter({ name: 'nurseId', value: nurse.id });
  relay.parameter({ name: 'shiftId', value: shift.id });
  relay.parameter({ name: 'direction', value: direction });
  relay.parameter({ name: 'greeting', value: greeting });
}

/**
 * TwiML for an answered call. Shared by the real webhook and the Lab simulator.
 */
function buildRelayTwiml({ nurse, shift, direction }) {
  const response = new twilio.twiml.VoiceResponse();
  connectRelay(response, { nurse, shift, direction });
  return response.toString();
}

// Outbound: Twilio requests this once the nurse's phone is answered (after AMD).
router.post('/outbound', (req, res) => {
  const { nurseId, shiftId } = req.query;
  const callSid = req.body.CallSid;
  const answeredBy = req.body.AnsweredBy || 'unknown';
  const nurse = staffing.getNurse(nurseId);
  const shift = staffing.getShift(shiftId);

  campaign.markAnswered(callSid);
  const response = new twilio.twiml.VoiceResponse();

  if (!nurse || !shift) {
    response.hangup();
  } else if (answeredBy.startsWith('machine') || answeredBy === 'fax') {
    // Voicemail: keep it generic — anyone with access to the mailbox can hear it
    response.say(
      { voice: 'Polly.Joanna-Neural' },
      `Hi ${nurse.firstName}, this is the staffing office at ${hospital()} with an open shift opportunity. ` +
        `If you're interested, please call us back at this number. Thank you!`
    );
    response.hangup();
    campaign.recordOutcome(callSid, { shiftId, nurseId, outcome: 'voicemail' });
  } else if (shift.status !== 'open') {
    // Someone else accepted while this phone was ringing
    response.say(
      { voice: 'Polly.Joanna-Neural' },
      `Hi ${nurse.firstName}, this is the staffing office at ${hospital()}. ` +
        `We were calling about an open shift, but it has just been filled. Thanks so much, and have a great day.`
    );
    response.hangup();
    campaign.recordOutcome(callSid, { shiftId, nurseId, outcome: 'filled-before-answer' });
  } else {
    connectRelay(response, { nurse, shift, direction: 'outbound' });
  }

  res.type('text/xml');
  res.send(response.toString());
});

// Inbound: nurse calling the hospital number back after a missed call or voicemail.
router.post('/', (req, res) => {
  const nurse = staffing.findNurseByPhone(req.body.From);
  const shift = nurse && campaign.findShiftForCallback(nurse.id);
  const response = new twilio.twiml.VoiceResponse();

  if (nurse && shift) {
    connectRelay(response, { nurse, shift, direction: 'inbound' });
  } else {
    response.say(
      { voice: 'Polly.Joanna-Neural' },
      `Thanks for calling the staffing office at ${hospital()}. Connecting you to the staffing coordinator.`
    );
    response.dial(process.env.STAFFING_COORDINATOR_NUMBER);
  }

  res.type('text/xml');
  res.send(response.toString());
});

module.exports = router;
module.exports.buildRelayTwiml = buildRelayTwiml;
