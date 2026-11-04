/**
 * "What is this?" for every event the Inspector shows.
 * Returns { title, html, docs } — html is trusted static copy (no event data).
 */

const DOCS = {
  twiml: 'https://www.twilio.com/docs/voice/twiml/connect/conversationrelay',
  ws: 'https://www.twilio.com/docs/voice/conversationrelay/websocket-messages',
  calls: 'https://www.twilio.com/docs/voice/api/call-resource',
  amd: 'https://www.twilio.com/docs/voice/answering-machine-detection',
  status: 'https://www.twilio.com/docs/voice/api/call-resource#statuscallback',
  tools: 'https://platform.openai.com/docs/guides/function-calling',
};

const WS_IN = {
  setup: {
    title: '← setup: the session begins',
    html: `<p>Twilio's first message after it opens your WebSocket. It identifies the call (<code>callSid</code>, <code>from</code>, <code>to</code>, <code>direction</code>) and carries <code>customParameters</code>, which are the <code>&lt;Parameter&gt;</code> values from your TwiML.</p>
<p>That's the <b>only</b> link between the HTTP webhook that built the TwiML and this socket. This app passes <code>nurseId</code>, <code>shiftId</code> and the greeting text, then builds the system prompt in <code>handleSetup</code>.</p>`,
  },
  prompt: {
    title: '← prompt: the caller finished speaking',
    html: `<p>Speech-to-text output for one caller turn, in <code>voicePrompt</code>. Twilio sends it once it decides the caller has finished: <code>speechTimeout</code> / end-of-turn detection.</p>
<p><code>last:true</code> is the final transcript. With <code>partialPrompts="true"</code> you also get <code>last:false</code> interim versions. This app ignores those so it doesn't answer half-sentences.</p>`,
  },
  interrupt: {
    title: '← interrupt: the caller talked over the agent',
    html: `<p>Twilio already stopped the audio. Your job is to <b>stop generating</b> (abort the LLM stream), or the rest of the old reply gets spoken after the caller finishes.</p>
<p><code>utteranceUntilInterrupt</code> is what the caller actually heard. Use it to keep history accurate. In the transcript, the struck-through text is the part they never heard.</p>`,
  },
  dtmf: {
    title: '← dtmf: a key was pressed',
    html: `<p>Sent only when <code>dtmfDetection="true"</code>. Useful as a yes/no fallback in noisy places. If <code>interruptible</code> includes <code>dtmf</code>, a keypress also interrupts the agent.</p>`,
  },
  error: {
    title: '← error',
    html: `<p>Something failed on Twilio's side (bad message format, provider error…). <code>description</code> often includes an error code. Look it up in the Twilio error dictionary.</p>`,
  },
  info: {
    title: '← info',
    html: `<p>Extra event you subscribed to with the <code>events</code> attribute (for example <code>config-updated</code>), or debug output from <code>debug="debugging"</code>.</p>`,
  },
};

const WS_OUT = {
  text: {
    title: '→ text: words for Twilio to speak',
    html: `<p>Each LLM token is forwarded the moment it arrives. Twilio buffers into phrases and starts TTS after the first few words. <b>That streaming is the biggest latency win in a voice agent.</b></p>
<ul><li><code>last:false</code>: more is coming</li><li><code>last:true</code>: this reply is complete. Send it once per reply (even with an empty token)</li><li>Never trim tokens: <code>"Hi"</code> + <code>" there"</code> keeps its spaces</li></ul>
<p>Optional per-message fields: <code>lang</code>, <code>interruptible</code>, <code>preemptible</code>.</p>`,
  },
  end: {
    title: '→ end: the app finishes the session',
    html: `<p>Ends ConversationRelay. Twilio then POSTs your <code>&lt;Connect action&gt;</code> URL with <code>SessionStatus=ended</code> and your <code>handoffData</code> string, and runs whatever TwiML you return (here: <code>&lt;Dial&gt;</code> the coordinator, or <code>&lt;Hangup&gt;</code>).</p>
<p>Audio still playing gets cut off. That's why this app waits an estimated speaking time before sending <code>end</code>.</p>`,
  },
  play: { title: '→ play', html: `<p>Plays an audio file URL (hold music, recorded disclaimer). <code>loop</code>, <code>interruptible</code>, <code>preemptible</code> are optional.</p>` },
  sendDigits: { title: '→ sendDigits', html: `<p>Sends DTMF tones, for example to navigate another company's phone menu (IVR).</p>` },
  language: { title: '→ language', html: `<p>Switches TTS and/or STT language mid-call. Useful when the caller turns out to prefer Spanish.</p>` },
};

