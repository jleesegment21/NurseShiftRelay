/**
 * Client-side store. Receives every server event over SSE (/lab/api/events),
 * plus local events from the browser simulator, and folds them into per-call
 * transcripts.
 */

import { esc } from './format.js';

export const store = {
  events: [],
  calls: new Map(),        // callSid → call model
  activeCallSid: null,
  followLatest: true,
  simCallSids: new Set(),
  status: null,
  data: null,              // nurses / shifts / campaigns
  params: [],
  lastConfigTs: 0,
};

const listeners = new Set();
let localId = -1;

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify(ev) {
  for (const fn of listeners) fn(ev);
}

/** UI-only signals (e.g. 'ui:data' after staffing data reloads). */
export function notifyUi(kind) {
  notify({ kind });
}

export function connect() {
  let opened = false;
  const es = new EventSource('/lab/api/events');
  es.onopen = () => {
    // The server replays its buffer on every (re)connect — start clean to avoid duplicates
    if (opened) reset();
    opened = true;
  };
  es.onmessage = (m) => ingest(JSON.parse(m.data));
  return es;
}

export function reset() {
  store.events = [];
  store.calls.clear();
  store.activeCallSid = null;
  notify({ kind: 'reset' });
}

/** Events created in the browser (simulator notes) — shown alongside server events. */
export function emitLocal(kind, data) {
  ingest({ id: localId--, ts: Date.now(), kind, local: true, ...data });
}

export function setActiveCall(callSid, follow = false) {
  store.activeCallSid = callSid;
  store.followLatest = follow;
  notify({ kind: 'ui:active-call' });
}

export function nurseName(id) {
  const n = store.data?.nurses.find((x) => x.id === id);
  return n ? `${n.firstName} ${n.lastName}` : id;
}

function ingest(ev) {
  store.events.push(ev);
  if (ev.kind === 'config') store.lastConfigTs = ev.ts;
  applyToCall(ev);
  notify(ev);
}

// ─── Call model ──────────────────────────────────────────────────────────────

function getCall(callSid, ts) {
  if (!callSid) return null;
  let call = store.calls.get(callSid);
  if (!call) {
    call = {
      callSid,
      sim: store.simCallSids.has(callSid),
      startedAt: ts,
      status: 'active',
      nurseId: null,
      shiftId: null,
      items: [],
      openAgent: null,
      partial: null,
      turns: 0,
      interrupts: 0,
      toolCalls: 0,
      ttfts: [],
    };
    store.calls.set(callSid, call);
    if (store.followLatest || !store.activeCallSid) store.activeCallSid = callSid;
  }
  return call;
}

function lastOf(call, type) {
  for (let i = call.items.length - 1; i >= 0; i--) if (call.items[i].type === type) return call.items[i];
  return null;
}

function verbs(twiml) {
  return [...String(twiml).matchAll(/<(Connect|ConversationRelay|Say|Dial|Hangup|Play|Gather|Redirect)\b/g)].map((m) => m[1]);
}

