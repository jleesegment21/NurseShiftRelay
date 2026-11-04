/**
 * Simulates Twilio's TTS playback in the browser so interruptions behave realistically.
 *
 * Text arrives as streamed tokens; it's split into phrases and "played" either with the
 * browser's speechSynthesis (voice on) or a timer at ~15 chars/sec (voice off). At any
 * moment heard() returns how much of the current reply the caller has heard — the same
 * thing ConversationRelay reports as utteranceUntilInterrupt.
 */
export class Playback {
  constructor(onChange) {
    this.onChange = onChange || (() => {});
    this.voiceOn = false;
    this.reset();
  }

  reset() {
    this.queue = [];
    this.pending = '';
    this.turnText = '';
    this.heardChars = 0;
    this.current = null;
    this.turnOpen = false;
    this.turnStart = 0;
  }

  get speaking() {
    return Boolean(this.current) || this.queue.length > 0 || (this.turnOpen && this.pending.trim().length > 0);
  }

  push(token, last) {
    if (!this.turnOpen && !this.speaking) {
      this.turnText = '';
      this.heardChars = 0;
      this.turnStart = Date.now();
    }
    this.turnOpen = true;
    this.turnText += token || '';
    this.pending += token || '';

    // Flush complete phrases so speech starts before the reply is finished — like Twilio
    let m;
    while ((m = this.pending.match(/^[\s\S]*?[.!?;:,](\s+|$)/))) {
      if (!m[1] && !last) break; // punctuation at end of buffer: wait for more
      this.enqueue(m[0]);
      this.pending = this.pending.slice(m[0].length);
    }
    if (last) {
      if (this.pending) this.enqueue(this.pending);
      this.pending = '';
      this.turnOpen = false;
    }
    this.onChange();
  }

  enqueue(text) {
    this.queue.push(text);
    if (!this.current) this.next();
  }

  next() {
    const text = this.queue.shift();
    if (text == null) {
      this.current = null;
      this.onChange();
      return;
    }
    const chunk = { text, start: Date.now(), progress: 0 };
    this.current = chunk;

    if (this.voiceOn && window.speechSynthesis && text.trim()) {
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.05;
      u.onboundary = (e) => (chunk.progress = e.charIndex);
      u.onend = () => this.finish(chunk);
      u.onerror = () => this.finish(chunk);
      chunk.utterance = u;
      window.speechSynthesis.speak(u);
    } else {
      chunk.duration = Math.max(250, (text.length * 1000) / 15);
      chunk.timer = setTimeout(() => this.finish(chunk), chunk.duration);
    }
    this.onChange();
  }

  finish(chunk) {
    if (this.current !== chunk) return;
    this.heardChars += chunk.text.length;
    this.current = null;
    this.next();
  }

  /** Text of the current reply the caller has heard so far (cut at a word boundary). */
  heard() {
    let n = this.heardChars;
    const c = this.current;
    if (c) {
      n += c.utterance ? c.progress : Math.floor(Math.min(1, (Date.now() - c.start) / c.duration) * c.text.length);
    }
    let text = this.turnText.slice(0, n);
    if (n < this.turnText.length && !/\s$/.test(text)) text = text.replace(/\S+$/, '');
    return text.trim();
  }

  unheard() {
    const heard = this.heard();
    return this.turnText.slice(heard.length).trim();
  }

  stop() {
    const c = this.current;
    this.current = null;
    if (c?.timer) clearTimeout(c.timer);
    if (c?.utterance) window.speechSynthesis.cancel();
    this.queue = [];
    this.pending = '';
    this.turnOpen = false;
    this.onChange();
  }

  /** Barge-in: stop audio and report what was heard, like ConversationRelay's interrupt message. */
  interrupt() {
    const heard = this.heard();
    const durationMs = Date.now() - this.turnStart;
    this.stop();
    return { heard, durationMs };
  }
}
