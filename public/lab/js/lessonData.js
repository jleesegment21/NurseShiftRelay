/**
 * Lesson definitions (data only — lessons.js renders them).
 *
 *   tasks[].done(ev, store) → true when a live event proves the learner did it
 *   watch(ev)               → which live frames to show under the lesson
 */

const isWs = (ev, dir, type) => ev.kind === 'ws' && ev.dir === dir && ev.msg?.type === type;
const isRelayTwiml = (ev) => ev.kind === 'http' && /<ConversationRelay/.test(ev.response || '');

export const LESSONS = [
  {
    id: 'big-picture',
    title: 'The big picture',
    concept: 'Architecture',
    docsUrl: 'https://www.twilio.com/docs/voice/conversationrelay',
    teach: `
      <p><b>ConversationRelay handles the phone and the audio; you handle the thinking.</b> Twilio does speech-to-text, text-to-speech and interruption detection, and sends your server plain JSON text over a WebSocket. You never touch audio.</p>
      <p>Every ConversationRelay app has three endpoints. Watch the diagram on the left light up as each one is used:</p>
      <ul>
        <li><b>Voice webhook</b> (HTTP): returns TwiML that <i>opens</i> the session</li>
        <li><b>WebSocket</b>: the conversation itself, one socket per call</li>
        <li><b>Action URL</b> (HTTP): decides what happens <i>after</i> the session (hang up, transfer)</li>
      </ul>
      <p>The LLM is your choice. ConversationRelay doesn't know or care which model you use.</p>`,
    tasks: [
      { id: 'start', label: 'Start a call (simulated or real)', how: 'Left panel → ▶ Start simulated call', done: (ev) => ev.kind === 'session' && ev.event === 'connected' },
      { id: 'twiml', label: 'See the voice webhook return ConversationRelay TwiML', how: 'Happens automatically when the call is answered', done: isRelayTwiml },
      { id: 'say', label: 'Say something to the agent and get a reply', how: 'Type in the box and press Enter', done: (ev) => isWs(ev, 'out', 'text') && ev.msg.last },
    ],
    watch: (ev) => ev.kind === 'http' || isWs(ev, 'in', 'setup') || isWs(ev, 'in', 'prompt') || isWs(ev, 'out', 'end'),
    code: {
      file: 'server.js',
      lang: 'javascript',
      snippet: `app.use('/voice',  twilioWebhook, voiceRoute);   // 1. TwiML that opens the session
app.use('/action', twilioWebhook, actionRoute);  // 3. what happens after

// 2. The conversation: ConversationRelay connects here
server.on('upgrade', (request, socket, head) => {
  if (new URL(request.url, 'http://localhost').pathname === '/ws') {
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
  }
});`,
    },
  },
  {
    id: 'twiml',
    title: 'TwiML opens the session',
    concept: '<ConversationRelay> TwiML',
    docsUrl: 'https://www.twilio.com/docs/voice/twiml/connect/conversationrelay',
    teach: `
      <p>When the call is answered, your webhook returns <code>&lt;Connect&gt;&lt;ConversationRelay&gt;</code>. <b>That TwiML is the entire configuration of the voice session</b>: which WebSocket, which voice, which speech recognizer, and the interruption rules.</p>
      <ul>
        <li><code>url</code> must be <code>wss://</code></li>
        <li><code>welcomeGreeting</code> is spoken by Twilio immediately, with no LLM latency on the first sentence</li>
        <li><code>&lt;Parameter&gt;</code> children become <code>customParameters</code> in <code>setup</code>. That's how the socket learns <i>who</i> is calling</li>
        <li><code>&lt;Connect action&gt;</code> is where Twilio goes when the session ends</li>
      </ul>
      <p>⚠️ An invalid provider/voice/model combination means the WebSocket <b>never connects</b>. The caller hears silence and error 64101 appears at the action URL.</p>`,
    tasks: [
      { id: 'see', label: 'Get ConversationRelay TwiML back from the voice webhook', how: 'Start a call, then click the "🌐 Twilio POST /voice/outbound" line in the transcript to read it', done: isRelayTwiml },
      { id: 'change', label: 'Change any parameter and Apply it', how: 'Parameters tab → e.g. voice or interruptible → Apply', done: (ev) => ev.kind === 'config' },
      { id: 'see-change', label: 'Start a new call and see your change in its TwiML', how: 'Start another call after applying', done: (ev, store) => isRelayTwiml(ev) && store.lastConfigTs && ev.ts > store.lastConfigTs },
    ],
    watch: (ev) => ev.kind === 'http' || ev.kind === 'config',
    code: {
      file: 'routes/voice.js',
      lang: 'javascript',
      snippet: `const connect = response.connect({ action: \`\${serverUrl}/action\` });
const relay = connect.conversationRelay({
  url: \`\${wsUrl}/ws\`,
  welcomeGreeting: greeting,
  ...relayConfig.attributes(shift),   // ttsProvider, voice, interruptible, hints…
});
relay.parameter({ name: 'nurseId', value: nurse.id });   // → setup.customParameters
relay.parameter({ name: 'shiftId', value: shift.id });`,
    },
  },
  {
    id: 'setup',
    title: 'setup & customParameters',
    concept: 'WebSocket · setup',
    docsUrl: 'https://www.twilio.com/docs/voice/conversationrelay/websocket-messages',
    teach: `
      <p>The first message on the socket. It has the call's identity (<code>callSid</code>, <code>from</code>, <code>to</code>, <code>direction</code>) and your <code>customParameters</code>.</p>
      <p>Everything about one call lives in a per-socket <code>session</code> object: who the nurse is, the shift, the conversation history, and the abort controller. Build the system prompt <b>once</b> here, not on every turn.</p>
      <p>The welcomeGreeting was spoken by Twilio, not the model, so this app adds it to history as an assistant message. Otherwise the LLM greets the nurse a second time.</p>`,
    tasks: [
      { id: 'setup', label: 'Receive a setup message', how: 'Start a call', done: (ev) => isWs(ev, 'in', 'setup') },
      { id: 'params', label: 'Find nurseId and shiftId inside customParameters', how: 'Inspector → click the "setup" row', done: (ev) => isWs(ev, 'in', 'setup') && ev.msg.customParameters?.nurseId },
    ],
    watch: (ev) => isWs(ev, 'in', 'setup') || ev.kind === 'session',
    code: {
      file: 'websocket/relayHandler.js',
      lang: 'javascript',
      snippet: `function handleSetup(msg, session, ws) {
  const params = msg.customParameters || {};
  session.callSid = msg.callSid;
  session.nurse = staffing.getNurse(params.nurseId);
  session.shift = staffing.getShift(params.shiftId);

  session.systemPrompt = buildSystemPrompt(session.nurse, session.shift, params.direction);
  // Twilio already spoke the greeting — tell the model
  if (params.greeting) session.messages.push({ role: 'assistant', content: params.greeting });
}`,
    },
  },
  {
    id: 'streaming',
    title: 'prompt → streamed text',
    concept: 'Latency',
    docsUrl: 'https://www.twilio.com/docs/voice/conversationrelay/websocket-messages',
    teach: `
      <p>On a phone call, <b>silence over about 1 second feels broken</b>. So every LLM token is forwarded to Twilio as soon as it arrives, and Twilio starts speaking after the first few words.</p>
      <ul>
        <li><code>{"type":"text","token":"Hi ","last":false}</code>: more coming</li>
        <li><code>{"type":"text","token":"","last":true}</code>: this reply is done. Send it once per reply</li>
        <li>Don't trim tokens. The spaces are part of them</li>
      </ul>
      <p>Look at the <b>⏱ badge</b> under each nurse bubble: prompt → first token. Green is under 800 ms. Levers: a faster model, a shorter system prompt, short replies, hosting near Twilio.</p>`,
    tasks: [
      { id: 'prompt', label: 'Send a prompt', how: 'Say anything', done: (ev) => isWs(ev, 'in', 'prompt') && ev.msg.last !== false },
      { id: 'stream', label: 'Watch a reply stream as many text frames', how: 'Inspector → turn off "group text frames"', done: (ev) => isWs(ev, 'out', 'text') && ev.msg.last },
      { id: 'fast', label: 'Get a first token in under 1.5 seconds', how: 'Check the ⏱ badge', done: (ev) => ev.kind === 'llm' && ev.phase === 'first-token' && ev.ms < 1500 },
    ],
    watch: (ev) => isWs(ev, 'in', 'prompt') || isWs(ev, 'out', 'text') || (ev.kind === 'llm' && ev.phase === 'first-token'),
    code: {
      file: 'websocket/relayHandler.js',
      lang: 'javascript',
      snippet: `const assistantMessage = await chatStream(loopMessages, toolDefinitions,
  (token) => sendText(ws, token, false),   // every token, immediately
  signal
);
if (!assistantMessage.tool_calls?.length) {
  sendText(ws, '', true);                   // end of this reply
}

function sendText(ws, token, last) {
  ws.send(JSON.stringify({ type: 'text', token, last }));
}`,
    },
  },
  {
    id: 'interrupts',
    title: 'Interruptions (barge-in)',
    concept: 'interrupt · interruptible',
    docsUrl: 'https://www.twilio.com/docs/voice/conversationrelay/websocket-messages',
    teach: `
      <p>People talk over agents. When they do, Twilio stops the audio and sends <code>interrupt</code>. <b>You must abort the LLM stream</b>, or the rest of the old reply gets spoken after the caller finishes.</p>
      <p><code>utteranceUntilInterrupt</code> is what the caller actually heard. In the transcript, the struck-through part was never heard.</p>
      <p>Try it with different settings in the Parameters tab:</p>
      <ul>
        <li><code>interruptible="none"</code>: the agent can't be cut off (good for disclosures)</li>
        <li>…plus <code>reportInputDuringAgentSpeech="speech"</code>: you still receive what they said</li>
        <li><code>welcomeGreetingInterruptible</code>: separate rule for the greeting</li>
      </ul>
      <p>💡 Exercise: this app leaves interrupted replies out of history. Save the <i>heard</i> part instead, so the model knows what the nurse actually heard.</p>`,
    tasks: [
      { id: 'interrupt', label: 'Interrupt the agent mid-sentence', how: 'Send a message while "🔊 agent speaking…" is shown', done: (ev) => isWs(ev, 'in', 'interrupt') },
      { id: 'heard', label: 'See a non-empty utteranceUntilInterrupt', how: 'Let a few words play first', done: (ev) => isWs(ev, 'in', 'interrupt') && ev.msg.utteranceUntilInterrupt },
      { id: 'none', label: 'Set interruptible=none and see your input dropped', how: 'Parameters → interruptible = none → Apply → new call', done: (ev) => ev.kind === 'sim' && /Input dropped/.test(ev.message || '') },
    ],
    watch: (ev) => isWs(ev, 'in', 'interrupt') || isWs(ev, 'in', 'prompt') || (ev.kind === 'sim' && /interrupt|dropped/i.test(ev.message || '')),
    code: {
      file: 'websocket/relayHandler.js',
      lang: 'javascript',
      snippet: `case 'interrupt':
  // Twilio already stopped the audio — stop generating too
  session.abortController?.abort();
  break;

case 'prompt':
  session.abortController?.abort();          // a new turn cancels any reply in flight
  session.abortController = new AbortController();
  await runAgentTurn(messages, session, ws, session.abortController.signal);`,
    },
  },
  {
    id: 'tools',
    title: 'Tools: the agent takes action',
    concept: 'Function calling',
    docsUrl: 'https://platform.openai.com/docs/guides/function-calling',
    teach: `
      <p>The model decides; your code acts. A tool turn is <b>two LLM round trips</b>: the model asks for <code>accept_shift</code>, you run it, then the model speaks about the result. Watch the LLM timing rows.</p>
      <ul>
        <li><b>Tool results are instructions</b>: <i>"Booked. Thank them, then call end_call."</i> steers the next sentence</li>
        <li><b>Put guardrails in code</b>: <code>claimShift</code> guarantees one nurse per shift; the prompt only asks nicely</li>
        <li><b>Handle "too late" as conversation</b>: if the shift was just filled, the tool tells the agent to offer standby</li>
        <li><b>Tool descriptions are prompt engineering</b>: "Only call after they clearly said yes AND confirmed the times"</li>
      </ul>`,
    tasks: [
      { id: 'accept', label: 'Accept a shift (accept_shift)', how: 'Confirm identity → "Sure, I\'ll take it" → confirm the times', done: (ev) => ev.kind === 'tool' && ev.name === 'accept_shift' },
      { id: 'two', label: 'See an LLM response that requested a tool', how: 'Inspector → LLM rows "→ tools: …"', done: (ev) => ev.kind === 'llm' && ev.phase === 'response' && ev.toolCalls?.length },
      { id: 'list', label: 'Ask for other shifts (list_other_open_shifts)', how: '"Do you have anything else?"', done: (ev) => ev.kind === 'tool' && ev.name === 'list_other_open_shifts' },
      { id: 'filled', label: 'Say yes to a shift that was already filled', how: 'Accept S1001 in one call, then try it again as another nurse', done: (ev) => ev.kind === 'outcome' && ev.outcome === 'accepted-but-filled' },
    ],
    watch: (ev) => ev.kind === 'tool' || (ev.kind === 'llm' && ev.phase === 'response') || ev.kind === 'outcome',
    code: {
      file: 'tools/agentTools.js',
      lang: 'javascript',
      snippet: `async function acceptShift(args, { session }) {
  const result = staffing.claimShift(shiftId, session.nurse.id);   // atomic: one winner
  if (!result.ok && result.reason === 'filled') {
    return 'This shift was JUST filled… Apologize… offer the standby list (add_to_standby)…';
  }
  campaign.onShiftFilled(shiftId);          // cancel calls still ringing
  return \`Booked. \${session.nurse.firstName} is confirmed… Thank them sincerely, then call end_call.\`;
}`,
    },
  },
  {
    id: 'ending',
    title: 'Ending & human handoff',
    concept: 'end · handoffData · action URL',
    docsUrl: 'https://www.twilio.com/docs/voice/twiml/connect/conversationrelay',
    teach: `
      <p>The app ends the session with <code>{"type":"end","handoffData":"…"}</code>. Twilio then POSTs the <code>&lt;Connect action&gt;</code> URL with <code>SessionStatus</code> and <code>HandoffData</code>, and runs whatever TwiML comes back.</p>
      <ul>
        <li><code>ended</code>: your app sent <code>end</code> → transfer (<code>&lt;Dial&gt;</code>) or <code>&lt;Hangup&gt;</code></li>
        <li><code>completed</code>: the caller hung up</li>
        <li><code>failed</code>: always fall back to a human. Never leave dead air</li>
      </ul>
      <p><code>handoffData</code> is a <b>string</b>, so JSON-encode structured data yourself.</p>
      <p>✂️ <code>end</code> cuts off audio that's still playing. This app waits an estimated speaking time first. The simulator shows a "cut off" note when it's too early. The precise fix is <code>events="tokens-played"</code>.</p>`,
    tasks: [
      { id: 'end', label: 'Have the agent end the call (end)', how: 'Finish a conversation, e.g. decline the shift', done: (ev) => isWs(ev, 'out', 'end') },
      { id: 'action', label: 'See the action URL receive HandoffData', how: 'Inspector → POST /action', done: (ev) => ev.kind === 'http' && ev.path.startsWith('/action') && ev.params?.HandoffData },
      { id: 'transfer', label: 'Get transferred to a human', how: '"Can I talk to a person?"', done: (ev) => ev.kind === 'http' && ev.path.startsWith('/action') && /<Dial/.test(ev.response || '') },
      { id: 'hangup', label: 'Hang up on the agent (SessionStatus=completed)', how: '☎ Hang up', done: (ev) => ev.kind === 'http' && ev.path.startsWith('/action') && ev.params?.SessionStatus === 'completed' },
    ],
    watch: (ev) => isWs(ev, 'out', 'end') || (ev.kind === 'http' && ev.path.startsWith('/action')) || (ev.kind === 'sim' && /cut off|would now run/i.test(ev.message || '')),
    code: {
      file: 'routes/action.js',
      lang: 'javascript',
      snippet: `// relayHandler: ws.send(JSON.stringify({ type: 'end', handoffData: JSON.stringify({ action: 'transfer', reason }) }))

function buildActionTwiml({ SessionStatus, HandoffData }) {
  const handoff = JSON.parse(HandoffData || '{}');
  if (SessionStatus === 'failed' || handoff.action === 'transfer') {
    response.dial({ callerId: TWILIO_PHONE_NUMBER }, STAFFING_COORDINATOR_NUMBER);
  } else {
    response.hangup();
  }
}`,
    },
  },
  {
    id: 'dtmf',
    title: 'Keypad, partial prompts & input modes',
    concept: 'dtmf · partialPrompts',
    docsUrl: 'https://www.twilio.com/docs/voice/twiml/connect/conversationrelay',
    teach: `
      <p><code>dtmfDetection="true"</code> sends keypresses as <code>{"type":"dtmf","digit":"1"}</code>. That's a reliable yes/no fallback for a nurse calling from a loud unit. Going the other way, <code>sendDigits</code> lets <i>your agent</i> press keys, for example to navigate another company's phone menu.</p>
      <p><code>partialPrompts="true"</code> streams interim transcripts (<code>last:false</code>) while the caller is still talking. That's useful for advanced latency tricks. Your handler must ignore or merge them, or it will answer half-sentences. Try it with the 🎤 button in Chrome.</p>`,
    tasks: [
      { id: 'press', label: 'Press a key during a call', how: 'Use the keypad under the input box', done: (ev) => isWs(ev, 'in', 'dtmf') },
      { id: 'off', label: 'Turn dtmfDetection off and see keys ignored', how: 'Parameters → dtmfDetection = false → Apply → new call', done: (ev) => ev.kind === 'sim' && /dtmfDetection is not/.test(ev.message || '') },
      { id: 'partial', label: 'Receive a partial prompt (last:false)', how: 'Parameters → partialPrompts = true → new call → 🎤', done: (ev) => isWs(ev, 'in', 'prompt') && ev.msg.last === false },
    ],
    watch: (ev) => isWs(ev, 'in', 'dtmf') || isWs(ev, 'in', 'prompt') || (ev.kind === 'sim' && /dtmf/i.test(ev.message || '')),
    code: {
      file: 'websocket/relayHandler.js',
      lang: 'javascript',
      snippet: `async function handlePrompt(msg, session, ws) {
  // With partialPrompts="true", interim transcripts arrive with last:false
  if (msg.last === false) return;
  ...
}

case 'dtmf':
  console.log(\`DTMF digit received: \${msg.digit}\`);   // exercise: "press 1 to accept"`,
    },
  },
  {
    id: 'outbound',
    title: 'Real calls: outbound, AMD & status callbacks',
    concept: 'Voice REST API',
    docsUrl: 'https://www.twilio.com/docs/voice/answering-machine-detection',
    teach: `
      <p>Outbound ConversationRelay starts with the <b>REST API</b>: <code>calls.create({ to, from, url })</code>. When the phone is answered, Twilio fetches <code>url</code>, and that's where the ConversationRelay TwiML comes from. Inbound and outbound share the same relay code.</p>
      <ul>
        <li><code>MachineDetection=DetectMessageEnd</code> waits for the voicemail beep, then reports <code>AnsweredBy</code>: <code>human</code>, <code>machine_end_beep</code>, <code>fax</code>, <code>unknown</code>. Voicemail gets a <code>&lt;Say&gt;</code>; never point an LLM at a greeting</li>
        <li><code>StatusCallback</code> reports <code>no-answer</code> / <code>busy</code> / <code>completed</code>, which drives the campaign queue</li>
        <li>Calls still ringing can be cancelled (<code>Status=canceled</code>) once a shift is filled</li>
      </ul>
      <p>Switch the left panel to <b>📞 Real phone call</b> (needs Twilio creds + tunnel).</p>`,
    tasks: [
      { id: 'create', label: 'Place a real call (REST calls.create)', how: 'Left → Real phone call → Call my phone', done: (ev) => ev.kind === 'rest' && ev.url.endsWith('/Calls.json') && !ev.error },
      { id: 'human', label: 'Answer it: AnsweredBy=human', how: 'Pick up and say hello', done: (ev) => ev.kind === 'http' && ev.path.startsWith('/voice/outbound') && !ev.simulated && ev.params?.AnsweredBy === 'human' },
      { id: 'machine', label: 'Let voicemail answer: AnsweredBy=machine_*', how: 'Decline or ignore the call so it goes to voicemail', done: (ev) => ev.kind === 'http' && /^machine/.test(ev.params?.AnsweredBy || '') },
      { id: 'status', label: 'Receive a status callback', how: 'Happens when any real call ends', done: (ev) => ev.kind === 'http' && ev.path.startsWith('/status') },
    ],
    watch: (ev) => ev.kind === 'rest' || (ev.kind === 'http' && !ev.simulated),
    code: {
      file: 'services/twilio.js',
      lang: 'javascript',
      snippet: `client.calls.create({
  to: nurse.phone,
  from: process.env.TWILIO_PHONE_NUMBER,
  url: \`\${SERVER_URL}/voice/outbound?nurseId=…&shiftId=…\`,   // returns ConversationRelay TwiML
  machineDetection: 'DetectMessageEnd',
  timeout: 25,
  statusCallback: \`\${SERVER_URL}/status\`,
});`,
    },
  },
  {
    id: 'callbacks',
    title: 'Where Twilio sends callbacks',
    concept: 'Webhooks & status callbacks',
    docsUrl: 'https://www.twilio.com/docs/usage/webhooks/voice-webhooks',
    teach: `
      <p>Twilio calls <b>several</b> URLs during a call, and they're configured in <b>two different places</b>:</p>
      <ul>
        <li><b>Inbound calls</b> use your phone number's settings in the Twilio Console: <i>A call comes in</i>, <i>Call status changes</i>, <i>Primary handler fails</i></li>
        <li><b>Outbound calls</b> ignore those. They use the <code>Url</code> and <code>StatusCallback</code> passed to <code>calls.create()</code> in code</li>
        <li><b>The TwiML</b> sets two more for both directions: <code>&lt;Connect action&gt;</code> and the ConversationRelay <code>url</code></li>
      </ul>
      <p>A status callback can go to <i>any</i> URL, not just your app. Below, your number's <i>Call status changes</i> points at an external inspector (webhook.site). Twilio posts there directly, so those requests never appear in this Lab. Outbound status callbacks come to <code>/status</code>, because the campaign needs them to dial the next nurse.</p>
      <p>With ngrok, the URL changes on every restart. If <i>A call comes in</i> doesn't match <code>SERVER_URL</code>, inbound calls won't reach the app. The table below flags that.</p>`,
    widget: 'callbacks',
    tasks: [
      { id: 'read', label: "Read your number's webhook config from Twilio", how: 'Opening this lesson does it: REST GET IncomingPhoneNumbers', done: (ev) => ev.kind === 'rest' && ev.url.endsWith('/IncomingPhoneNumbers.json') && !ev.error },
      { id: 'inbound', label: 'Call your Twilio number: Twilio hits "A call comes in" (/voice)', how: 'Dial the number from your phone. Its status callback goes to webhook.site, not here', done: (ev) => ev.kind === 'http' && /^\/voice(\?|$)/.test(ev.path) && !ev.simulated },
      { id: 'outbound', label: 'See an outbound StatusCallback arrive at /status', how: 'Real phone call → Call my phone → hang up', done: (ev) => ev.kind === 'http' && ev.path.startsWith('/status') },
    ],
    watch: (ev) => (ev.kind === 'rest' && ev.url.endsWith('/IncomingPhoneNumbers.json')) || (ev.kind === 'http' && !ev.simulated),
    code: {
      file: 'services/twilio.js',
      lang: 'javascript',
      snippet: `// Inbound: set in the Console, read here only to display it
client.incomingPhoneNumbers.list({ phoneNumber })   // → voiceUrl, statusCallback, voiceFallbackUrl

// Outbound: set per call in code (the Console status callback does NOT apply)
client.calls.create({
  url: \`\${SERVER_URL}/voice/outbound?…\`,
  statusCallback: \`\${SERVER_URL}/status\`,
  statusCallbackEvent: ['completed'],
});`,
    },
  },
  {
    id: 'production',
    title: 'Production checklist',
    concept: 'Going live',
    docsUrl: 'https://www.twilio.com/docs/voice/conversationrelay',
    teach: `
      <ul>
        <li><b>Validate webhooks</b>: <code>X-Twilio-Signature</code> on every HTTP endpoint (this app: <code>twilio.webhook()</code>)</li>
        <li><b>Latency budget</b>: fast model, short prompts, host near Twilio's media region, stream everything</li>
        <li><b>Fallbacks</b>: <code>SessionStatus=failed</code> → human; LLM error → apologize + transfer</li>
        <li><b>Reconnects</b>: <code>applicationReconnect="true"</code> + sessions keyed by <code>callSid</code>, so a deploy doesn't drop calls</li>
        <li><b>Voice tuning</b>: test voices, <code>elevenlabsTextNormalization</code>, <code>hints</code> for your vocabulary, <code>ignoreBackchannel</code></li>
        <li><b>Accurate history</b>: use <code>utteranceUntilInterrupt</code>; time <code>end</code> with <code>tokens-played</code></li>
        <li><b>Analytics</b>: <code>intelligenceService</code> for post-call QA ("did the agent confirm identity before sharing details?")</li>
        <li><b>Compliance</b>: AI disclosure, consent for automated calls, a BAA if PHI is ever involved, opt-outs honored</li>
        <li><b>State</b>: move sessions and campaigns out of memory (Redis/DB) to run more than one server</li>
      </ul>`,
    tasks: [],
    watch: () => false,
    code: null,
  },
];
