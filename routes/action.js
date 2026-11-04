const express = require('express');
const twilio = require('twilio');

const router = express.Router();

/**
 * TwiML to run after <Connect><ConversationRelay> ends.
 * HandoffData is whatever the relay handler sent in its "end" message.
 * Shared by the real webhook and the Lab simulator.
 */
function buildActionTwiml({ CallSid, SessionStatus, HandoffData, ErrorCode, ErrorMessage }) {
  let handoff = {};
  try {
    handoff = JSON.parse(HandoffData || '{}');
  } catch {
    // Non-JSON handoff — treat as hangup
  }

  const response = new twilio.twiml.VoiceResponse();
  const transfer = () =>
    response.dial({ callerId: process.env.TWILIO_PHONE_NUMBER }, process.env.STAFFING_COORDINATOR_NUMBER);

  if (SessionStatus === 'failed') {
    console.error(`[Action] Session failed for ${CallSid}: ${ErrorCode} ${ErrorMessage}`);
    response.say(
      { voice: 'Polly.Joanna-Neural' },
      "Sorry, we're having technical trouble. Connecting you to the staffing coordinator."
    );
    transfer();
  } else if (handoff.action === 'transfer') {
    console.log(`[Action] Transferring ${CallSid} to staffing coordinator: ${handoff.reason}`);
    transfer();
  } else {
    response.hangup();
  }

  return response.toString();
}

router.post('/', (req, res) => {
  res.type('text/xml');
  res.send(buildActionTwiml(req.body));
});

module.exports = router;
module.exports.buildActionTwiml = buildActionTwiml;
