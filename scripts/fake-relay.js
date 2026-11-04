/**
 * Pretend to be Twilio ConversationRelay so you can talk to the agent by typing.
 * Prints every raw WebSocket message so you can see the protocol.
 *
 *   npm start                                  # in one terminal
 *   node scripts/fake-relay.js N002 S1001      # in another (nurseId shiftId)
 *
 * Type what the nurse says and press Enter. Type "/interrupt" to simulate
 * barge-in, or "/dtmf 1" to press a key.
 */
require('dotenv').config();
const readline = require('readline');
const WebSocket = require('ws');

const [nurseId = 'N002', shiftId = 'S1001'] = process.argv.slice(2);
const ws = new WebSocket(`ws://localhost:${process.env.PORT || 3000}/ws`);
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

const greeting = `Hi, this is ${process.env.AGENT_NAME || 'Ava'}, an automated assistant. Am I speaking with the nurse?`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

function send(msg) {
  console.log(dim(`→ ${JSON.stringify(msg)}`));
  ws.send(JSON.stringify(msg));
}

ws.on('open', () => {
  // Twilio sends this first. customParameters come from <Parameter> in the TwiML.
  send({
    type: 'setup',
    sessionId: 'VXfake',
    callSid: 'CAfake',
    from: '+15555550000',
    to: '+15555559999',
    direction: 'outbound-api',
    customParameters: { nurseId, shiftId, direction: 'outbound', greeting },
  });
  console.log(`\nAgent (welcomeGreeting): ${greeting}\n`);
  rl.prompt();
});

let speaking = false;
ws.on('message', (raw) => {
  const msg = JSON.parse(raw);
  if (msg.type === 'text') {
    if (!speaking) process.stdout.write('Agent: ');
    speaking = true;
    process.stdout.write(msg.token);
    if (msg.last) {
      speaking = false;
      process.stdout.write('\n\n');
      rl.prompt();
    }
  } else {
    console.log(dim(`\n← ${JSON.stringify(msg)}`));
    if (msg.type === 'end') {
      console.log('Session ended — Twilio would now POST HandoffData to the <Connect action> URL.');
      ws.close();
      process.exit(0);
    }
  }
});

rl.on('line', (line) => {
  const text = line.trim();
  if (!text) return rl.prompt();
  if (text === '/interrupt') return send({ type: 'interrupt', utteranceUntilInterrupt: '', durationUntilInterruptMs: 0 });
  if (text.startsWith('/dtmf ')) return send({ type: 'dtmf', digit: text.slice(6) });
  send({ type: 'prompt', voicePrompt: text, lang: 'en-US', last: true });
});

ws.on('close', () => process.exit(0));
ws.on('error', (err) => {
  console.error('Could not connect — is the server running?', err.message);
  process.exit(1);
});
