import { esc, clock, codeBlock, highlight, eventKind } from './format.js';
import { store, subscribe } from './store.js';
import { LESSONS } from './lessonData.js';
import { groupEvents, rowLabel } from './inspector.js';
import { callbackMapHtml, loadCallbacks } from './callbackMap.js';

const KEY_INDEX = 'cr-lab:lesson';
const KEY_DONE = 'cr-lab:tasks';
const KIND_LABEL = { http: 'HTTP', rest: 'REST', wsin: 'WS ←', wsout: 'WS →', tool: 'TOOL', llm: 'LLM', other: 'INFO' };

/**
 * Guided lessons in the Qualtrics-demo format: one concept per step, teach caption,
 * the real code, and tasks that tick themselves off when the matching frame happens.
 */
export function initLessons({ onOpenEvent }) {
  const el = document.getElementById('tab-lessons');
  let index = Math.min(Number(localStorage.getItem(KEY_INDEX) || 0), LESSONS.length - 1);
  const done = new Set(JSON.parse(localStorage.getItem(KEY_DONE) || '[]'));
  let scheduled = false;

  function save() {
    localStorage.setItem(KEY_INDEX, String(index));
    localStorage.setItem(KEY_DONE, JSON.stringify([...done]));
  }

  function lessonDone(lesson) {
    return lesson.tasks.length > 0 && lesson.tasks.every((t) => done.has(`${lesson.id}:${t.id}`));
  }

  function check(ev) {
    let changed = false;
    for (const lesson of LESSONS) {
      for (const task of lesson.tasks) {
        const key = `${lesson.id}:${task.id}`;
        if (!done.has(key) && safe(() => task.done(ev, store))) {
          done.add(key);
          changed = true;
        }
      }
    }
    if (changed) {
      save();
      updateBadge();
    }
    return changed;
  }

  function safe(fn) {
    try {
      return fn();
    } catch {
      return false;
    }
  }

  function updateBadge() {
    const tab = document.querySelector('[data-tab=lessons]');
    const total = LESSONS.reduce((n, l) => n + l.tasks.length, 0);
    tab.innerHTML = `📘 Lessons <span class="badge">${done.size}/${total}</span>`;
  }

  function framesHtml(lesson) {
    const rows = groupEvents(store.events.filter((ev) => safe(() => lesson.watch(ev)))).slice(-8);
    if (!rows.length) return `<div class="rp-teach">No matching frames yet. Do one of the tasks above and they'll appear here live.</div>`;
    return `<div class="ev-list frames">${rows
      .map((ev) => {
        const k = eventKind(ev);
        return `<div class="ev-row" data-id="${ev.id}"><span class="t">${clock(ev.ts)}</span><span class="k k-${k}">${KIND_LABEL[k]}</span><span class="d">${esc(rowLabel(ev))}</span></div>`;
      })
      .join('')}</div>`;
  }

  function render() {
    const lesson = LESSONS[index];
    const tasksHtml = lesson.tasks.length
      ? `<div class="rp-section-label">Try it: these tick off automatically</div>
         <ul class="tasks">${lesson.tasks
           .map((t) => `<li class="${done.has(`${lesson.id}:${t.id}`) ? 'done' : ''}"><span class="check"></span><span><span class="label">${esc(t.label)}</span><span class="how">${esc(t.how)}</span></span></li>`)
           .join('')}</ul>`
      : '';

    el.innerHTML = `
      <div class="lesson-dots">${LESSONS.map((l, i) => `<button class="lesson-dot ${i === index ? 'active' : ''} ${lessonDone(l) ? 'done' : ''}" data-i="${i}" title="${esc(l.title)}">${i + 1}</button>`).join('')}</div>
      <div class="rp-header">
        <div><div class="rp-step">Lesson ${index + 1} of ${LESSONS.length}</div><h1 class="rp-title">${esc(lesson.title)}</h1></div>
        <a class="rp-concept" href="${lesson.docsUrl}" target="_blank" rel="noopener">${esc(lesson.concept)} ↗</a>
      </div>
      <div class="rp-teach">${lesson.teach}</div>
      ${lesson.widget === 'callbacks' ? `<div id="lesson-widget">${callbackMapHtml()}</div>` : ''}
      ${tasksHtml}
      ${lesson.code ? `<div class="rp-section-label">In this project: ${esc(lesson.code.file)}</div>${codeBlock(lesson.code.snippet, lesson.code.lang)}` : ''}
      ${lesson.tasks.length ? `<div class="rp-section-label">Live frames for this lesson (click to inspect)</div><div id="lesson-frames">${framesHtml(lesson)}</div>` : ''}
      <div class="lesson-nav">
        <button class="btn btn-dark" id="lesson-back" ${index === 0 ? 'disabled' : ''}>← Back</button>
        <button class="btn btn-dark" id="lesson-reset" title="Clear task progress">↺ Reset progress</button>
        <button class="btn btn-primary" id="lesson-next" ${index === LESSONS.length - 1 ? 'disabled' : ''}>Next →</button>
      </div>`;

    el.querySelectorAll('[data-i]').forEach((b) => b.addEventListener('click', () => go(Number(b.dataset.i))));
    el.querySelector('#lesson-back').addEventListener('click', () => go(index - 1));
    el.querySelector('#lesson-next').addEventListener('click', () => go(index + 1));
    el.querySelector('#lesson-reset').addEventListener('click', () => {
      if (!confirm('Clear all lesson progress?')) return;
      done.clear();
      save();
      updateBadge();
      render();
    });
    wireFrames();
    highlight(el);
  }

  function wireFrames() {
    el.querySelectorAll('#lesson-frames [data-id]').forEach((r) => r.addEventListener('click', () => onOpenEvent(Number(r.dataset.id))));
  }

  function go(i) {
    index = Math.max(0, Math.min(LESSONS.length - 1, i));
    save();
    render();
    if (LESSONS[index].widget === 'callbacks') loadCallbacks().catch(() => {});
    el.scrollTop = 0;
  }

  subscribe((ev) => {
    if (ev.kind === 'ui:callbacks') {
      const w = el.querySelector('#lesson-widget');
      if (w) w.innerHTML = callbackMapHtml();
      return;
    }
    const changed = ev.kind && !ev.kind.startsWith('ui:') && ev.kind !== 'reset' ? check(ev) : false;
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      if (changed) render();
      else {
        // Only refresh the live-frames box so scrolling/reading isn't disturbed
        const frames = el.querySelector('#lesson-frames');
        if (frames) {
          frames.innerHTML = framesHtml(LESSONS[index]);
          wireFrames();
        }
      }
    });
  });

  updateBadge();
  render();
}
