const staffing = require('../services/staffing');
const campaign = require('../services/campaign');
const { sendSms } = require('../services/twilio');

// ─── Tool handlers ────────────────────────────────────────────────────────────
// Each handler gets (args, context) where context.session is the relay session.

function record(session, outcome, notes, shiftId = session.shift.id) {
  session.outcome = outcome;
  campaign.recordOutcome(session.callSid, { shiftId, nurseId: session.nurse.id, outcome, notes });
}

async function acceptShift(args, { session }) {
  const shiftId = args.shift_id || session.shift.id;
  const shift = staffing.getShift(shiftId);
  if (!shift) return `There is no shift with ID ${shiftId}.`;

  const result = staffing.claimShift(shiftId, session.nurse.id);

  if (!result.ok && result.reason === 'filled') {
    record(session, 'accepted-but-filled', null, shiftId);
    return 'This shift was JUST filled by another nurse a moment ago. Apologize and thank them for being willing. Offer to put them on the standby list in case it reopens (add_to_standby), and offer to check other open shifts (list_other_open_shifts).';
  }
  if (!result.ok) {
    return `Could not assign this shift: ${result.detail || result.reason}. Tell the nurse you can't book it automatically and offer to transfer them to the staffing coordinator.`;
  }

  record(session, 'accepted', null, shiftId);
  campaign.onShiftFilled(shiftId);

  if (process.env.SEND_SMS_CONFIRMATION === 'true') {
    const hospital = process.env.HOSPITAL_NAME || 'Staffing';
    sendSms(
      session.nurse.phone,
      `${hospital} Staffing: You're confirmed for ${staffing.describeShift(shift)}. Thank you! Questions? Call ${process.env.TWILIO_PHONE_NUMBER}.`
    ).catch((err) => console.error('[Tool] Confirmation SMS failed:', err.message));
  }

  return `Booked. ${session.nurse.firstName} is confirmed for ${staffing.describeShift(shift)}.${
    process.env.SEND_SMS_CONFIRMATION === 'true' ? ' A text confirmation is on its way.' : ''
  } Thank them sincerely, then call end_call.`;
}

async function declineShift(args, { session }) {
  const notes = [args.reason, args.open_to_future_calls === false ? 'opted out of future shift calls' : null]
    .filter(Boolean)
    .join('; ');
  record(session, 'declined', notes);
  if (args.open_to_future_calls === false) staffing.setOptOut(session.nurse.id);
  return 'Decline recorded. Thank them, no pressure, then call end_call.';
}

async function addToStandby(args, { session }) {
  const shiftId = args.shift_id || session.shift.id;
  staffing.addStandby(shiftId, session.nurse.id);
  record(session, 'standby', null, shiftId);
  return 'Added to the standby list. Let them know staffing will reach out if the shift opens back up.';
}

async function listOtherOpenShifts(args, { session }) {
  const others = staffing.openShiftsFor(session.nurse).filter((s) => s.id !== session.shift.id);
  if (others.length === 0) return 'There are no other open shifts this nurse is eligible for right now.';
  return `Other open shifts this nurse is eligible for:\n${others
    .map((s) => `- ${s.id}: ${staffing.describeShift(s)}${s.incentive ? `, with ${s.incentive}` : ''}`)
    .join('\n')}\nIf they want one, call accept_shift with that shift_id.`;
}

async function requestCallback(args, { session }) {
  record(session, 'callback-requested', args.preferred_time);
  session.pendingEnd = { action: 'hangup' };
  return `Callback noted${args.preferred_time ? ` for ${args.preferred_time}` : ''}. Say they can also call this number back any time, then say goodbye.`;
}

async function transferToCoordinator(args, { session }) {
  if (!session.outcome) record(session, 'transferred', args.reason);
  session.pendingEnd = { action: 'transfer', reason: args.reason };
  return 'Tell them in one sentence that you are connecting them to the staffing coordinator now.';
}

async function endCall(args, { session }) {
  if (!session.outcome && args.reason !== 'completed') record(session, args.reason, args.notes);
  session.pendingEnd = { action: 'hangup' };
  return 'Say a brief, warm goodbye in one sentence.';
}

// ─── Tool definitions (OpenAI function schema) ────────────────────────────────

const toolDefinitions = [
  {
    type: 'function',
    function: {
      name: 'accept_shift',
      description:
        'Book the shift for this nurse. Only call after they clearly said yes AND confirmed the day and times you repeated back.',
      parameters: {
        type: 'object',
        properties: {
          shift_id: { type: 'string', description: 'Shift ID. Omit for the shift this call is about.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'decline_shift',
      description: 'Record that the nurse declined the shift.',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Reason if they volunteered one, e.g. "already working Saturday"' },
          open_to_future_calls: {
            type: 'boolean',
            description: 'false ONLY if the nurse asked not to receive shift calls anymore',
            default: true,
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_to_standby',
      description: 'Put the nurse on the standby list for a shift, in case it opens back up.',
      parameters: {
        type: 'object',
        properties: {
          shift_id: { type: 'string', description: 'Shift ID. Omit for the shift this call is about.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_other_open_shifts',
      description: 'List other open shifts this nurse is credentialed and oriented for.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'request_callback',
      description: 'The nurse confirmed their identity but it is a bad time to talk. Records a callback request and ends the call.',
      parameters: {
        type: 'object',
        properties: {
          preferred_time: { type: 'string', description: 'When they would like a call back, if given' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'transfer_to_coordinator',
      description:
        'Transfer the nurse to the human staffing coordinator: they asked for a person, asked something you cannot answer, or want to negotiate the shift.',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Brief reason for the transfer' },
        },
        required: ['reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'end_call',
      description: 'End the call. Call this once the conversation has reached an outcome, then say goodbye.',
      parameters: {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            enum: ['completed', 'wrong_person', 'no_decision'],
            description:
              '"completed" if accept/decline/standby was already recorded; "wrong_person" if the right nurse was not reached; "no_decision" otherwise',
          },
          notes: { type: 'string', description: 'Optional short note for the staffing office' },
        },
        required: ['reason'],
      },
    },
  },
];

// ─── Dispatcher ───────────────────────────────────────────────────────────────

const toolHandlers = {
  accept_shift: acceptShift,
  decline_shift: declineShift,
  add_to_standby: addToStandby,
  list_other_open_shifts: listOtherOpenShifts,
  request_callback: requestCallback,
  transfer_to_coordinator: transferToCoordinator,
  end_call: endCall,
};

/**
 * Execute a tool by name with given arguments.
 *
 * @param {string} name - Tool function name
 * @param {object} args - Parsed arguments from the model
 * @param {object} context - Runtime context ({ session })
 * @returns {Promise<string>} Result string to feed back to the model
 */
async function executeTool(name, args, context = {}) {
  const handler = toolHandlers[name];
  if (!handler) return `Unknown tool: ${name}`;
  try {
    return await handler(args, context);
  } catch (err) {
    console.error(`[Tool] Error executing ${name}:`, err.message);
    return `Tool execution failed: ${err.message}`;
  }
}

module.exports = { toolDefinitions, executeTool };
