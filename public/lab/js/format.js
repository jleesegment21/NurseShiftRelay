export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function prettyJson(obj) {
  return JSON.stringify(obj, null, 2);
}

/**
 * Indent single-line TwiML, putting each attribute of busy tags on its own line
 * so <ConversationRelay ...> reads like a parameter list.
 */
export function prettyXml(xml) {
  const lines = String(xml).replace(/>\s*</g, '>\n<').split('\n');
  let depth = 0;
  const out = [];
  for (const line of lines) {
    if (/^<\//.test(line)) depth--;
    const pad = '  '.repeat(Math.max(depth, 0));
    const attrs = line.match(/\s[\w:-]+="[^"]*"/g) || [];
    if (attrs.length > 2 && !/^<\?/.test(line)) {
      const tag = line.match(/^<[\w:-]+/)[0];
      const close = line.endsWith('/>') ? '/>' : '>';
      out.push(pad + tag);
      attrs.forEach((a) => out.push(pad + '    ' + a.trim()));
      out[out.length - 1] += close;
    } else {
      out.push(pad + line);
    }
    if (/^<[^!?/][^>]*[^/]>$/.test(line) && !/<\/[^>]+>$/.test(line)) depth++;
  }
  return out.join('\n');
}

/**
 * Equivalent curl for a REST call. Auth is always the $TWILIO_* placeholders.
 */
export function buildCurl({ method, url, params }) {
  const lines = [`curl --request ${method} \\`, `  --url '${url}' \\`, `  -u '$TWILIO_ACCOUNT_SID:$TWILIO_AUTH_TOKEN'`];
  const entries = Object.entries(params || {}).filter(([k]) => k !== 'CallSid');
  entries.forEach(([k, v], i) => {
    lines[lines.length - 1] += ' \\';
    lines.push(`  --data-urlencode '${k}=${v}'`);
  });
  return lines.join('\n');
}

export function clock(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString('en-US', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0').slice(0, 1);
}

export function codeBlock(code, lang) {
  return `<div class="rp-code"><pre><code class="language-${lang}">${esc(code)}</code></pre></div>`;
}

export function highlight(el) {
  if (window.Prism && el) window.Prism.highlightAllUnder(el);
}

export function truncate(s, n) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

export function toast(message) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 2600);
}

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/lab/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

/** Bucket an event for colours, filters and the diagram. */
export function eventKind(ev) {
  if (ev.kind === 'http') return 'http';
  if (ev.kind === 'rest') return 'rest';
  if (ev.kind === 'ws') return ev.dir === 'in' ? 'wsin' : 'wsout';
  if (ev.kind === 'tool') return 'tool';
  if (ev.kind === 'llm') return 'llm';
  return 'other';
}
