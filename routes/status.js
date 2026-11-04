const express = require('express');
const campaign = require('../services/campaign');

const router = express.Router();

// Outbound call status callback — frees the slot so the next nurse gets dialed.
router.post('/', async (req, res) => {
  const { CallSid, CallStatus, AnsweredBy } = req.body;
  console.log(`[Status] ${CallSid} → ${CallStatus}${AnsweredBy ? ` (${AnsweredBy})` : ''}`);
  res.sendStatus(204);
  await campaign.onCallStatus(CallSid, CallStatus).catch((err) =>
    console.error('[Status] Error advancing campaign:', err.message)
  );
});

module.exports = router;
