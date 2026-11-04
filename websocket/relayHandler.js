const staffing = require('../services/staffing');
const campaign = require('../services/campaign');
const lab = require('../services/labBus');
const { chatStream } = require('../services/openai');
const { buildSystemPrompt } = require('../prompts/systemPrompt');
const { toolDefinitions, executeTool } = require('../tools/agentTools');

/**
 * Handle a new ConversationRelay WebSocket connection (one per call).
 *
 * Message types received FROM Twilio:
 *   setup      — session start, contains callSid and custom parameters
 *   prompt     — nurse speech transcript (voicePrompt field)
 *   interrupt  — nurse interrupted the agent mid-response
 *   dtmf       — keypad digit pressed (digit field)
 *   error      — ConversationRelay-side error
 *
 * Every frame in both directions is also mirrored to the Lab UI (services/labBus.js).
 *
 * Messages sent TO Twilio:
 *   { type: "text", token, last }   — stream text to TTS
 *   { type: "end", handoffData }    — end the session; handoffData is posted to /action
 */
function handleRelayConnection(ws) {
  // Per-call session state
  const session = {
    callSid: null,
    nurse: null,
    shift: null,
    messages: [],          // Conversation history (excluding system prompt)
    systemPrompt: null,
    abortController: null, // Cancels in-flight stream on interrupt
    outcome: null,         // Set by the first outcome tool (accepted, declined, ...)
    pendingEnd: null,      // { action: 'hangup' | 'transfer', reason } once the agent decides to end
    endTimer: null,
  };

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      console.error('[Relay] Invalid JSON received');
      return;
    }
    lab.emit('ws', { callSid: session.callSid || msg.callSid, dir: 'in', msg });

    switch (msg.type) {
      case 'setup':
        handleSetup(msg, session, ws);
        break;

      case 'prompt':
        await handlePrompt(msg, session, ws);
        break;

      case 'interrupt':
        handleInterrupt(session);
        break;

      case 'dtmf':
        console.log(`[Relay] DTMF digit received: ${msg.digit} (callSid: ${session.callSid})`);
        break;

      case 'error':
        console.error(`[Relay] ConversationRelay error (call ${session.callSid}): ${msg.description}`);
        break;

      default:
        console.log(`[Relay] Unhandled message type: ${msg.type}`);
    }
  });

  ws.on('close', () => {
    console.log(`[Relay] WebSocket closed for call ${session.callSid}`);
    lab.emit('session', { callSid: session.callSid, event: 'closed' });
    if (session.abortController) session.abortController.abort();
    clearTimeout(session.endTimer);
    // Nurse hung up before any outcome was recorded
    if (session.nurse && session.shift && !session.outcome) {
      campaign.recordOutcome(session.callSid, {
        shiftId: session.shift.id,
        nurseId: session.nurse.id,
        outcome: 'hung-up',
      });
    }
  });

  ws.on('error', (err) => {
    console.error(`[Relay] WebSocket error (call ${session.callSid}):`, err.message);
  });
}

// ─── Event handlers ───────────────────────────────────────────────────────────

function handleSetup(msg, session, ws) {
  const params = msg.customParameters || {};
  session.callSid = msg.callSid;
  ws.callSid = msg.callSid; // so send helpers can tag Lab events
  session.nurse = staffing.getNurse(params.nurseId);
  session.shift = staffing.getShift(params.shiftId);

  console.log(`[Relay] Setup — callSid: ${session.callSid}, nurse: ${params.nurseId}, shift: ${params.shiftId}`);

  if (!session.nurse || !session.shift) {
    console.error('[Relay] Unknown nurse or shift in setup — ending session');
    sendEnd(ws, { action: 'transfer', reason: 'setup-failed' });
    return;
  }

  session.systemPrompt = buildSystemPrompt(session.nurse, session.shift, params.direction);
  // The welcome greeting is spoken by ConversationRelay; add it to history so the model knows it was said
  if (params.greeting) session.messages.push({ role: 'assistant', content: params.greeting });
}

async function handlePrompt(msg, session, ws) {
  // With partialPrompts="true", interim transcripts arrive with last:false. Only act on final ones.
  if (msg.last === false) return;
  const userText = msg.voicePrompt?.trim();
  if (!userText || !session.systemPrompt) return;

  console.log(`[Relay] Nurse (${session.callSid}): "${userText}"`);

  // Cancel any previous in-flight stream
  if (session.abortController) session.abortController.abort();
  session.abortController = new AbortController();
  const { signal } = session.abortController;

  session.messages.push({ role: 'user', content: userText });

  const messages = [{ role: 'system', content: session.systemPrompt }, ...session.messages];
  session.turnStartedAt = Date.now();
  session.firstTokenSent = false;

  try {
    const spoken = await runAgentTurn(messages, session, ws, signal);
    lab.emit('llm', { callSid: session.callSid, phase: 'turn-done', ms: Date.now() - session.turnStartedAt, aborted: signal.aborted });
    if (session.pendingEnd && !signal.aborted) scheduleEnd(session, ws, spoken);
  } catch (err) {
    if (signal.aborted) return;
    console.error(`[Relay] Error in agent turn:`, err.message);
    sendText(ws, "Sorry, I'm having a technical issue. Let me connect you with the staffing coordinator.", true);
    session.pendingEnd = { action: 'transfer', reason: 'agent-error' };
    scheduleEnd(session, ws, 'x'.repeat(80));
  }
}

