import { api, esc } from './format.js';
import { store, notifyUi } from './store.js';

/**
 * "Where does Twilio send each callback?" Inbound URLs come from the phone number's
 * Console config (read live via REST); outbound ones are set by this app's code.
 */
export async function loadCallbacks() {
  store.callbacks = await api('/callbacks');
  notifyUi('ui:callbacks');
  return store.callbacks;
}

const OWNER = {
  app: ['🖥 this app', 'ok'],
  external: ['🌐 external', 'warn'],
  unset: ['— not set', ''],
};

function host(url) {
  try {
    return new URL(url.replace(/^wss?:/, 'https:')).host;
  } catch {
    return '';
  }
}

export function callbackMapHtml(data = store.callbacks) {
  if (!data) return `<div class="rp-teach">Loading your number's configuration…</div>`;
  const rows = (flow) =>
    data.callbacks
      .filter((c) => c.flow === flow)
      .map((c) => {
        const [label, cls] = OWNER[c.owner];
        const link = c.owner === 'external' && /webhook\.site/.test(host(c.url))
          ? `<br><a href="https://webhook.site/#!/view/${esc(c.url.split('/').pop())}" target="_blank" rel="noopener">open webhook.site inbox ↗</a>`
          : '';
        return `<tr>
          <td><b>${esc(c.name)}</b><br><small>${esc(c.setIn)}</small></td>
          <td><code>${esc(c.url || '(empty)')}</code><br><small>${esc(c.method || '')}</small> <span class="st ${cls}">${label}</span>${link}</td>
          <td><small>${esc(c.purpose)}</small></td>
        </tr>`;
      })
      .join('');
  const section = (title, flow) => `
    <div class="rp-section-label">${title}</div>
    <table class="tbl"><tr><th style="width:24%">Callback</th><th style="width:38%">URL</th><th>What it's for</th></tr>${rows(flow)}</table>`;

  return `
    ${data.error ? `<ul class="warn-list"><li class="warn">Couldn't read the number config: ${esc(data.error)}</li></ul>` : ''}
    ${data.warnings.length ? `<ul class="warn-list">${data.warnings.map((w) => `<li class="error">${esc(w)}</li>`).join('')}</ul>` : ''}
    ${data.number ? `<div class="hint" style="color:var(--text-invert-muted)">Read live from Twilio: <code>GET IncomingPhoneNumbers?PhoneNumber=${esc(data.number.phoneNumber)}</code> (see the REST row in the Inspector)</div>` : ''}
    ${section('Inbound calls: configured in the Twilio Console', 'inbound')}
    ${section('Outbound calls: set per call by the app (REST)', 'outbound')}
    ${section('Both directions: set in the app\'s TwiML', 'both')}`;
}

/** Compact version for the left-hand "Real phone call" panel. */
export function callbackSummaryHtml(data = store.callbacks) {
  if (!data?.number) return '';
  const status = data.callbacks.find((c) => c.name === 'Call status changes');
  const voice = data.callbacks.find((c) => c.name === 'A call comes in');
  return `<div class="hint">
    Inbound webhook → <code>${esc(voice.url || '(empty)')}</code> ${voice.owner === 'app' && !data.warnings.length ? '✓' : '⚠️'}<br>
    Inbound status callbacks → <code>${esc(status.url || '(empty)')}</code>${status.owner === 'external' ? ' (sent by Twilio directly, not via this app)' : ''}<br>
    Outbound status callbacks → <code>${esc(data.serverUrl)}/status</code> (drives the campaign)
  </div>`;
}
