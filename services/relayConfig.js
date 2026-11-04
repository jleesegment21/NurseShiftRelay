const PARAMS = require('./relayParams.json');

/**
 * <ConversationRelay> attributes used for every call.
 * Defaults live here; the Lab UI's Parameter Playground can override them at runtime.
 */

const EDITABLE = new Set(PARAMS.filter((p) => p.type !== 'readonly').map((p) => p.name));
let overrides = {};

function defaults(shift) {
  const attrs = {
    ttsProvider: 'ElevenLabs',
    elevenlabsTextNormalization: 'on',
    language: 'en-US',
    interruptible: 'any',
    dtmfDetection: 'true',
  };
  if (shift) attrs.hints = [...new Set([shift.unit, 'ICU', 'Med-Surg', 'Step-Down', 'RN', 'LPN', 'standby'])].join(',');
  if (process.env.TTS_VOICE) attrs.voice = process.env.TTS_VOICE;
  return attrs;
}

/**
 * Effective attributes for a call (defaults + overrides). Empty values are dropped
 * so Twilio's own default applies.
 */
function attributes(shift) {
  const merged = { ...defaults(shift), ...overrides };
  return Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== '' && v != null));
}

/**
 * Replace overrides. A key set to '' explicitly removes our default (falls back to Twilio's).
 */
function setOverrides(next) {
  overrides = {};
  for (const [key, value] of Object.entries(next || {})) {
    if (EDITABLE.has(key) && value != null) overrides[key] = String(value);
  }
  return snapshot();
}

function snapshot(shift) {
  return { defaults: defaults(shift), overrides: { ...overrides }, effective: attributes(shift) };
}

module.exports = { attributes, setOverrides, snapshot, PARAMS };
