import { api, esc, toast } from './format.js';
import { store, subscribe } from './store.js';
import { Simulator } from './simulator.js';
import { callbackSummaryHtml } from './callbackMap.js';

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

/**
 * Left-pane call controls: simulate a call in the browser, or have Twilio ring your phone.
 */
export function initCallPanel() {
  const el = document.getElementById('call-panel');
  let mode = localStorage.getItem('cr-lab:mode') || 'sim';
  let structureKey = '';
  let recognition = null;

  const sim = new Simulator(() => update());
  sim.playback.voiceOn = localStorage.getItem('cr-lab:voice') === 'on';

  function nurseOptions(selected, shiftId) {
    const shift = store.data?.shifts.find((s) => s.id === shiftId);
    return (store.data?.nurses || [])
      .map((n) => {
        const ok = shift?.eligible.includes(n.id);
        return `<option value="${n.id}" ${n.id === selected ? 'selected' : ''}>${esc(n.firstName)} ${esc(n.lastName)} · ${n.credentials.join('/')} · ${esc(n.units.join(', '))}${shift ? (ok ? ' ✓' : ' (not eligible)') : ''}</option>`;
      })
      .join('');
  }

  function shiftOptions(selected) {
    return (store.data?.shifts || [])
      .map((s) => `<option value="${s.id}" ${s.id === selected ? 'selected' : ''} ${s.status !== 'open' ? 'disabled' : ''}>${s.id} · ${esc(s.unit)} ${esc(s.date)} ${s.start}–${s.end}${s.status !== 'open' ? ' (filled)' : ''}</option>`)
      .join('');
  }

  function pickers(prefix) {
    const shiftId = localStorage.getItem('cr-lab:shift') || store.data?.shifts.find((s) => s.status === 'open')?.id;
    const shift = store.data?.shifts.find((s) => s.id === shiftId);
    const nurseId = localStorage.getItem('cr-lab:nurse') || shift?.eligible[0] || store.data?.nurses[0]?.id;
    return `
      <div class="row">
        <label>Shift</label><select id="${prefix}-shift">${shiftOptions(shiftId)}</select>
        <label>Nurse</label><select id="${prefix}-nurse">${nurseOptions(nurseId, shiftId)}</select>
      </div>`;
  }

  function renderStructure() {
    const key = `${mode}:${sim.state}:${store.data ? 'd' : '-'}:${store.status ? 's' : '-'}`;
    if (key === structureKey) return;
    structureKey = key;

    const seg = `
      <div class="seg">
        <button data-mode="sim" class="${mode === 'sim' ? 'active' : ''}">🧪 Simulate in browser</button>
        <button data-mode="real" class="${mode === 'real' ? 'active' : ''}">📞 Real phone call</button>
      </div>`;

    el.innerHTML = seg + (mode === 'sim' ? simBody() : realBody());
    el.querySelectorAll('[data-mode]').forEach((b) =>
      b.addEventListener('click', () => {
        mode = b.dataset.mode;
        localStorage.setItem('cr-lab:mode', mode);
        update();
      })
    );
    wire();
  }

  function simBody() {
    if (!sim.live) {
      return `
        ${pickers('sim')}
        <div class="row">
          <button class="btn btn-primary" id="sim-start" ${sim.state === 'connecting' ? 'disabled' : ''}>▶ Start simulated call</button>
          <label><input type="checkbox" id="sim-voice" ${sim.playback.voiceOn ? 'checked' : ''}/> 🔊 Speak agent aloud (browser voice)</label>
        </div>
        <div class="hint">Your browser plays Twilio: it fetches the real TwiML, opens the real <code>/ws</code> socket and sends <code>setup</code> / <code>prompt</code> / <code>interrupt</code>. The server can't tell the difference. Needs <code>OPENAI_API_KEY</code>; no Twilio account required.</div>`;
    }
    const nurse = store.data?.nurses.find((n) => n.id === store.calls.get(sim.callSid)?.nurseId);
    const first = nurse?.firstName || 'the nurse';
    const quick = [`Yes, this is ${first}.`, "Sure, I'll take it.", 'What does it pay?', "No thanks, I'm busy that day.", 'Can I talk to a person?', 'Do you have anything else?', "Sorry, wrong number."];
    return `
      <div class="row">
        <span class="agent-state" id="sim-state">listening</span>
        <label><input type="checkbox" id="sim-voice" ${sim.playback.voiceOn ? 'checked' : ''}/> 🔊 Browser voice</label>
        <span style="flex:1"></span>
        <button class="btn btn-ghost" id="sim-hangup">☎ Hang up</button>
      </div>
      <div class="row">
        <input type="text" class="say-box" id="sim-say" placeholder="Speak as ${esc(first)}… (Enter). Typing while the agent talks = barge-in" autocomplete="off" />
        ${SpeechRecognition ? '<button class="btn btn-ghost btn-mic" id="sim-mic" title="Push to talk (Chrome)">🎤</button>' : ''}
        <button class="btn btn-primary" id="sim-send">Send</button>
      </div>
      <div class="row">${quick.map((q) => `<button class="call-chip" data-quick="${esc(q)}">${esc(q)}</button>`).join('')}</div>
      <div class="keypad">${'123456789*0#'.split('').map((d) => `<button data-digit="${d}">${d}</button>`).join('')}</div>`;
  }

  function realBody() {
    const s = store.status || {};
    const phone = localStorage.getItem('cr-lab:phone') || '';
    const ready = s.twilio && s.tunnelLooksReal;
    return `
      <ul class="checklist">
        <li class="${s.twilio ? 'ok' : ''}">Twilio credentials + TWILIO_PHONE_NUMBER in .env</li>
        <li class="${s.tunnelLooksReal ? 'ok' : ''}">SERVER_URL is your public tunnel (${esc(s.serverUrl || 'not set')})</li>
        <li class="${s.openai ? 'ok' : ''}">OPENAI_API_KEY set</li>
        <li class="${s.coordinator ? 'ok' : ''}">STAFFING_COORDINATOR_NUMBER (for transfers)</li>
      </ul>
      ${pickers('real')}
      <div class="row">
        <label>Your phone</label><input type="tel" id="real-phone" placeholder="+14155551234" value="${esc(phone)}" />
        <button class="btn btn-primary" id="real-call" ${ready ? '' : 'disabled'}>📞 Call my phone</button>
      </div>
      <div class="hint">You play the chosen nurse. Answer to talk to the agent, let voicemail pick up to see answering machine detection, or decline to see <code>no-answer</code>. The transcript streams below as it happens.
      </div>${callbackSummaryHtml()}<div class="hint">
      ${s.twilioNumber ? `Inbound: call <code>${esc(s.twilioNumber)}</code> (webhook <code>${esc(s.serverUrl)}/voice</code>). Callers are matched by caller ID to <code>seed/nurses.json</code>.` : ''}</div>`;
  }

  function wire() {
    const $ = (id) => document.getElementById(id);
    for (const prefix of ['sim', 'real']) {
      $(`${prefix}-shift`)?.addEventListener('change', (e) => {
        localStorage.setItem('cr-lab:shift', e.target.value);
        localStorage.removeItem('cr-lab:nurse');
        structureKey = '';
        update();
      });
      $(`${prefix}-nurse`)?.addEventListener('change', (e) => localStorage.setItem('cr-lab:nurse', e.target.value));
    }
    $('sim-voice')?.addEventListener('change', (e) => {
      sim.playback.voiceOn = e.target.checked;
      localStorage.setItem('cr-lab:voice', e.target.checked ? 'on' : 'off');
    });
    $('sim-start')?.addEventListener('click', async () => {
      try {
        await sim.start({ nurseId: $('sim-nurse').value, shiftId: $('sim-shift').value });
      } catch (err) {
        toast(err.message);
      }
    });
    $('sim-hangup')?.addEventListener('click', () => sim.hangup());
    const sayBox = $('sim-say');
    const send = () => {
      sim.say(sayBox.value);
      sayBox.value = '';
    };
    sayBox?.addEventListener('keydown', (e) => e.key === 'Enter' && send());
    $('sim-send')?.addEventListener('click', send);
    sayBox?.focus();
    el.querySelectorAll('[data-quick]').forEach((b) => b.addEventListener('click', () => sim.say(b.dataset.quick)));
    el.querySelectorAll('[data-digit]').forEach((b) => b.addEventListener('click', () => sim.dtmf(b.dataset.digit)));
    $('sim-mic')?.addEventListener('click', toggleMic);

    $('real-call')?.addEventListener('click', async () => {
      const phone = $('real-phone').value.trim();
      localStorage.setItem('cr-lab:phone', phone);
      try {
        const r = await api('/call-me', { method: 'POST', body: { nurseId: $('real-nurse').value, shiftId: $('real-shift').value, phone } });
        store.followLatest = true;
        toast(`Calling ${phone}… (${r.callSid.slice(0, 10)}…)`);
      } catch (err) {
        toast(`Call failed: ${err.message}`);
      }
    });
  }

  // Push-to-talk using the browser's speech recognition (Chrome). Use headphones,
  // otherwise the mic hears the browser voice. Real ConversationRelay cancels echo for you.
  function toggleMic() {
    const btn = document.getElementById('sim-mic');
    if (recognition) {
      recognition.stop();
      return;
    }
    recognition = new SpeechRecognition();
    recognition.lang = 'en-US';
    recognition.interimResults = true;
    recognition.continuous = false;
    let first = true;
    let dropped = false;
    recognition.onresult = (e) => {
      const result = e.results[e.results.length - 1];
      const text = [...e.results].map((r) => r[0].transcript).join(' ');
      if (!result.isFinal) {
        if (sim.partial(text, first) === 'dropped') dropped = true;
        first = false;
      } else {
        if (first) dropped = !sim.bargeIn('speech');
        if (!dropped) sim.say(text, { alreadyHandled: true });
      }
    };
    recognition.onend = () => {
      recognition = null;
      btn?.classList.remove('listening');
    };
    recognition.start();
    btn?.classList.add('listening');
  }

  function update() {
    renderStructure();
    const stateEl = document.getElementById('sim-state');
    if (stateEl) {
      const speaking = sim.playback.speaking;
      stateEl.className = 'agent-state ' + (speaking ? 'speaking' : sim.awaitingReply ? 'thinking' : '');
      stateEl.textContent = speaking ? (sim.inGreeting ? '🔊 welcomeGreeting playing…' : '🔊 agent speaking…') : sim.awaitingReply ? '… waiting for first token' : '👂 listening';
    }
  }

  subscribe((ev) => {
    // Rebuild pickers when data changes, but never mid-call (it would wipe the input box)
    if ((ev.kind === 'ui:data' || ev.kind === 'ui:status' || ev.kind === 'ui:callbacks') && !sim.live) {
      structureKey = '';
      update();
    }
  });
  update();
  return sim;
}
