# Learning ConversationRelay, using this project

> **Prefer hands-on?** Run `npm start` and open **http://localhost:8080/lab**. It's the interactive version of this guide: the same lessons, with tasks that check themselves off as you make live calls, an inspector for every frame, and a playground for every parameter.

This guide teaches ConversationRelay (CR) the way this project was built: one layer at a time, from the mental model to the details that make a voice agent feel good. Each section links to the code that puts it into practice.

---

## 1. The mental model

ConversationRelay is Twilio handling **the phone and the audio** while you handle **the thinking**.

```
 Nurse's phone ── PSTN ──► Twilio ──────────────── WebSocket (JSON text only) ───► Your server ──► LLM
                           │ speech-to-text (Deepgram/Google)                       │ decides what to say
                           │ text-to-speech (ElevenLabs/Google/Amazon)               │ calls tools
                           │ interruption detection, DTMF                           │
                           ◄──────────────── {"type":"text","token":"..."} ─────────┘
```

What that means for you:

- **You never touch audio.** Twilio sends you transcribed text (`prompt`). You send text back (`text`) and Twilio speaks it.
- **CR doesn't pick your LLM.** GPT, Claude, Gemini, or plain `if` statements all work. CR only moves text in both directions.
- **One call means one WebSocket.** Everything about that call (history, who the caller is, what's been decided) lives in a per-connection `session` object.
- **TwiML starts the session and receives the end.** A `<Connect><ConversationRelay>` verb opens the WebSocket. When the session ends, Twilio posts to the `<Connect action>` URL, and the call carries on with whatever TwiML you return there.

Every CR app, including this one, comes down to three endpoints:

| Endpoint | Who calls it | Job |
|---|---|---|
| Voice webhook (`/voice`, `/voice/outbound`) | Twilio (HTTP) | Return TwiML that opens CR |
| WebSocket (`/ws`) | Twilio (WS) | The conversation itself |
| Action URL (`/action`) | Twilio (HTTP) | Decide what happens after CR ends (hang up, transfer, etc.) |

---

## 2. Build order (how I actually built it)

I didn't write the files top to bottom. I built in an order where each step can be tested before the next one:

1. **TwiML that opens CR.** Confirm a call connects and you hear the welcome greeting.
2. **An echo WebSocket.** Reply to every `prompt` by repeating it back. This proves the protocol works before you add an LLM.
3. **The LLM, streaming.** Replace the echo with streamed model tokens.
4. **Interrupts.** Stop talking when the caller talks over the agent.
5. **Tools.** Let the model act (book the shift), not just talk.
6. **Ending and handoff.** `end` + `handoffData` → action URL → transfer or hang up.
7. **The business layer.** Outbound dialing, voicemail detection, and the campaign queue. None of this is CR itself; it's ordinary Twilio Voice around it.

The sections below follow the same order.

---

## 3. Step 1: TwiML that opens ConversationRelay

See [routes/voice.js:20](routes/voice.js#L20). The generated XML looks like this:

```xml
<Response>
  <Connect action="https://you/action">
    <ConversationRelay url="wss://you/ws"
        welcomeGreeting="Hi, this is Ava ... Am I speaking with Marcus?"
        ttsProvider="ElevenLabs" elevenlabsTextNormalization="on"
        language="en-US" interruptible="any" dtmfDetection="true"
        hints="ICU,Med-Surg,Step-Down,RN,LPN,standby">
      <Parameter name="nurseId" value="N002"/>
      <Parameter name="shiftId" value="S1001"/>
    </ConversationRelay>
  </Connect>
</Response>
```

The attributes that matter most:

| Attribute | What it does | Why it's set this way here |
|---|---|---|
| `url` | Your WebSocket. **Must be `wss://`.** | The tunnel gives you https, and the code swaps it to wss |
| `welcomeGreeting` | Twilio speaks this as soon as the call connects, **before your LLM is involved** | Zero latency on the first sentence. The model would need 1–2 seconds to produce it |
| `ttsProvider` / `voice` | Which TTS engine and voice speaks | ElevenLabs (the default) sounds most natural. Use `voice` to choose a specific one |
| `elevenlabsTextNormalization` | Has ElevenLabs read "7 PM" and "$15" naturally | Shift times and pay are full of numbers |
| `transcriptionProvider` / `speechModel` | Speech-to-text engine | Deepgram by default (for newer accounts) |
| `hints` | Words that speech-to-text should expect | "Med-Surg" and "Step-Down" are easy to mis-transcribe |
| `interruptible` | Whether caller speech/DTMF stops the agent mid-sentence | `any`: a nurse saying "yes, yes, I'll take it" shouldn't have to sit through the whole pitch |
| `dtmfDetection` | Send keypresses to you as `dtmf` messages | Logged here. You could add "press 1 to accept" |
| `<Parameter>` | Custom key/values that show up in the `setup` message | **This is how your WebSocket knows who's on the call.** |

**`<Parameter>` is the bridge between the HTTP and WebSocket worlds.** The voice webhook knows which nurse and shift a call is about (from the query string). The WebSocket only knows what `setup` tells it. Anything the agent needs on the first turn goes in a `<Parameter>`.

**Common mistake:** an invalid provider/voice/model combination means the WebSocket *never connects*. The caller hears nothing, and error `64101` shows up at your action URL. If a call goes silent, check the action URL logs first.

Other attributes worth knowing (not used here):

- `partialPrompts="true"`: streams transcripts while the caller is still speaking. Useful for advanced latency tricks.
- `speechTimeout`, `eotThreshold`: tune how long the caller can pause before Twilio decides they've finished speaking.
- `interruptSensitivity`, `ignoreBackchannel`: stop "mm-hm" from counting as an interruption.
- `reportInputDuringAgentSpeech`: receive what the caller says even while the agent is talking.
- `applicationReconnect="true"`: survives a WebSocket drop. Without it, a dropped socket ends the call.
- `<Language>` child elements and `language="multi"`: multilingual agents.
- `intelligenceService`: send the transcript to Conversation Intelligence for post-call analytics.
- `events="tokens-played"`: Twilio tells you when speech has actually been played. More in section 8.

---

## 4. Step 2: The WebSocket protocol

All messages are JSON text frames. The handler is a single `switch` at [websocket/relayHandler.js:45](websocket/relayHandler.js#L45).

**Twilio → you**

| `type` | When | Key fields |
|---|---|---|
| `setup` | Once, first | `callSid`, `from`, `to`, `direction`, **`customParameters`** |
| `prompt` | Caller finished a sentence | `voicePrompt` (transcribed text), `lang`, `last` |
| `interrupt` | Caller talked over the agent | `utteranceUntilInterrupt` (what they *heard*), `durationUntilInterruptMs` |
| `dtmf` | Keypress | `digit` |
| `error` | Something went wrong on Twilio's side | `description` |

**You → Twilio**

| `type` | Does | Example |
|---|---|---|
| `text` | Speak this | `{"type":"text","token":"Hi ","last":false}` |
| `play` | Play an audio URL | Hold music, a recorded disclaimer |
| `sendDigits` | Send DTMF tones | Navigating another company's IVR |
| `language` | Switch TTS/STT language mid-call | Spanish-speaking caller |
| `end` | End the session. `handoffData` goes to the action URL | `{"type":"end","handoffData":"{\"action\":\"transfer\"}"}` |

**See it yourself.** Run the server, then the fake client, which prints every raw frame:

```bash
npm start
npm run fake-relay -- N002 S1001     # nurseId shiftId from seed/
```

[scripts/fake-relay.js](scripts/fake-relay.js) does exactly what Twilio does: it sends `setup` with `customParameters`, sends a `prompt` each time you type a line, and prints the `text` tokens as they stream back. Type `/interrupt` to simulate the nurse talking over the agent. This is the fastest way to iterate on prompts and tools without phoning yourself 40 times.

---

## 5. Step 3: Streaming the LLM (latency is everything)

On a phone call, **silence over about 1 second feels broken.** The biggest latency win is streaming. Send each token to Twilio as the model produces it, and Twilio starts speaking after the first few words instead of waiting for the whole reply.

See `runAgentTurn` at [websocket/relayHandler.js:153](websocket/relayHandler.js#L153):

```js
chatStream(messages, tools, (token) => sendText(ws, token, false), signal)  // stream each token
...
sendText(ws, '', true)   // then mark the end of this reply
```

The `last` flag:
- `last: false` means "more is coming". Twilio buffers into natural phrases and starts speaking.
- `last: true` means "this reply is done". Send it once at the end of every reply, even with an empty token. Without it, Twilio doesn't know the agent has finished its turn.
- **Don't trim tokens.** `"Hi"` + `" there"` keeps its spaces. Trimming produces "Hithere".

Other latency levers, from biggest to smallest:
1. `welcomeGreeting` handles the first line with no LLM involved.
2. A fast model. Time-to-first-token matters more than total quality for voice.
3. Short replies. The prompt enforces "one or two short sentences" ([prompts/systemPrompt.js](prompts/systemPrompt.js)).
4. Keep the system prompt focused. Every turn re-sends it.
5. Host your server close to Twilio's media region (US: `us1`).

---

## 6. Step 4: Interruptions

Real people talk over agents. When that happens:
1. Twilio stops the agent's audio by itself (because `interruptible="any"`).
2. Twilio sends you `interrupt`.
3. **You must stop generating.** Otherwise the old reply keeps streaming and gets spoken after the nurse finishes.

The pattern here is one `AbortController` per turn ([websocket/relayHandler.js:137](websocket/relayHandler.js#L137)):

```js
case 'interrupt': session.abortController.abort();   // kills the OpenAI stream
```

A new `prompt` also aborts any reply still in flight ([websocket/relayHandler.js:117](websocket/relayHandler.js#L117)), which covers the nurse speaking again before the agent finished.

**Exercise:** `interrupt.utteranceUntilInterrupt` tells you how much of the reply the nurse *actually heard*. Right now an interrupted reply is simply left out of history. Improve it: save the partial text as the assistant's message, so the model knows "I'd already said the date, but not the time."

---

## 7. Step 5: Tools, where the agent actually does things

The model decides; your code acts. See [tools/agentTools.js](tools/agentTools.js).

The loop ([websocket/relayHandler.js:153](websocket/relayHandler.js#L153)):
```
model → wants tool? ─no──► stream text, last:true, done
             │yes
             ▼
        run tool, push result into messages ──► back to model (it now speaks about the result)
```

Design lessons from this project:

- **Tool results are instructions to the model, not just data.** `accept_shift` doesn't only return `{ok:true}`. It returns *"Booked… Thank them sincerely, then call end_call."* That steers what the model says next.
- **Put guardrails in code, not only in the prompt.** The prompt says "don't book without confirmation", but the *real* protection against two nurses getting one shift is `claimShift` ([services/staffing.js:84](services/staffing.js#L84)). Prompts are suggestions; code is a guarantee.
- **Handle the "too late" case as a normal conversation.** If someone else filled the shift, the tool result tells the model to apologize and offer standby. The failure becomes a scripted moment instead of an error.
- **Keep tool calls in history** ([websocket/relayHandler.js:207](websocket/relayHandler.js#L207)). If you don't, the model forgets it already booked the shift and may try again.
- **Tool descriptions are prompt engineering.** "Only call after they clearly said yes AND confirmed the day and times" is what stops a hasty booking.

---

## 8. Step 6: Ending the session and handing off

Calls end one of three ways, and the action URL handles all of them ([routes/action.js](routes/action.js)). Twilio posts `SessionStatus`:

| `SessionStatus` | Meaning | What we do |
|---|---|---|
| `ended` | **You** sent `end` | Read `HandoffData`: `transfer` → `<Dial>` the coordinator, otherwise hang up |
| `completed` | Caller hung up | Nothing (the call is already over) |
| `failed` | Error (bad voice config, WS crashed…) | Apologize and transfer to a human. **Never leave a caller in dead air.** |

`handoffData` is a **string**. To pass structured data, JSON-encode it yourself, as `sendEnd` does ([websocket/relayHandler.js:225](websocket/relayHandler.js#L225)).

**The goodbye problem:** sending `end` cuts off speech that's still playing. This project waits an estimated duration based on text length ([websocket/relayHandler.js:219](websocket/relayHandler.js#L219)). The precise fix:

**Exercise:** add `events="tokens-played"` to the TwiML. Twilio will then send a message when your tokens have actually been spoken. Send `end` when that arrives instead of using the timer.

---

## 9. Step 7: The business layer (plain Twilio Voice)

This part isn't CR, but every outbound CR project needs it.

- **Outbound calls:** `calls.create({ url })` ([services/twilio.js:16](services/twilio.js#L16)). When the call is answered, Twilio fetches `url`, and that's where the CR TwiML comes from. Inbound and outbound share the same CR code; only the trigger differs.
- **Answering machine detection:** `machineDetection: 'DetectMessageEnd'` waits for the voicemail beep, then sends `AnsweredBy=machine_end_beep`. We `<Say>` a voicemail instead of starting CR. **Don't run an LLM against a voicemail greeting.** It will cheerfully try to talk to it.
- **Status callbacks** ([routes/status.js](routes/status.js)) are how you learn about `no-answer` and `busy`, so the queue can move on.
- **The campaign queue** ([services/campaign.js:49](services/campaign.js#L49)): ring N at once, dial the next when one ends, and cancel the rest when someone accepts. The `dialing++` before `await` is a classic async lesson. Without it, two status callbacks arriving together could both see a free slot and over-dial.

---

## 10. Prompting for voice (different from chat)

See [prompts/systemPrompt.js](prompts/systemPrompt.js). Voice-specific rules:

- **No markdown, lists, or emojis.** TTS reads "asterisk" aloud, or worse.
- **One or two sentences per turn.** Listeners can't skim. Long monologues get interrupted.
- **Spell out tricky things** (times, dates, money), or turn on TTS normalization.
- **Plan for mis-transcription.** "Never guess a yes or no; ask them to repeat." Phone audio and STT are imperfect.
- **Give it an explicit call flow** (identity → offer → confirm → book → goodbye). Voice agents drift without a script.
- **Pre-format data for speech.** `describeShift()` ([services/staffing.js:132](services/staffing.js#L132)) turns `"19:00"` into `"7 PM"` before the model sees it, so it never reads out "nineteen hundred".
- **Tell the model what's already been said.** The welcome greeting is spoken by Twilio, not the model, so it's added to history in `handleSetup` ([websocket/relayHandler.js:91](websocket/relayHandler.js#L91)). Otherwise the model greets the nurse twice.

---

## 11. Debugging checklist

| Symptom | Likely cause |
|---|---|
| Call connects, total silence | Bad `ttsProvider`/`voice` combo (error 64101 at the action URL), or the `url` isn't `wss://` / the tunnel is down |
| Greeting plays, then nothing | WebSocket handler crashed. Check server logs and that `/ws` upgrades are routed |
| Agent talks after being interrupted | You aren't aborting the stream on `interrupt` |
| Agent never "finishes"; caller hears nothing after a while | Missing `last: true` |
| Words run together ("Hithere") | You're trimming tokens |
| Goodbye gets cut off | `end` sent too early (section 8) |
| Webhooks return 403 | Signature validation: `SERVER_URL` must exactly match the tunnel URL Twilio calls |
| Agent repeats its greeting | Welcome greeting not added to history |

Also useful: the Twilio Console call logs (Monitor → Calls → the call → **Request Inspector**) show every webhook and the TwiML you returned.

---

## 12. Exercises, easiest to hardest

1. Change the voice: set `TTS_VOICE` to a different ElevenLabs voice and compare.
2. Add DTMF: "press 1 to accept" as a backup to speech. Handle `case 'dtmf'`.
3. Use `utteranceUntilInterrupt` for accurate history (section 6).
4. Replace the goodbye timer with `events="tokens-played"` (section 8).
5. Add Spanish: a `<Language code="es-US">` child plus a `language` message when the nurse speaks Spanish.
6. Turn on `applicationReconnect` and handle `connectionType: "reconnect"` in `setup` without losing the session.
7. Add `intelligenceService` and review transcripts and operators after a few test calls.
8. Swap the LLM provider. Only [services/openai.js](services/openai.js) should need to change, which proves the CR layer doesn't depend on the model.
