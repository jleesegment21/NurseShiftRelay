import { api, esc, toast } from './format.js';
import { store, subscribe, nurseName } from './store.js';

/**
 * Campaign tab: open shifts, who's eligible, and the live state of each dialing campaign.
 */
export function initCampaign({ refreshData }) {
  const el = document.getElementById('tab-campaign');

  function render() {
    const d = store.data;
    if (!d) return;
    const campaigns = Object.fromEntries(d.campaigns.map((c) => [c.shiftId, c]));
    el.innerHTML = `
      <div class="rp-header">
        <div><div class="rp-step">The business layer</div><h1 class="rp-title">Shift campaigns</h1></div>
        <button class="btn btn-dark" id="cp-reset">↺ Reset staffing data</button>
      </div>
      <div class="rp-teach">
        <p>A campaign rings eligible nurses <code>CALL_CONCURRENCY</code> at a time, fewest-hours first. Each status callback frees a slot and dials the next nurse. The first <code>accept_shift</code> wins, and calls still ringing get cancelled over REST.</p>
        <p>⚠️ <b>Start campaign places real calls</b> to the numbers in <code>seed/nurses.json</code>. Put your own test phones there first. To try it on just your phone, use <b>📞 Real phone call</b> on the left.</p>
      </div>
      <div class="rp-section-label">Shifts</div>
      <table class="tbl">
        <tr><th>Shift</th><th>Status</th><th>Eligible nurses</th><th>Campaign</th><th></th></tr>
        ${d.shifts
          .map((s) => {
            const c = campaigns[s.id];
            return `<tr>
              <td><b>${s.id}</b><br>${esc(s.description)}${s.incentive ? `<br><small>+ ${esc(s.incentive)}</small>` : ''}</td>
              <td><span class="st ${s.status}">${s.status}</span>${s.filledBy ? `<br><small>${esc(nurseName(s.filledBy))}</small>` : ''}${s.standby.length ? `<br><small>standby: ${s.standby.map((id) => esc(nurseName(id))).join(', ')}</small>` : ''}</td>
              <td>${s.eligible.map((id) => esc(nurseName(id))).join('<br>') || '—'}</td>
              <td>${c ? `<span class="st ${c.status}">${c.status}</span><br><small>${c.activeCalls} ringing/live · ${c.queued.length} queued</small>` : '—'}</td>
              <td><button class="btn btn-primary" data-start="${s.id}" ${s.status !== 'open' || c?.status === 'running' || !store.status?.twilio ? 'disabled' : ''}>Start campaign</button></td>
            </tr>`;
          })
          .join('')}
      </table>
      ${d.campaigns
        .map(
          (c) => `<div class="rp-section-label">Attempts for ${c.shiftId}</div>
          <table class="tbl"><tr><th>Nurse</th><th>Call</th><th>Status</th><th>Outcome</th></tr>
          ${c.attempts.map((a) => `<tr><td>${esc(a.nurse)}</td><td><small>${esc(a.callSid || '—')}</small></td><td>${esc(a.status)}</td><td>${esc(a.outcome || '')}${a.error ? `<br><small>${esc(a.error)}</small>` : ''}</td></tr>`).join('')}
          </table>`
        )
        .join('')}`;

    el.querySelectorAll('[data-start]').forEach((b) =>
      b.addEventListener('click', async () => {
        if (!confirm(`Place REAL calls to the eligible nurses for ${b.dataset.start}?`)) return;
        try {
          await api(`/campaign/${b.dataset.start}/start`, { method: 'POST' });
          toast('Campaign started');
          refreshData();
        } catch (err) {
          toast(err.message);
        }
      })
    );
    el.querySelector('#cp-reset').addEventListener('click', async () => {
      await api('/reset-data', { method: 'POST' });
      toast('Staffing data reset');
      refreshData();
    });
  }

  subscribe((ev) => ev.kind === 'ui:data' && render());
  render();
}
