import { api, esc } from './format.js';
import { store, emitLocal } from './store.js';
import { Playback } from './playback.js';

/**
 * The browser plays Twilio's part of ConversationRelay:
 *   1. Ask the server for the TwiML an answered call would get (same code as the real webhook)
 *   2. Parse <ConversationRelay> and its <Parameter>s exactly like Twilio does
 *   3. Open the WebSocket, send `setup`, speak the welcomeGreeting
 *   4. Turn your typing / microphone into `prompt`, `interrupt` and `dtmf` messages,
 *      honouring interruptible, welcomeGreetingInterruptible, reportInputDuringAgentSpeech,
 *      dtmfDetection and partialPrompts
 *   5. On `end`, POST the action URL and show what TwiML Twilio would run next
 */
export class Simulator {
  constructor(onChange) {
    this.onChange = onChange || (() => {});
    this.playback = new Playback(() => this.onChange());
    this.ws = null;
    this.state = 'idle'; // idle | connecting | live | ended
    this.attrs = {};
    this.callSid = null;
    this.inGreeting = false;
    this.awaitingReply = false;
  }

  get live() {
    return this.state === 'live';
  }

  note(message, html) {
    emitLocal('sim', { callSid: this.callSid, message, html: html || esc(message) });
  }

  async start({ nurseId, shiftId }) {
    this.state = 'connecting';
    this.onChange();
    let sim;
    try {
      sim = await api('/sim/start', { method: 'POST', body: { nurseId, shiftId } });
    } catch (err) {
      this.state = 'idle';
      this.onChange();
      throw err;
    }
    this.callSid = sim.callSid;
    this.from = sim.from;
    this.to = sim.to;
    store.simCallSids.add(sim.callSid);

    // 2. Parse the TwiML like Twilio would
    const doc = new DOMParser().parseFromString(sim.twiml, 'text/xml');
    const relay = doc.querySelector('ConversationRelay');
    this.attrs = Object.fromEntries([...relay.attributes].map((a) => [a.name, a.value]));
    const customParameters = Object.fromEntries(
      [...relay.querySelectorAll('Parameter')].map((p) => [p.getAttribute('name'), p.getAttribute('value')])
    );

    // The real url is your public wss:// tunnel; the simulator talks to this machine directly
    const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    this.note(
      `TwiML parsed. Simulator connecting to ${wsUrl} (real calls use ${this.attrs.url})`,
      `🧪 Simulator parsed the TwiML. Real Twilio would connect to <code>${esc(this.attrs.url)}</code>; the simulator connects to <code>${esc(wsUrl)}</code>`
    );

    this.ws = new WebSocket(wsUrl);
    this.sessionId = 'VX' + crypto.getRandomValues(new Uint8Array(16)).reduce((s, b) => s + b.toString(16).padStart(2, '0'), '');

    this.ws.onopen = () => {
      this.state = 'live';
      // 3. setup
      this.send({
        type: 'setup',
        sessionId: this.sessionId,
        accountSid: 'ACsimulated',
        parentCallSid: '',
        callSid: this.callSid,
        from: this.from,
        to: this.to,
        forwardedFrom: '',
        callerName: '',
        direction: 'outbound-api',
        callType: 'PSTN',
        callStatus: 'IN-PROGRESS',
        customParameters,
      });
      if (this.attrs.welcomeGreeting) {
        this.inGreeting = true;
        this.playback.push(this.attrs.welcomeGreeting, true);
      }
      this.onChange();
    };

    this.ws.onmessage = (m) => this.onServerMessage(JSON.parse(m.data));
    this.ws.onclose = () => {
      if (this.state === 'live') {
        this.state = 'ended';
        this.playback.stop();
        this.note('WebSocket closed by server');
      }
      this.onChange();
    };
  }