function handleInterrupt(session) {
  if (session.abortController) {
    console.log(`[Relay] Interrupt received — cancelling stream for ${session.callSid}`);
    session.abortController.abort();
    session.abortController = null;
  }
}

// ─── Agent turn (model with tool call loop) ──────────────────────────────────

/**
 * Run a full agent turn: call the model, handle tool calls in a loop,
 * stream text tokens back to ConversationRelay.
 *
 * @returns {Promise<string>} All text spoken during this turn
 */
async function runAgentTurn(messages, session, ws, signal) {
  const loopMessages = [...messages];
  let spoken = '';

  while (true) {
    if (signal.aborted) return spoken;

    const requestedAt = Date.now();
    lab.emit('llm', { callSid: session.callSid, phase: 'request', messageCount: loopMessages.length });

    const assistantMessage = await chatStream(
      loopMessages,
      toolDefinitions,
      (token) => {
        if (signal.aborted) return;
        if (!session.firstTokenSent) {
          session.firstTokenSent = true;
          // Prompt received → first word on its way to TTS: the latency the caller feels
          lab.emit('llm', { callSid: session.callSid, phase: 'first-token', ms: Date.now() - session.turnStartedAt });
        }
        sendText(ws, token, false);
      },
      signal
    );

    if (signal.aborted || !assistantMessage) return spoken;
    lab.emit('llm', {
      callSid: session.callSid,
      phase: 'response',
      ms: Date.now() - requestedAt,
      toolCalls: (assistantMessage.tool_calls || []).map((t) => t.function.name),
    });

    spoken += assistantMessage.content || '';
    loopMessages.push(assistantMessage);

    // No tool calls — we're done with this turn
    if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
      sendText(ws, '', true);
      if (assistantMessage.content) {
        session.messages.push({ role: 'assistant', content: assistantMessage.content });
        if (session.messages.length > 30) {
          session.messages = session.messages.slice(-30);
          // Don't start history with orphaned tool results
          while (session.messages[0]?.role === 'tool') session.messages.shift();
        }
      }
      return spoken;
    }

    // Keep tool calls in history so the model remembers what was booked
    session.messages.push(assistantMessage);

    for (const toolCall of assistantMessage.tool_calls) {
      if (signal.aborted) return spoken;

      const name = toolCall.function.name;
      let args;
      try {
        args = JSON.parse(toolCall.function.arguments || '{}');
      } catch {
        args = {};
      }

      console.log(`[Relay] Tool call: ${name}`, args);
      const result = await executeTool(name, args, { session });
      lab.emit('tool', { callSid: session.callSid, name, args, result });

      const toolMessage = { role: 'tool', tool_call_id: toolCall.id, content: result };
      loopMessages.push(toolMessage);
      session.messages.push(toolMessage);
    }
    // Loop back to get the model's response after tool results
  }
}

// ─── Ending the session ───────────────────────────────────────────────────────

/**
 * Send "end" after the goodbye has had time to play. ConversationRelay cuts
 * audio off when the session ends, so we estimate speech duration from length.
 */
function scheduleEnd(session, ws, spokenText) {
  clearTimeout(session.endTimer);
  const delayMs = Math.min(10000, 1200 + spokenText.length * 65);
  session.endTimer = setTimeout(() => sendEnd(ws, session.pendingEnd), delayMs);
}

function sendEnd(ws, handoff) {
  if (ws.readyState !== 1) return;
  console.log('[Relay] Ending session:', handoff);
  wsSend(ws, { type: 'end', handoffData: JSON.stringify(handoff) });
}

// ─── WebSocket send helper ────────────────────────────────────────────────────

/**
 * Send a text token to ConversationRelay for TTS playback.
 * @param {WebSocket} ws
 * @param {string} token - Text chunk to speak
 * @param {boolean} last - True when this is the final token of a response
 */
function sendText(ws, token, last) {
  if (ws.readyState !== 1) return; // 1 = OPEN
  wsSend(ws, { type: 'text', token, last });
}

function wsSend(ws, msg) {
  ws.send(JSON.stringify(msg));
  lab.emit('ws', { callSid: ws.callSid, dir: 'out', msg });
}

module.exports = { handleRelayConnection };
