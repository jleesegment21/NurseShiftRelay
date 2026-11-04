const twilio = require('twilio');
const lab = require('./labBus');

let client = null;
function getClient() {
  if (!client) client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  return client;
}

/**
 * Run a REST request and report it (request + response) to the Lab UI.
 * `params` uses Twilio's wire names so the Lab can render an equivalent curl.
 */
async function traced(method, resource, params, run, summarize = (r) => ({ sid: r.sid, status: r.status, to: r.to, from: r.from })) {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID || '$TWILIO_ACCOUNT_SID'}/${resource}`;
  try {
    const result = await run();
    lab.emit('rest', {
      callSid: result.sid?.startsWith('CA') ? result.sid : params.CallSid,
      method,
      url,
      params,
      response: summarize(result),
    });
    return result;
  } catch (err) {
    lab.emit('rest', { callSid: params.CallSid, method, url, params, error: { status: err.status, code: err.code, message: err.message } });
    throw err;
  }
}

/**
 * Place an outbound call to a nurse about an open shift.
 * Answering machine detection waits for the beep so voicemails are left cleanly;
 * Twilio posts AnsweredBy to /voice/outbound once it knows.
 *
 * @returns {Promise<object>} Twilio call resource
 */
async function placeShiftCall(nurse, shift) {
  const serverUrl = process.env.SERVER_URL;
  const query = new URLSearchParams({ nurseId: nurse.id, shiftId: shift.id });
  const options = {
    to: nurse.phone,
    from: process.env.TWILIO_PHONE_NUMBER,
    url: `${serverUrl}/voice/outbound?${query}`,
    machineDetection: 'DetectMessageEnd',
    timeout: 25,
    statusCallback: `${serverUrl}/status`,
    statusCallbackEvent: ['completed'],
  };

  return traced(
    'POST',
    'Calls.json',
    {
      To: options.to,
      From: options.from,
      Url: options.url,
      MachineDetection: options.machineDetection,
      Timeout: options.timeout,
      StatusCallback: options.statusCallback,
      StatusCallbackEvent: 'completed',
    },
    () => getClient().calls.create(options)
  );
}

/**
 * Cancel a call that hasn't been answered yet (queued/ringing).
 */
async function cancelCall(callSid) {
  return traced('POST', `Calls/${callSid}.json`, { CallSid: callSid, Status: 'canceled' }, () =>
    getClient().calls(callSid).update({ status: 'canceled' })
  );
}

async function sendSms(to, body) {
  return traced('POST', 'Messages.json', { To: to, From: process.env.TWILIO_PHONE_NUMBER, Body: body }, () =>
    getClient().messages.create({
      from: process.env.TWILIO_PHONE_NUMBER,
      to,
      body,
    })
  );
}

/**
 * Read the Twilio number's webhook configuration (what's set in the Console).
 * Used by the Lab to show where Twilio sends each callback for inbound calls.
 */
async function getNumberConfig(phoneNumber = process.env.TWILIO_PHONE_NUMBER) {
  const pick = (n) =>
    n && {
      sid: n.sid,
      phoneNumber: n.phoneNumber,
      voiceUrl: n.voiceUrl,
      voiceMethod: n.voiceMethod,
      voiceFallbackUrl: n.voiceFallbackUrl,
      statusCallback: n.statusCallback,
      statusCallbackMethod: n.statusCallbackMethod,
      voiceApplicationSid: n.voiceApplicationSid,
    };
  const [number] = await traced(
    'GET',
    'IncomingPhoneNumbers.json',
    { PhoneNumber: phoneNumber },
    () => getClient().incomingPhoneNumbers.list({ phoneNumber, limit: 1 }),
    (list) => pick(list[0]) || { error: 'Number not found on this account' }
  );
  return pick(number) || null;
}

module.exports = { placeShiftCall, cancelCall, sendSms, getNumberConfig };
