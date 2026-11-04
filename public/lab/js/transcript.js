import { esc, truncate } from './format.js';
import { store, subscribe, setActiveCall, nurseName } from './store.js';

/**
 * Live transcript of the selected call, plus the call picker and metrics strip.
 */
export function initTranscript({ onOpenEvent }) {
  const listEl = document.getElementById('call-list');
  const metricsEl = document.getElementById('metrics');
  const el = document.getElementById('transcript');
  let scheduled = false;

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      render();
    });
  }

  function renderCallList() {
    const calls = [...store.calls.values()].filter((c) => c.items.length).slice(-6);
    if (!calls.length) {
      listEl.innerHTML = '';
      return;
    }
    listEl.innerHTML =
      calls
        .map(
          (c) =>
            `<button class="call-chip ${c.callSid === store.activeCallSid ? 'active' : ''} ${c.status === 'ended' ? 'ended' : ''}" data-call="${c.callSid}">
              <span class="dot"></span>${c.sim ? '🧪' : '📞'} ${esc(c.nurseId ? nurseName(c.nurseId) : c.callSid.slice(0, 10) + '…')}${c.shiftId ? ` · ${esc(c.shiftId)}` : ''}
            </button>`
        )
        .join('') +
      `<label style="margin-left:6px"><input type="checkbox" id="follow-latest" ${store.followLatest ? 'checked' : ''}/> follow newest call</label>`;
    listEl.querySelectorAll('[data-call]').forEach((b) => b.addEventListener('click', () => setActiveCall(b.dataset.call, false)));
    listEl.querySelector('#follow-latest').addEventListener('change', (e) => {
      store.followLatest = e.target.checked;
      if (e.target.checked) {
        const latest = [...store.calls.keys()].pop();
        if (latest) setActiveCall(latest, true);
      }
    });
  }

  function renderMetrics(call) {
    if (!call) {
      metricsEl.innerHTML = '';
      return;
    }
    const avg = call.ttfts.length ? Math.round(call.ttfts.reduce((a, b) => a + b, 0) / call.ttfts.length) : null;
    const dur = Math.round(((call.status === 'ended' ? lastTs(call) : Date.now()) - call.startedAt) / 1000);
    metricsEl.innerHTML = [
      [call.turns, 'nurse turns'],
      [avg != null ? `${avg} ms` : '—', 'avg time to first token'],
      [call.interrupts, 'interruptions'],
      [call.toolCalls, 'tool calls'],
      [`${dur}s`, call.status === 'ended' ? 'call ended' : 'call live'],
    ]
      .map(([v, l]) => `<div class="metric"><div class="m-val">${v}</div><div class="m-lbl">${l}</div></div>`)
      .join('');
  }

  function lastTs(call) {
    const evs = store.events.filter((e) => e.callSid === call.callSid);
    return evs.length ? evs[evs.length - 1].ts : call.startedAt;
  }

  function item(i) {
    if (i.type === 'agent') {
      let body;
      if (i.interrupted) {
        const heard = i.heard || '';
        const rest = i.text.startsWith(heard) ? i.text.slice(heard.length) : '';
        body = `${esc(heard)}<span class="unheard">${esc(rest)}</span><span class="cut">✂ interrupted. The nurse only heard the unstruck part (<code>utteranceUntilInterrupt</code>)</span>`;
      } else {
        body = esc(i.text) + (i.done ? '' : '<span class="caret"></span>');
      }
      const meta = i.greeting ? 'Agent · welcomeGreeting, spoken by Twilio (no LLM)' : `Agent · LLM, streamed as ${i.tokens || 0} text frames`;
      return `<div class="bubble agent ${i.greeting ? 'greeting' : ''}"><span class="meta">${meta}</span>${body}</div>`;
    }
    if (i.type === 'nurse') {
      const cls = i.ttft == null ? '' : i.ttft < 800 ? 'fast' : i.ttft < 1500 ? 'ok' : 'slow';
      const ttft = i.ttft != null ? `<br><span class="ttft ${cls}">⏱ ${i.ttft} ms until the agent's first word</span>` : '';
      return `<div class="bubble nurse ${i.partial ? 'partial' : ''}"><span class="meta">Nurse · ${i.partial ? 'partial prompt (last:false)' : 'prompt'}</span>${esc(i.text)}${ttft}</div>`;
    }
    if (i.type === 'tool') {
      return `<div class="tool-chip" data-ev="${i.ev.id}">🛠 <code>${esc(i.name)}</code>(${esc(truncate(JSON.stringify(i.args), 80))}) → ${esc(truncate(i.result, 110))}</div>`;
    }
    if (i.type === 'outcome') return `<div class="outcome-chip">📋 outcome: ${esc(i.text)}${i.notes ? ` · ${esc(i.notes)}` : ''}</div>`;
    if (i.type === 'dtmf') return `<div class="dtmf-chip">⌨ pressed ${esc(i.digit)}</div>`;
    if (i.type === 'sys') {
      return `<div class="sys ${i.err ? 'err' : ''} ${i.sim ? 'sim' : ''}" ${i.ev ? `data-ev="${i.ev.id}"` : ''}>${i.html || esc(i.text)}</div>`;
    }
    return '';
  }

  function render() {
    renderCallList();
    const call = store.calls.get(store.activeCallSid);
    renderMetrics(call);
    if (!call) {
      el.innerHTML = `<div class="empty">No calls yet.<br><br>Start a <b>simulated call</b> above to talk to the agent from this browser, or switch to <b>Real phone call</b> to have Twilio ring you.<br><br>Every message will appear here and in the Inspector.</div>`;
      return;
    }
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    el.innerHTML = call.items.map(item).join('');
    el.querySelectorAll('[data-ev]').forEach((n) => n.addEventListener('click', () => onOpenEvent(Number(n.dataset.ev))));
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }

  subscribe(schedule);
  setInterval(() => store.calls.get(store.activeCallSid)?.status === 'active' && renderMetrics(store.calls.get(store.activeCallSid)), 1000);
  render();
}