export function explain(ev) {
  switch (ev.kind) {
    case 'http': {
      if (ev.path.startsWith('/voice/outbound'))
        return {
          title: 'Webhook: Twilio asks "what should this answered call do?"',
          docs: DOCS.twiml,
          html: `<p>Twilio fetched the <code>Url</code> given to <code>calls.create</code> once the phone was answered. Because of <code>machineDetection</code>, it waited to report <code>AnsweredBy</code> (human / machine_end_beep / fax / unknown).</p>
<p>For a human, the app returns <code>&lt;Connect&gt;&lt;ConversationRelay&gt;</code>. That TwiML <b>is the whole configuration</b> of the voice session: WebSocket URL, voices, STT, interruption rules, and the <code>&lt;Parameter&gt;</code>s passed into <code>setup</code>. For a voicemail it returns a plain <code>&lt;Say&gt;</code>. Never point an LLM at a voicemail greeting.</p>`,
        };
      if (ev.path.startsWith('/voice'))
        return { title: 'Webhook: inbound call', docs: DOCS.twiml, html: `<p>Someone called the Twilio number, and Twilio fetched its <i>A call comes in</i> URL. The app looks up the caller ID. A nurse with an open shift gets ConversationRelay; anyone else is <code>&lt;Dial&gt;</code>ed to the coordinator.</p><p>This call's status callbacks go to the number's <i>Call status changes</i> URL from the Console. See lesson "Where Twilio sends callbacks".</p>` };
      if (ev.path.startsWith('/action'))
        return {
          title: 'Webhook: <Connect action>, the session is over',
          docs: DOCS.twiml,
          html: `<p>Posted when ConversationRelay ends. <code>SessionStatus</code> tells you how:</p>
<ul><li><code>ended</code>: your app sent <code>end</code>. Read <code>HandoffData</code></li><li><code>completed</code>: the caller hung up</li><li><code>failed</code>: error (<code>ErrorCode</code>, for example 64101 for a bad voice/provider combo)</li></ul>
<p>The call continues with the TwiML you return. This is where human handoff happens.</p>`,
        };
      if (ev.path.startsWith('/status'))
        return { title: 'Webhook: status callback', docs: DOCS.status, html: `<p>Final call status (<code>completed</code>, <code>no-answer</code>, <code>busy</code>, <code>failed</code>, <code>canceled</code>). The campaign uses it to free a calling slot and dial the next nurse.</p>` };
      return { title: 'Webhook', html: '' };
    }
    case 'rest':
      if (ev.url.endsWith('/Calls.json'))
        return {
          title: 'REST: calls.create, start an outbound call',
          docs: DOCS.calls,
          html: `<p>Outbound ConversationRelay starts with the REST API, not TwiML. Key parameters:</p>
<ul><li><code>Url</code>: fetched when answered. It returns the ConversationRelay TwiML</li><li><code>MachineDetection=DetectMessageEnd</code>: waits for the voicemail beep so you can leave a clean message</li><li><code>Timeout</code>: seconds to ring</li><li><code>StatusCallback</code>: notifies you when the call ends</li></ul>`,
        };
      if (ev.url.endsWith('/IncomingPhoneNumbers.json'))
        return {
          title: "REST: read the phone number's webhook config",
          docs: 'https://www.twilio.com/docs/phone-numbers/api/incomingphonenumber-resource',
          html: `<p>Reads what's set in the Console for this number: <code>voiceUrl</code> (<i>A call comes in</i>), <code>statusCallback</code> (<i>Call status changes</i>), <code>voiceFallbackUrl</code> (<i>Primary handler fails</i>). These apply to <b>inbound</b> calls only. Outbound calls use the parameters passed to <code>calls.create</code>.</p><p>The Lab only reads this config to display it.</p>`,
        };
      return { title: 'REST API request', docs: DOCS.calls, html: `<p>Server → Twilio REST call. Shown as the equivalent curl; credentials are placeholders.</p>` };
    case 'ws': {
      const table = ev.dir === 'in' ? WS_IN : WS_OUT;
      const entry = table[ev.msg?.type] || { title: `${ev.dir === 'in' ? '←' : '→'} ${ev.msg?.type}`, html: '' };
      return { ...entry, docs: DOCS.ws };
    }
    case 'tool':
      return {
        title: `Tool call: ${ev.name}`,
        docs: DOCS.tools,
        html: `<p>The LLM asked to run a function. The server executed it and fed the result back as a <code>tool</code> message, then called the LLM again so it can speak about the result. That's why a tool turn takes <b>two</b> LLM round trips.</p>
<p>Tool results here are written as <i>instructions</i> ("Booked. Thank them, then call end_call") to steer what the agent says next. Rules like "only one nurse can win" are enforced in code (<code>claimShift</code>), not in the prompt.</p>`,
      };
    case 'llm':
      return {
        title: `LLM timing: ${ev.phase}`,
        html: `<p><b>first-token</b> = time from the caller's <code>prompt</code> to the first word sent to Twilio. That's the silence the caller hears (plus TTS start-up). Aim for under ~800 ms.</p>
<p><b>response</b> = one complete model round trip. Several in one turn means tool calls. <b>turn-done</b> = the whole turn.</p>`,
      };
    case 'outcome':
      return { title: 'Staffing outcome recorded', html: `<p>Written to <code>data/outcomes.csv</code>. In production this would update the hospital's scheduling system.</p>` };
    case 'campaign':
      return { title: 'Campaign update', html: `<p>The dialer's state: who's queued, who's ringing, and each attempt's outcome. See the Campaign tab.</p>` };
    case 'config':
      return { title: 'Parameters applied', html: `<p>New <code>&lt;ConversationRelay&gt;</code> attribute overrides from the Parameter Playground. They apply to the <b>next</b> call; the TwiML of a call in progress can't change.</p>` };
    case 'session':
      return { title: `WebSocket ${ev.event}`, html: `<p>A ConversationRelay WebSocket ${ev.event === 'connected' ? 'connected. <code>setup</code> comes next' : 'closed. The per-call session state is discarded'}.</p>` };
    case 'sim':
      return { title: 'Browser simulator note', html: `<p>Something the simulator did while playing Twilio's part. It's not a real network frame; it explains how ConversationRelay would behave here.</p>` };
    default:
      return { title: ev.kind, html: '' };
  }
}

