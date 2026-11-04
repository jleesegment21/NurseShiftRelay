const express = require('express');
const staffing = require('../services/staffing');
const campaign = require('../services/campaign');

const router = express.Router();

// GET /shifts — open/filled shifts with eligible nurse counts
router.get('/shifts', (req, res) => {
  res.json(
    staffing.listShifts().map((s) => ({
      ...s,
      description: staffing.describeShift(s),
      eligibleNurses: staffing.eligibleNurses(s).length,
      campaign: campaign.getCampaign(s.id)?.status || null,
    }))
  );
});

// POST /campaign/:shiftId/start — begin calling nurses for a shift
router.post('/campaign/:shiftId/start', async (req, res) => {
  try {
    res.json(await campaign.startCampaign(req.params.shiftId));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// GET /campaign/:shiftId — live campaign progress
router.get('/campaign/:shiftId', (req, res) => {
  const summary = campaign.getCampaign(req.params.shiftId);
  if (!summary) return res.status(404).json({ error: 'No campaign for this shift' });
  res.json(summary);
});

module.exports = router;