function applyToCall(ev) {
  if (ev.kind === 'rest') {
    const sid = ev.response?.sid?.startsWith('CA') ? ev.response.sid : ev.callSid;
    const call = getCall(sid, ev.ts);
    if (!call) return;
    if (ev.error) call.items.push({ type: 'sys', err: true, ev, text: `REST ${ev.method} ${ev.url.split('/').pop()} failed: ${ev.error.message}` });
    else if (ev.url.endsWith('/Calls.json')) call.items.push({ type: 'sys', ev, html: `📞 <b>REST calls.create</b> → Twilio is ringing ${esc(ev.params.To)}` });
    else if (ev.params.Status === 'canceled') call.items.push({ type: 'sys', ev, html: `🛑 <b>REST call update</b> → cancelled (shift was filled)` });
    else if (ev.url.endsWith('/Messages.json')) call.items.push({ type: 'sys', ev, html: `💬 <b>REST messages.create</b> → SMS confirmation sent` });
    return;
  }

  const call = getCall(ev.callSid, ev.ts);
  if (!call) return;
  // Simulated calls are flagged by the server too, so they stay 🧪 after a page reload
  if (ev.simulated || store.simCallSids.has(ev.callSid)) {
    call.sim = true;
    store.simCallSids.add(call.callSid);
  }

  switch (ev.kind) {
    case 'http': {
      const p = ev.params || {};
      const v = verbs(ev.response);
      if (ev.path.startsWith('/voice/outbound')) {
        call.nurseId = p.nurseId;
        call.shiftId = p.shiftId;
        call.items.push({ type: 'sys', ev, html: `🌐 Twilio <b>POST ${esc(ev.path.split('?')[0])}</b> (AnsweredBy=<b>${esc(p.AnsweredBy || '?')}</b>) → TwiML <b>&lt;${v.join('&gt; &lt;')}&gt;</b>` });
      } else if (ev.path.startsWith('/voice')) {
        call.items.push({ type: 'sys', ev, html: `🌐 Inbound call from ${esc(p.From)} → TwiML <b>&lt;${v.join('&gt; &lt;')}&gt;</b>` });
        const statusUrl = store.callbacks?.number?.statusCallback;
        if (statusUrl && !statusUrl.startsWith(store.callbacks.serverUrl)) {
          call.items.push({ type: 'sys', ev, html: `📮 This inbound call's status callbacks go to <code>${esc(statusUrl)}</code> (set in the Console). Twilio sends them there directly, so they won't appear here.` });
        }
      } else if (ev.path.startsWith('/action')) {
        call.status = 'ended';
        call.items.push({ type: 'sys', ev, html: `🌐 Twilio <b>POST /action</b> (SessionStatus=<b>${esc(p.SessionStatus)}</b>) → TwiML <b>&lt;${v.join('&gt; &lt;')}&gt;</b>${v.includes('Dial') ? ' — transferring to the coordinator' : ''}` });
      } else if (ev.path.startsWith('/status')) {
        call.status = 'ended';
        call.items.push({ type: 'sys', ev, html: `🌐 Status callback: call <b>${esc(p.CallStatus)}</b>${p.CallDuration ? ` after ${esc(p.CallDuration)}s` : ''}` });
      }
      if (ev.status >= 400) call.items.push({ type: 'sys', err: true, ev, text: `Webhook returned HTTP ${ev.status} — check signature validation / SERVER_URL` });
      break;
    }

    case 'ws': {
      const m = ev.msg || {};
      if (ev.dir === 'in') {
        if (m.type === 'setup') {
          call.nurseId = m.customParameters?.nurseId || call.nurseId;
          call.shiftId = m.customParameters?.shiftId || call.shiftId;
          call.items.push({ type: 'sys', ev, html: `🔌 WebSocket open — <b>setup</b> received with customParameters` });
          if (m.customParameters?.greeting) {
            call.items.push({ type: 'agent', greeting: true, text: m.customParameters.greeting, done: true });
          }
        } else if (m.type === 'prompt') {
          if (m.last === false) {
            if (!call.partial) {
              call.partial = { type: 'nurse', partial: true, text: '' };
              call.items.push(call.partial);
            }
            call.partial.text = m.voicePrompt;
          } else {
            if (call.partial) {
              call.items.splice(call.items.indexOf(call.partial), 1);
              call.partial = null;
            }
            if (call.openAgent) call.openAgent.done = true;
            call.openAgent = null;
            call.items.push({ type: 'nurse', text: m.voicePrompt, ttft: null });
            call.turns++;
          }
        } else if (m.type === 'interrupt') {
          const agent = lastOf(call, 'agent');
          if (agent) {
            agent.interrupted = true;
            agent.heard = m.utteranceUntilInterrupt ?? '';
          }
          call.interrupts++;
        } else if (m.type === 'dtmf') {
          call.items.push({ type: 'dtmf', digit: m.digit });
        } else if (m.type === 'error') {
          call.items.push({ type: 'sys', err: true, ev, text: `ConversationRelay error: ${m.description}` });
        }
      } else {
        if (m.type === 'text') {
          if (!call.openAgent) {
            if (!m.token && m.last) break; // bare end-of-turn marker
            call.openAgent = { type: 'agent', text: '', tokens: 0, done: false };
            call.items.push(call.openAgent);
          }
          call.openAgent.text += m.token || '';
          call.openAgent.tokens++;
          if (m.last) {
            call.openAgent.done = true;
            call.openAgent = null;
          }
        } else if (m.type === 'end') {
          let handoff = m.handoffData;
          try { handoff = JSON.stringify(JSON.parse(m.handoffData)); } catch {}
          call.items.push({ type: 'sys', ev, html: `🔚 App sent <b>{type:"end"}</b> handoffData=<code>${esc(handoff)}</code>` });
        } else {
          call.items.push({ type: 'sys', ev, html: `→ App sent <b>${esc(m.type)}</b>` });
        }
      }
      break;
    }

    case 'tool':
      call.toolCalls++;
      call.items.push({ type: 'tool', ev, name: ev.name, args: ev.args, result: ev.result });
      break;

    case 'llm':
      if (ev.phase === 'first-token') {
        const nurse = lastOf(call, 'nurse');
        if (nurse && nurse.ttft == null) nurse.ttft = ev.ms;
        call.ttfts.push(ev.ms);
      }
      break;

    case 'outcome':
      call.items.push({ type: 'outcome', text: ev.outcome, notes: ev.notes });
      break;

    case 'session':
      if (ev.event === 'closed') {
        call.status = 'ended';
        if (call.openAgent) call.openAgent.done = true;
        call.openAgent = null;
      }
      break;

    case 'sim':
      call.items.push({ type: 'sys', sim: true, ev, html: ev.html || ev.message });
      break;
  }
}