/** One-line label for lists. */
export function label(ev) {
  switch (ev.kind) {
    case 'http': return `${ev.method} ${ev.path.split('?')[0]} → ${ev.status}`;
    case 'rest': return `${ev.method} …/${ev.url.split('/Accounts/')[1]?.split('/').slice(1).join('/') || ev.url}${ev.error ? ' ✗ ' + ev.error.message : ev.response?.status ? ' → ' + ev.response.status : ''}`;
    case 'ws': {
      const m = ev.msg || {};
      if (m.type === 'text') return `text ${JSON.stringify(m.token)}${m.last ? ' last:true' : ''}`;
      if (m.type === 'prompt') return `prompt "${m.voicePrompt}"${m.last === false ? ' (partial)' : ''}`;
      if (m.type === 'interrupt') return `interrupt heard="${m.utteranceUntilInterrupt ?? ''}"`;
      if (m.type === 'dtmf') return `dtmf ${m.digit}`;
      if (m.type === 'end') return `end ${m.handoffData || ''}`;
      if (m.type === 'setup') return `setup ${JSON.stringify(m.customParameters || {})}`;
      return m.type;
    }
    case 'tool': return `${ev.name}(${JSON.stringify(ev.args)})`;
    case 'llm': return `${ev.phase}${ev.ms != null ? ` ${ev.ms} ms` : ''}${ev.toolCalls?.length ? ` → tools: ${ev.toolCalls.join(', ')}` : ev.phase === 'request' ? ` (${ev.messageCount} messages)` : ''}`;
    case 'outcome': return `${ev.nurseName || ev.nurseId} → ${ev.outcome}`;
    case 'campaign': return `${ev.shiftId} ${ev.summary?.status}`;
    case 'config': return `overrides ${JSON.stringify(ev.overrides)}`;
    case 'session': return `websocket ${ev.event}`;
    case 'sim': return ev.message || 'simulator';
    case 'system': return ev.message;
    default: return ev.kind;
  }
}