  send(msg) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(msg));
  }

  onServerMessage(msg) {
    if (msg.type === 'text') {
      this.awaitingReply = false;
      this.inGreeting = false;
      this.playback.push(msg.token, msg.last);
    } else if (msg.type === 'end') {
      this.finish('ended', msg.handoffData);
    } else if (msg.type === 'play') {
      this.note(`Server sent play: ${msg.source} (not played in simulator)`);
    } else if (msg.type === 'sendDigits') {
      this.note(`Server sent sendDigits: ${msg.digits}`);
    } else if (msg.type === 'language') {
      this.note(`Server switched language: TTS ${msg.ttsLanguage || '-'} / STT ${msg.transcriptionLanguage || '-'}`);
    }
    this.onChange();
  }

  /** Which rule applies right now: the greeting has its own interruptibility. */
  currentInterruptible() {
    return this.inGreeting ? this.attrs.welcomeGreetingInterruptible || 'any' : this.attrs.interruptible || 'any';
  }

  /**
   * Caller input arrives while the agent may be talking. Returns false if
   * ConversationRelay would drop the input entirely.
   */
  bargeIn(kind) {
    if (!this.playback.speaking) return true;
    const rule = this.currentInterruptible();
    const canInterrupt = rule === 'any' || rule === 'true' || rule === kind;
    if (canInterrupt) {
      const { heard, durationMs } = this.playback.interrupt();
      this.inGreeting = false;
      this.send({ type: 'interrupt', utteranceUntilInterrupt: heard, durationUntilInterruptMs: durationMs });
      return true;
    }
    const report = this.attrs.reportInputDuringAgentSpeech || 'none';
    if (report === 'any' || report === kind) {
      this.note(
        `Not interruptible (${rule}), but reportInputDuringAgentSpeech=${report}: the input is sent while the agent keeps talking`
      );
      return true;
    }
    this.note(
      `Input dropped: the agent is speaking, interruptible="${rule}" and reportInputDuringAgentSpeech="${report}". ConversationRelay would not send this to your app.`,
      `🚫 <b>Input dropped.</b> The agent is speaking, <code>interruptible="${esc(rule)}"</code> and <code>reportInputDuringAgentSpeech="${esc(report)}"</code>, so ConversationRelay would not send this to your app.`
    );
    return false;
  }

  /** Interim transcript (microphone). First one while the agent talks = barge-in. */
  partial(text, first) {
    if (!this.live) return;
    if (first && !this.bargeIn('speech')) return 'dropped';
    if (this.attrs.partialPrompts === 'true') this.send({ type: 'prompt', voicePrompt: text, lang: 'en-US', last: false });
  }

  /** Final transcript — typed text or the microphone's final result. */
  say(text, { alreadyHandled = false } = {}) {
    if (!this.live || !text.trim()) return;
    if (!alreadyHandled && !this.bargeIn('speech')) return;
    this.awaitingReply = true;
    this.send({ type: 'prompt', voicePrompt: text.trim(), lang: 'en-US', last: true });
    this.onChange();
  }

  dtmf(digit) {
    if (!this.live) return;
    if (this.attrs.dtmfDetection !== 'true') {
      this.note(`Key ${digit} ignored: dtmfDetection is not "true", so ConversationRelay doesn't send keypresses`);
      return;
    }
    if (!this.bargeIn('dtmf')) return;
    this.send({ type: 'dtmf', digit });
  }

  /** Caller hangs up. */
  hangup() {
    if (!this.live) return;
    this.finish('completed');
  }

  async finish(sessionStatus, handoffData) {
    if (this.state !== 'live') return;
    this.state = 'ended';
    if (this.playback.speaking && sessionStatus === 'ended') {
      const lost = this.playback.unheard();
      if (lost) this.note(`Audio cut off by "end": the nurse never heard "${lost}"`, `✂️ <b>Audio cut off by <code>end</code></b>. The nurse never heard: <i>"${esc(lost)}"</i>`);
    }
    this.playback.stop();
    this.ws?.close();

    // 5. What Twilio does next: POST the <Connect action> URL
    const body = {
      AccountSid: 'ACsimulated',
      CallSid: this.callSid,
      SessionId: this.sessionId,
      SessionStatus: sessionStatus,
      CallStatus: sessionStatus === 'completed' ? 'completed' : 'in-progress',
      From: this.from,
      To: this.to,
      Direction: 'outbound-api',
    };
    if (handoffData != null) body.HandoffData = handoffData;
    try {
      const { twiml } = await api('/sim/action', { method: 'POST', body });
      const verbs = [...twiml.matchAll(/<(Dial|Hangup|Say)\b[^>]*>([^<]*)/g)].map((m) => `<${m[1]}>${m[2] ? ' ' + m[2] : ''}`);
      if (sessionStatus === 'ended') {
        this.note(`Twilio would now run: ${verbs.join(' ')}`, `➡️ Twilio would now run <code>${esc(verbs.join(' '))}</code>. The simulated call ends here.`);
      }
    } catch (err) {
      this.note(`Action URL failed: ${err.message}`);
    }
    this.onChange();
  }
}
