import { api, esc, prettyXml, codeBlock, highlight, toast } from './format.js';
import { store } from './store.js';

/**
 * Parameter Playground: every <ConversationRelay> attribute, what it does, what to
 * consider, live TwiML preview, combination warnings — and Apply, which changes the
 * TwiML the server returns for the next call (real or simulated).
 */
export function initPlayground() {
  const el = document.getElementById('tab-params');
  let params = [];
  let config = { defaults: {}, overrides: {}, effective: {} };
  let draft = {};

  async function load() {
    [params, config] = await Promise.all([api('/params'), api('/config')]);
    store.params = params;
    draft = { ...config.overrides };
    render();
  }

  // What the TwiML would contain: app defaults, then draft overrides; '' = attribute removed
  function effective() {
    const merged = { ...config.defaults, ...draft };
    return Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== '' && v != null));
  }

  function warnings(a) {
    const out = [];
    const provider = a.ttsProvider || 'ElevenLabs';
    if (a.voice) {
      if (provider === 'Google' && !/^[a-z]{2,3}-[A-Z]{2}-/.test(a.voice))
        out.push(['error', `voice "${a.voice}" doesn't look like a Google voice (e.g. en-US-Chirp3-HD-Aoede). Invalid combos never connect the WebSocket → error 64101.`]);
      if (provider === 'Amazon' && /^[A-Za-z0-9]{20}/.test(a.voice))
        out.push(['error', `voice "${a.voice}" looks like an ElevenLabs ID but ttsProvider is Amazon → 64101.`]);
      if (provider === 'ElevenLabs' && /^[a-z]{2}-[A-Z]{2}-/.test(a.voice))
        out.push(['error', `voice "${a.voice}" looks like a Google voice but ttsProvider is ElevenLabs → 64101.`]);
    } else if (config.defaults.voice && draft.ttsProvider && draft.ttsProvider !== 'ElevenLabs') {
      out.push(['warn', 'TTS_VOICE from .env is an ElevenLabs voice. Clear or change voice when switching provider.']);
    }
    if (a.elevenlabsTextNormalization && provider !== 'ElevenLabs')
      out.push(['info', 'elevenlabsTextNormalization only applies to ElevenLabs. The model must spell out numbers itself.']);
    if (a.eotThreshold && !(a.transcriptionProvider !== 'Google' && /flux/i.test(a.speechModel || '')))
      out.push(['warn', 'eotThreshold only applies with Deepgram + a Flux speechModel.']);
    if (a.speechTimeout && a.speechTimeout !== 'auto' && (Number(a.speechTimeout) < 600 || Number(a.speechTimeout) > 5000))
      out.push(['error', 'speechTimeout must be 600–5000 ms (or auto).']);
    if (a.language === 'multi' && (provider !== 'ElevenLabs' || a.transcriptionProvider === 'Google'))
      out.push(['error', 'language "multi" requires ElevenLabs TTS and Deepgram STT.']);
    if ((a.interruptible === 'none' || a.interruptible === 'false') && (a.reportInputDuringAgentSpeech || 'none') === 'none')
      out.push(['info', 'interruptible=none + reportInputDuringAgentSpeech=none: anything the nurse says while the agent talks is lost.']);
    if (a.interruptible === 'none' && a.welcomeGreetingInterruptible !== 'none')
      out.push(['info', 'The greeting is still interruptible: welcomeGreetingInterruptible defaults to "any".']);
    if (a.partialPrompts === 'true') out.push(['info', 'partialPrompts: this app ignores last:false prompts (see handlePrompt). Watch them in the Inspector.']);
    if (a.applicationReconnect === 'true') out.push(['warn', 'applicationReconnect: this app does not restore sessions on reconnect yet. A reconnect starts with empty history.']);
    if (a.dtmfDetection !== 'true') out.push(['info', 'dtmfDetection off: keypresses never reach your app.']);
    return out;
  }

  function preview(a) {
    const attrs = Object.entries({ url: 'wss://your-tunnel/ws', welcomeGreeting: 'Hi, this is Ava… Am I speaking with Marcus?', ...a })
      .map(([k, v]) => ` ${k}="${String(v).replace(/"/g, '&quot;')}"`)
      .join('');
    return prettyXml(
      `<Response><Connect action="https://your-tunnel/action"><ConversationRelay${attrs}><Parameter name="nurseId" value="N002"/><Parameter name="shiftId" value="S1001"/></ConversationRelay></Connect></Response>`
    );
  }

  function control(p) {
    const value = p.name in draft ? draft[p.name] : config.defaults[p.name] ?? '';
    const twilioDefault = `Twilio default${p.default ? ` (${p.default})` : ''}`;
    if (p.type === 'readonly') return `<input type="text" value="set per call" disabled />`;
    if (p.type === 'enum' || p.type === 'bool') {
      const values = p.type === 'bool' ? ['true', 'false'] : p.values.filter((v) => v !== '');
      return `<select data-p="${p.name}"><option value="" ${value === '' ? 'selected' : ''}>— ${esc(twilioDefault)}</option>${values
        .map((v) => `<option ${v === value ? 'selected' : ''}>${esc(v)}</option>`)
        .join('')}</select>`;
    }
    return `<input type="${p.type === 'number' ? 'number' : 'text'}" data-p="${p.name}" value="${esc(value)}" placeholder="${esc(p.placeholder || twilioDefault)}" ${p.min != null ? `min="${p.min}" max="${p.max}" step="${p.step || 1}"` : ''} />`;
  }

  function render() {
    const a = effective();
    const groups = [...new Set(params.map((p) => p.group))];
    const dirty = JSON.stringify(draft) !== JSON.stringify(config.overrides);

    el.innerHTML = `
      <div class="rp-header">
        <div><div class="rp-step">Every attribute of the verb</div><h1 class="rp-title">Parameter Playground</h1></div>
        <a class="rp-concept" href="https://www.twilio.com/docs/voice/twiml/connect/conversationrelay" target="_blank" rel="noopener">&lt;ConversationRelay&gt; reference ↗</a>
      </div>
      <div class="rp-teach">
        <p>These attributes are the whole configuration of the voice session. Change them, click <b>Apply</b>, and the <b>next call</b> (simulated or real) gets the new TwiML. A call in progress keeps its own.</p>
        <p><span class="ptag sim">sim</span> the browser simulator emulates it · <span class="ptag real">real call</span> only audible on a real phone call (voice, STT…) · <span class="ptag code">app code</span> also needs handling in your server</p>
      </div>
      <div class="pg-actions">
        <button class="btn btn-primary" id="pg-apply" ${dirty ? '' : 'disabled'}>Apply to next call</button>
        <button class="btn btn-dark" id="pg-revert" ${dirty ? '' : 'disabled'}>Revert</button>
        <span class="spacer"></span>
        <button class="btn btn-dark" id="pg-defaults">Reset to app defaults</button>
      </div>
      <div class="rp-section-label">Warnings for this combination</div>
      <ul class="warn-list">${warnings(a).map(([lvl, msg]) => `<li class="${lvl}">${esc(msg)}</li>`).join('') || '<li class="info">No issues detected.</li>'}</ul>
      <div class="rp-section-label">TwiML preview</div>
      <div id="pg-preview">${codeBlock(preview(a), 'markup')}</div>
      ${groups
        .map(
          (g) => `<div class="pg-group"><h3>${esc(g)}</h3>${params
            .filter((p) => p.group === g)
            .map(
              (p) => `<div class="pg-row ${p.name in draft ? 'modified' : ''}">
                <div class="pn"><code>${p.name}</code><span class="pdef">default: ${esc(p.default)}</span>
                  ${p.sim ? '<span class="ptag sim">sim</span>' : '<span class="ptag real">real call</span>'}${p.appCode ? '<span class="ptag code">app code</span>' : ''}</div>
                <div>${control(p)}</div>
                <div class="pd">${esc(p.description)}<span class="consider">💡 ${esc(p.consider)}</span></div>
              </div>`
            )
            .join('')}</div>`
        )
        .join('')}
      <div class="rp-section-label">Also worth knowing</div>
      <div class="rp-teach">
        <p><code>&lt;Language code="es-US" ttsProvider voice transcriptionProvider speechModel/&gt;</code> children set per-language voices; switch mid-call with a <code>{"type":"language"}</code> message.</p>
        <p><code>&lt;Parameter name value/&gt;</code> children become <code>setup.customParameters</code>. This app sends nurseId, shiftId, direction and greeting.</p>
      </div>`;

    el.querySelectorAll('[data-p]').forEach((c) =>
      c.addEventListener('change', () => {
        const name = c.dataset.p;
        const fallback = config.defaults[name] ?? '';
        if (c.value === fallback && !(name in config.overrides)) delete draft[name];
        else draft[name] = c.value;
        const scroll = el.scrollTop;
        render();
        el.scrollTop = scroll;
      })
    );
    el.querySelector('#pg-apply').addEventListener('click', apply);
    el.querySelector('#pg-revert').addEventListener('click', () => ((draft = { ...config.overrides }), render()));
    el.querySelector('#pg-defaults').addEventListener('click', () => ((draft = {}), apply()));
    highlight(el);
  }

  async function apply() {
    config = await api('/config', { method: 'PUT', body: { overrides: draft } });
    draft = { ...config.overrides };
    const scroll = el.scrollTop;
    render();
    el.scrollTop = scroll;
    toast(Object.keys(draft).length ? `Applied ${Object.keys(draft).length} override(s). Start a new call to hear it.` : 'Back to app defaults');
  }

  load();
}
