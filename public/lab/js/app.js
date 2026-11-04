import { api, esc } from './format.js';
import { store, connect, subscribe, notifyUi } from './store.js';
import { initDiagram } from './diagram.js';
import { initCallPanel } from './callPanel.js';
import { initTranscript } from './transcript.js';
import { initInspector } from './inspector.js';
import { initLessons } from './lessons.js';
import { initPlayground } from './playground.js';
import { initCampaign } from './campaign.js';
import { loadCallbacks } from './callbackMap.js';

function showTab(name) {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-body').forEach((t) => t.classList.toggle('active', t.id === `tab-${name}`));
  localStorage.setItem('cr-lab:tab', name);
}

async function refreshData() {
  store.data = await api('/data');
  notifyUi('ui:data');
}

function renderStatus(sseLive) {
  const s = store.status || {};
  const pill = (ok, okText, badText, level = 'bad') => `<span class="pill ${ok ? 'ok' : level}">${ok ? okText : badText}</span>`;
  document.getElementById('status-pills').innerHTML = [
    `<span class="pill live ${sseLive ? 'ok' : 'bad'}">${sseLive ? 'live stream' : 'reconnecting…'}</span>`,
    pill(s.openai, 'OpenAI ✓', 'OpenAI key missing: agent replies will fail'),
    pill(s.twilio, 'Twilio ✓', 'Twilio creds missing: simulator only', 'warn'),
    pill(s.tunnelLooksReal, 'Tunnel ✓', 'SERVER_URL not a tunnel: real calls off', 'warn'),
  ].join('');
  document.getElementById('brand-tag').textContent = `${s.hospital || 'Nurse Shift Relay'} · agent "${s.agent || 'Ava'}"`;
}

async function boot() {
  const saved = localStorage.getItem('cr-lab:tab') || 'lessons';
  document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

  initDiagram();
  const inspector = initInspector();
  const openEvent = (id) => {
    showTab('inspector');
    inspector.select(id);
  };
  initTranscript({ onOpenEvent: openEvent });
  initLessons({ onOpenEvent: openEvent });
  initPlayground();
  initCampaign({ refreshData });
  initCallPanel();
  showTab(saved);

  store.status = await api('/status');
  renderStatus(false);
  notifyUi('ui:status');
  await refreshData();
  // Where Twilio sends each callback (reads the number's Console config)
  if (store.status.twilio) loadCallbacks().catch((err) => console.warn('callbacks:', err.message));

  const es = connect();
  es.addEventListener('open', () => renderStatus(true));
  es.addEventListener('error', () => renderStatus(false));

  // Staffing state changes when calls book, decline or fill shifts
  let pending = null;
  subscribe((ev) => {
    if (['outcome', 'campaign', 'system'].includes(ev.kind)) {
      clearTimeout(pending);
      pending = setTimeout(refreshData, 300);
    }
  });
}

boot().catch((err) => {
  document.body.insertAdjacentHTML('afterbegin', `<div class="pill bad" style="position:fixed;top:60px;left:20px;z-index:99">Lab failed to start: ${esc(err.message)}</div>`);
  console.error(err);
});
