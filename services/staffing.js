const fs = require('fs');
const path = require('path');

/**
 * In-memory staffing store, seeded from seed/*.json.
 * In production this module is the seam to replace with the customer's
 * scheduling system (Kronos/UKG, ShiftWizard, API Healthcare, etc.).
 */

const lab = require('./labBus');

const SEED_DIR = path.join(__dirname, '..', 'seed');
const DATA_DIR = path.join(__dirname, '..', 'data');

function loadJson(filename) {
  return JSON.parse(fs.readFileSync(path.join(SEED_DIR, filename), 'utf8'));
}

const nurses = new Map();
const shifts = new Map();

// (Re)load seed data — also used by the Lab's "reset data" button
function reset() {
  nurses.clear();
  shifts.clear();
  for (const n of loadJson('nurses.json')) nurses.set(n.id, { ...n, optedOut: false });
  for (const s of loadJson('shifts.json')) shifts.set(s.id, { ...s, status: 'open', filledBy: null, standby: [] });
}
reset();

// ─── Lookups ──────────────────────────────────────────────────────────────────

function getNurse(id) {
  return nurses.get(id) || null;
}

function findNurseByPhone(phone) {
  if (!phone) return null;
  return [...nurses.values()].find((n) => n.phone === phone) || null;
}

function getShift(id) {
  return shifts.get(id) || null;
}

function listNurses() {
  return [...nurses.values()];
}

function listShifts() {
  return [...shifts.values()];
}

function shiftHours(shift) {
  const [sh, sm] = shift.start.split(':').map(Number);
  const [eh, em] = shift.end.split(':').map(Number);
  let minutes = eh * 60 + em - (sh * 60 + sm);
  if (minutes <= 0) minutes += 24 * 60; // overnight shift
  return minutes / 60;
}

/**
 * Why a nurse can't take a shift, or null if they can.
 */
function ineligibilityReason(nurse, shift) {
  if (nurse.optedOut) return 'opted out of shift calls';
  if (!nurse.credentials.includes(shift.role)) return `not credentialed as ${shift.role}`;
  if (!nurse.units.includes(shift.unit)) return `not oriented to ${shift.unit}`;
  if (nurse.hoursThisWeek + shiftHours(shift) > nurse.maxHoursPerWeek) return 'would exceed weekly hour limit';
  return null;
}

/**
 * Nurses who can work this shift, fewest hours this week first
 * so extra shifts are spread fairly.
 */
function eligibleNurses(shift) {
  return [...nurses.values()]
    .filter((n) => !ineligibilityReason(n, shift))
    .sort((a, b) => a.hoursThisWeek - b.hoursThisWeek);
}

function openShiftsFor(nurse) {
  return [...shifts.values()].filter((s) => s.status === 'open' && !ineligibilityReason(nurse, s));
}

// ─── Mutations ────────────────────────────────────────────────────────────────

/**
 * Assign a shift to a nurse. Node runs this synchronously, so two nurses
 * saying "yes" at the same moment can't both win.
 *
 * @returns {{ ok: true } | { ok: false, reason: 'not_found'|'filled'|'ineligible', detail?: string }}
 */
function claimShift(shiftId, nurseId) {
  const shift = shifts.get(shiftId);
  const nurse = nurses.get(nurseId);
  if (!shift || !nurse) return { ok: false, reason: 'not_found' };
  if (shift.status !== 'open') return { ok: false, reason: 'filled' };

  const why = ineligibilityReason(nurse, shift);
  if (why) return { ok: false, reason: 'ineligible', detail: why };

  shift.status = 'filled';
  shift.filledBy = nurseId;
  shift.filledAt = new Date().toISOString();
  nurse.hoursThisWeek += shiftHours(shift);
  return { ok: true };
}

function addStandby(shiftId, nurseId) {
  const shift = shifts.get(shiftId);
  if (shift && !shift.standby.includes(nurseId)) shift.standby.push(nurseId);
}

function setOptOut(nurseId) {
  const nurse = nurses.get(nurseId);
  if (nurse) nurse.optedOut = true;
}

// ─── Spoken descriptions ─────────────────────────────────────────────────────

function spokenTime(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  if (h === 0 && m === 0) return 'midnight';
  if (h === 12 && m === 0) return 'noon';
  const hour12 = h % 12 || 12;
  const suffix = h < 12 ? 'AM' : 'PM';
  return m === 0 ? `${hour12} ${suffix}` : `${hour12}:${String(m).padStart(2, '0')} ${suffix}`;
}

function spokenDate(isoDate) {
  return new Date(`${isoDate}T12:00:00`).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
}

/**
 * e.g. "an ICU RN shift on Sunday, November 1, from 7 PM to 7 AM (12 hours)"
 */
function describeShift(shift) {
  const article = /^[AEIOU]/i.test(shift.unit) ? 'an' : 'a';
  return `${article} ${shift.unit} ${shift.role} shift on ${spokenDate(shift.date)}, from ${spokenTime(shift.start)} to ${spokenTime(shift.end)} (${shiftHours(shift)} hours)`;
}

// ─── Outcome log ──────────────────────────────────────────────────────────────

function appendCsv(filename, headers, row) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const filePath = path.join(DATA_DIR, filename);
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, headers.join(',') + '\n');
  const line = row.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',');
  fs.appendFileSync(filePath, line + '\n');
}

function logOutcome({ callSid, shiftId, nurseId, outcome, notes }) {
  const nurse = nurses.get(nurseId);
  const name = nurse ? `${nurse.firstName} ${nurse.lastName}` : '';
  appendCsv(
    'outcomes.csv',
    ['timestamp', 'call_sid', 'shift_id', 'nurse_id', 'nurse_name', 'outcome', 'notes'],
    [new Date().toISOString(), callSid, shiftId, nurseId, name, outcome, notes]
  );
  console.log(`[Staffing] ${shiftId} / ${name || nurseId} → ${outcome}${notes ? ` (${notes})` : ''}`);
  lab.emit('outcome', { callSid, shiftId, nurseId, nurseName: name, outcome, notes });
}

module.exports = {
  getNurse,
  findNurseByPhone,
  getShift,
  listNurses,
  listShifts,
  shiftHours,
  eligibleNurses,
  openShiftsFor,
  claimShift,
  addStandby,
  setOptOut,
  describeShift,
  logOutcome,
  reset,
};
