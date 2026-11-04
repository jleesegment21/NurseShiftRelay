const { EventEmitter } = require('events');

/**
 * In-process event bus for the ConversationRelay Lab UI (/lab).
 * Every webhook, REST call, WebSocket frame, tool call and LLM timing is
 * emitted here and streamed to the browser over Server-Sent Events.
 */

const MAX_EVENTS = 5000;
const emitter = new EventEmitter();
emitter.setMaxListeners(50);
const buffer = [];
let nextId = 1;

function emit(kind, data = {}) {
  const event = { id: nextId++, ts: Date.now(), kind, ...data };
  buffer.push(event);
  if (buffer.length > MAX_EVENTS) buffer.shift();
  emitter.emit('event', event);
  return event;
}

function recent() {
  return buffer.slice();
}

function subscribe(fn) {
  emitter.on('event', fn);
  return () => emitter.off('event', fn);
}

function clear() {
  buffer.length = 0;
}

module.exports = { emit, recent, subscribe, clear };
