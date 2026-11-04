import { esc, prettyJson, prettyXml, buildCurl, clock, codeBlock, highlight, eventKind } from './format.js';
import { store, subscribe, reset } from './store.js';
import { explain, label } from './explain.js';

const KINDS = [
  ['http', 'HTTP webhooks'],
  ['rest', 'REST API'],
  ['wsin', 'WS ← Twilio'],
  ['wsout', 'WS → Twilio'],
  ['tool', 'Tools'],
  ['llm', 'LLM timing'],
  ['other', 'Other'],
];
const KIND_LABEL = { http: 'HTTP', rest: 'REST', wsin: 'WS ←', wsout: 'WS →', tool: 'TOOL', llm: 'LLM', other: 'INFO' };

/**
 * Collapse runs of streamed `text` frames into one row so a reply reads as a unit.
 */
export function groupEvents(events, { collapse = true } = {}) {
  const rows = [];
  const runs = new Map(); // callSid → open group (LLM timing rows can interleave with tokens)
  for (const ev of events) {
    const isToken = ev.kind === 'ws' && ev.dir === 'out' && ev.msg?.type === 'text';
    if (collapse && isToken) {
      let run = runs.get(ev.callSid);
      if (!run) {
        run = { ...ev, group: [], text: '' };
        runs.set(ev.callSid, run);
        rows.push(run);
      }
      run.group.push(ev);
      run.text += ev.msg.token || '';
      if (ev.msg.last) runs.delete(ev.callSid);
      continue;
    }
    // Caller input or the end of the session closes the reply
    if (ev.kind === 'ws' || ev.kind === 'session') runs.delete(ev.callSid);
    rows.push(ev);
  }
  return rows;
}

export function rowLabel(ev) {
  if (ev.group) return `text ×${ev.group.length} frames: "${ev.text}"${ev.group.at(-1).msg.last ? ' · last:true' : ' …streaming'}`;
  return label(ev);
}

