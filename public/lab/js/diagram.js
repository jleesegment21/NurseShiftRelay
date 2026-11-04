import { esc, truncate } from './format.js';
import { subscribe } from './store.js';

/**
 * The live architecture diagram. Edges pulse as real events flow through them.
 *
 *  Nurse ⇄ audio ⇄ Twilio ⇄ [HTTP | WS in | WS out | REST] ⇄ Your server ⇄ LLM / tools
 */
export function initDiagram() {
  const el = document.getElementById('diagram');
  el.innerHTML = `
    <div class="dg-node"><div class="dg-icon">📱</div><div class="dg-name">Nurse</div><div class="dg-sub">phone / browser</div></div>
    <div class="dg-edges"><div class="dg-edge" data-edge="audio"><span>audio</span></div></div>
    <div class="dg-node twilio"><div class="dg-icon">🔴</div><div class="dg-name">Twilio</div><div class="dg-sub">ConversationRelay<br>STT · TTS · barge-in</div></div>
    <div class="dg-edges">
      <div class="dg-edge" data-edge="http"><span>HTTP webhook ⇄ TwiML</span></div>
      <div class="dg-edge" data-edge="wsin"><span>WS → setup / prompt</span></div>
      <div class="dg-edge" data-edge="wsout"><span>WS ← text / end</span></div>
      <div class="dg-edge" data-edge="rest"><span>REST API</span></div>
    </div>
    <div class="dg-node server"><div class="dg-icon">🖥</div><div class="dg-name">Your server</div><div class="dg-sub">Express + ws<br>session per call</div></div>
    <div class="dg-edges">
      <div class="dg-edge" data-edge="llm"><span>stream</span></div>
      <div class="dg-edge" data-edge="tool"><span>tools</span></div>
    </div>
    <div class="dg-node"><div class="dg-icon">🧠</div><div class="dg-name">LLM</div><div class="dg-sub">GPT-4o<br>+ staffing tools</div></div>
  `;

  const edges = Object.fromEntries([...el.querySelectorAll('.dg-edge')].map((e) => [e.dataset.edge, e]));
  const defaults = Object.fromEntries(Object.entries(edges).map(([k, e]) => [k, e.querySelector('span').textContent]));
  const timers = {};

  function pulse(edge, text) {
    const e = edges[edge];
    if (!e) return;
    e.classList.remove('pulse');
    void e.offsetWidth; // restart animation
    e.classList.add('pulse');
    if (text) e.querySelector('span').innerHTML = esc(truncate(text, 34));
    clearTimeout(timers[edge]);
    timers[edge] = setTimeout(() => {
      e.classList.remove('pulse');
      e.querySelector('span').textContent = defaults[edge];
    }, 1800);
  }

  subscribe((ev) => {
    if (ev.kind === 'http') pulse('http', `${ev.path.split('?')[0]} → TwiML`);
    else if (ev.kind === 'rest') pulse('rest', ev.url.split('/').pop());
    else if (ev.kind === 'ws' && ev.dir === 'in') {
      pulse('wsin', ev.msg?.type);
      if (ev.msg?.type === 'prompt' || ev.msg?.type === 'dtmf') pulse('audio', 'nurse speaks → STT');
    } else if (ev.kind === 'ws' && ev.dir === 'out') {
      pulse('wsout', ev.msg?.type === 'text' ? `text "${ev.msg.token}"` : ev.msg?.type);
      if (ev.msg?.type === 'text') pulse('audio', 'TTS → nurse hears');
    } else if (ev.kind === 'llm') pulse('llm', ev.phase);
    else if (ev.kind === 'tool') pulse('tool', ev.name);
  });
}
