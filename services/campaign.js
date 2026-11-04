const staffing = require('./staffing');
const { placeShiftCall, cancelCall } = require('./twilio');
const lab = require('./labBus');

/**
 * Shift-fill campaigns.
 *
 * For each open shift we ring eligible nurses CALL_CONCURRENCY at a time,
 * fewest-hours-first. Every time a call ends, the next nurse in the queue is
 * dialed, until someone accepts or the queue runs out. When a nurse accepts,
 * calls that are still ringing get cancelled. Nurses already in a
 * conversation are told the shift was just filled and offered standby.
 */

const TERMINAL_STATUSES = ['completed', 'busy', 'no-answer', 'failed', 'canceled'];

const campaigns = new Map(); // shiftId → campaign
const callIndex = new Map(); // callSid → { shiftId, nurseId, answered }

function concurrency() {
  return Math.max(1, parseInt(process.env.CALL_CONCURRENCY, 10) || 3);
}

async function startCampaign(shiftId) {
  const shift = staffing.getShift(shiftId);
  if (!shift) throw Object.assign(new Error(`Shift ${shiftId} not found`), { status: 404 });
  if (shift.status !== 'open') throw Object.assign(new Error(`Shift ${shiftId} is already ${shift.status}`), { status: 409 });

  const existing = campaigns.get(shiftId);
  if (existing?.status === 'running') return summarize(existing);

  // Restarting a campaign skips nurses who were already called for this shift
  const alreadyCalled = new Set((existing?.attempts || []).map((a) => a.nurseId));
  const campaign = {
    shiftId,
    status: 'running',
    startedAt: new Date().toISOString(),
    queue: staffing.eligibleNurses(shift).map((n) => n.id).filter((id) => !alreadyCalled.has(id)),
    active: new Set(),
    dialing: 0,
    attempts: existing?.attempts || [],
  };
  campaigns.set(shiftId, campaign);

  console.log(`[Campaign] ${shiftId} started — ${campaign.queue.length} eligible nurse(s) queued`);
  await dialNext(campaign);
  return summarize(campaign);
}

async function dialNext(campaign) {
  const shift = staffing.getShift(campaign.shiftId);

  while (
    campaign.status === 'running' &&
    shift.status === 'open' &&
    campaign.queue.length > 0 &&
    campaign.active.size + campaign.dialing < concurrency()
  ) {
    const nurse = staffing.getNurse(campaign.queue.shift());
    const attempt = { nurseId: nurse.id, callSid: null, status: 'dialing', outcome: null };
    campaign.attempts.push(attempt);
    campaign.dialing++; // reserve the slot before awaiting so parallel callbacks don't over-dial

    try {
      const call = await placeShiftCall(nurse, shift);
      attempt.callSid = call.sid;
      campaign.active.add(call.sid);
      callIndex.set(call.sid, { shiftId: shift.id, nurseId: nurse.id, answered: false });
      console.log(`[Campaign] ${shift.id} → dialing ${nurse.firstName} ${nurse.lastName} (${call.sid})`);
    } catch (err) {
      attempt.status = 'dial-failed';
      attempt.error = err.message;
      console.error(`[Campaign] Failed to dial ${nurse.id}:`, err.message);
    } finally {
      campaign.dialing--;
    }
  }

  if (campaign.status === 'running' && campaign.active.size === 0 && campaign.dialing === 0) {
    if (shift.status !== 'open') campaign.status = 'filled';
    else if (campaign.queue.length === 0) {
      campaign.status = 'exhausted';
      console.log(`[Campaign] ${shift.id} exhausted — no nurse accepted. Escalate to the staffing coordinator.`);
    }
  }
  notify(campaign);
}

function notify(campaign) {
  lab.emit('campaign', { shiftId: campaign.shiftId, summary: summarize(campaign) });
}

function markAnswered(callSid) {
  const entry = callIndex.get(callSid);
  if (entry) entry.answered = true;
}

/**
 * Status callback from Twilio. Frees the slot and dials the next nurse.
 */
async function onCallStatus(callSid, callStatus) {
  if (!TERMINAL_STATUSES.includes(callStatus)) return;
  const entry = callIndex.get(callSid);
  if (!entry) return; // inbound call or unknown

  const campaign = campaigns.get(entry.shiftId);
  callIndex.delete(callSid);
  if (!campaign) return;

  campaign.active.delete(callSid);
  const attempt = campaign.attempts.find((a) => a.callSid === callSid);
  if (attempt) {
    attempt.status = callStatus;
    if (!attempt.outcome && callStatus !== 'completed') {
      attempt.outcome = callStatus;
      staffing.logOutcome({ callSid, shiftId: entry.shiftId, nurseId: entry.nurseId, outcome: callStatus });
    }
  }

  await dialNext(campaign);
}

/**
 * Called once a nurse accepts. Stops the campaign and cancels calls still ringing.
 */
function onShiftFilled(shiftId) {
  const campaign = campaigns.get(shiftId);
  if (!campaign) return;
  campaign.status = 'filled';
  campaign.queue = [];
  notify(campaign);

  for (const callSid of campaign.active) {
    if (callIndex.get(callSid)?.answered) continue;
    cancelCall(callSid)
      .then(() => console.log(`[Campaign] ${shiftId} filled — cancelled ringing call ${callSid}`))
      .catch((err) => console.error(`[Campaign] Could not cancel ${callSid}:`, err.message));
  }
}

/**
 * Record a call outcome on the campaign (if any) and in data/outcomes.csv.
 */
function recordOutcome(callSid, { shiftId, nurseId, outcome, notes }) {
  const campaign = campaigns.get(shiftId);
  const attempt = campaign?.attempts.find((a) => a.callSid === callSid);
  if (attempt) attempt.outcome = outcome;
  staffing.logOutcome({ callSid, shiftId, nurseId, outcome, notes });
}

/**
 * When a nurse calls the hospital number back, find a still-open shift
 * we tried to reach them about.
 */
function findShiftForCallback(nurseId) {
  for (const campaign of [...campaigns.values()].reverse()) {
    const shift = staffing.getShift(campaign.shiftId);
    if (shift.status === 'open' && campaign.attempts.some((a) => a.nurseId === nurseId)) return shift;
  }
  return null;
}

function summarize(campaign) {
  const nameOf = (id) => {
    const n = staffing.getNurse(id);
    return n ? `${n.firstName} ${n.lastName}` : id;
  };
  return {
    shiftId: campaign.shiftId,
    status: campaign.status,
    startedAt: campaign.startedAt,
    filledBy: staffing.getShift(campaign.shiftId).filledBy,
    activeCalls: campaign.active.size,
    queued: campaign.queue.map(nameOf),
    attempts: campaign.attempts.map((a) => ({ ...a, nurse: nameOf(a.nurseId) })),
  };
}

function listCampaigns() {
  return [...campaigns.values()].map(summarize);
}

// Lab "reset data" — forget all campaigns (in-flight calls are left alone)
function reset() {
  campaigns.clear();
  callIndex.clear();
}

function getCampaign(shiftId) {
  const campaign = campaigns.get(shiftId);
  return campaign ? summarize(campaign) : null;
}

module.exports = {
  startCampaign,
  getCampaign,
  listCampaigns,
  reset,
  markAnswered,
  onCallStatus,
  onShiftFilled,
  recordOutcome,
  findShiftForCallback,
};