export function initInspector() {
  const el = document.getElementById('tab-inspector');
  const filters = new Set(JSON.parse(localStorage.getItem('cr-lab:filters') || 'null') || ['http', 'rest', 'wsin', 'wsout', 'tool', 'llm', 'other']);
  let thisCallOnly = false;
  let collapse = true;
  let selectedId = null;
  let scheduled = false;

  el.innerHTML = `
    <div class="rp-header">
      <div><div class="rp-step">Everything on the wire</div><h1 class="rp-title">Inspector</h1></div>
      <a class="rp-concept" href="https://www.twilio.com/docs/voice/conversationrelay/websocket-messages" target="_blank" rel="noopener">WebSocket messages ↗</a>
    </div>
    <div class="insp-toolbar">
      ${KINDS.map(([k, l]) => `<button class="fchip ${filters.has(k) ? 'on' : ''}" data-k="${k}">${l}</button>`).join('')}
      <span style="flex:1"></span>
      <label><input type="checkbox" id="insp-call"/> selected call only</label>
      <label><input type="checkbox" id="insp-collapse" checked/> group text frames</label>
      <button class="btn btn-dark" id="insp-clear">Clear</button>
    </div>
    <div class="ev-list" id="ev-list"></div>
    <div class="ev-detail" id="ev-detail"><div class="rp-teach">Click any row to see the raw payload and what it means. Rows appear live as calls happen.</div></div>
  `;

  el.querySelectorAll('.fchip').forEach((b) =>
    b.addEventListener('click', () => {
      const k = b.dataset.k;
      filters.has(k) ? filters.delete(k) : filters.add(k);
      b.classList.toggle('on');
      localStorage.setItem('cr-lab:filters', JSON.stringify([...filters]));
      renderList();
    })
  );
  el.querySelector('#insp-call').addEventListener('change', (e) => ((thisCallOnly = e.target.checked), renderList()));
  el.querySelector('#insp-collapse').addEventListener('change', (e) => ((collapse = e.target.checked), renderList()));
  el.querySelector('#insp-clear').addEventListener('click', async () => {
    await fetch('/lab/api/events/clear', { method: 'POST' });
    reset();
  });

  const listEl = el.querySelector('#ev-list');
  const detailEl = el.querySelector('#ev-detail');

  function visibleRows() {
    let events = store.events.filter((ev) => filters.has(eventKind(ev)));
    if (thisCallOnly) events = events.filter((ev) => ev.callSid === store.activeCallSid);
    return groupEvents(events, { collapse }).slice(-400);
  }

  function renderList() {
    const nearBottom = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 60;
    const rows = visibleRows();
    listEl.innerHTML = rows.length
      ? rows
          .map((ev) => {
            const k = eventKind(ev);
            return `<div class="ev-row ${ev.id === selectedId ? 'sel' : ''}" data-id="${ev.id}">
              <span class="t">${clock(ev.ts)}</span>
              <span class="k k-${k}">${KIND_LABEL[k]}</span>
              <span class="d">${esc(rowLabel(ev))}${ev.simulated || ev.local || store.simCallSids.has(ev.callSid) ? '<span class="sim">sim</span>' : ''}</span>
            </div>`;
          })
          .join('')
      : `<div class="ev-row"><span></span><span></span><span class="d">No events yet. Start a call on the left.</span></div>`;
    listEl.querySelectorAll('[data-id]').forEach((r) => r.addEventListener('click', () => select(Number(r.dataset.id))));
    if (nearBottom) listEl.scrollTop = listEl.scrollHeight;
  }

  function payloadFor(ev) {
    const parts = [];
    if (ev.kind === 'http') {
      parts.push(['Request: what Twilio POSTed (form params)', codeBlock(prettyJson(ev.params), 'json')]);
      if (ev.response) parts.push([`Response: what the server returned (HTTP ${ev.status})`, codeBlock(/^\s*</.test(ev.response) ? prettyXml(ev.response) : ev.response, 'markup')]);
    } else if (ev.kind === 'rest') {
      parts.push(['Request (equivalent curl)', codeBlock(buildCurl(ev), 'bash')]);
      parts.push(['Response', codeBlock(prettyJson(ev.error || ev.response), 'json')]);
    } else if (ev.group) {
      parts.push([`Reassembled reply (${ev.group.length} frames)`, `<div class="rp-teach">${esc(ev.text)}</div>`]);
      const sample = ev.group.length > 8 ? [...ev.group.slice(0, 6), ev.group.at(-1)] : ev.group;
      parts.push([
        `Raw frames${ev.group.length > 8 ? ` (first 6 + last of ${ev.group.length})` : ''}`,
        codeBlock(sample.map((g) => JSON.stringify(g.msg)).join('\n'), 'json'),
      ]);
    } else if (ev.kind === 'ws') {
      parts.push([`Raw frame (${ev.dir === 'in' ? 'Twilio → your server' : 'your server → Twilio'})`, codeBlock(prettyJson(ev.msg), 'json')]);
    } else {
      const { id, ts, kind, ...rest } = ev;
      parts.push(['Event data', codeBlock(prettyJson(rest), 'json')]);
    }
    return parts.map(([title, html]) => `<div class="rp-section-label">${title}</div>${html}`).join('');
  }

  function select(id) {
    selectedId = id;
    const ev = visibleRows().find((r) => r.id === id) || store.events.find((e) => e.id === id);
    if (!ev) return;
    const info = explain(ev.group ? ev.group[0] : ev);
    detailEl.innerHTML = `
      <div class="rp-header">
        <h3>${esc(info.title)}</h3>
        ${info.docs ? `<a class="rp-concept" href="${info.docs}" target="_blank" rel="noopener">docs ↗</a>` : ''}
      </div>
      ${info.html ? `<div class="rp-teach">${info.html}</div>` : ''}
      ${payloadFor(ev)}`;
    highlight(detailEl);
    renderList();
  }

  subscribe(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      renderList();
    });
  });
  renderList();

  return { select };
}
