# Nurse Shift Relay

An outbound voice AI agent built on Twilio **ConversationRelay**. It calls nurses to fill open hospital shifts, confirms who answered, offers the shift, and books the first nurse who says yes.

## How it works

```
POST /campaign/S1001/start
        │
        ▼
 campaign.js ── rings eligible nurses CALL_CONCURRENCY at a time (fewest hours first)
        │
        ▼  calls.create (AMD: DetectMessageEnd)
 /voice/outbound ──┬─ voicemail → generic message, no shift details
                   ├─ shift already filled → short "just filled, thanks" message
                   └─ human → <Connect><ConversationRelay> ──► /ws (relayHandler + GPT-4o)
                                                                │ tools: accept_shift, decline_shift,
                                                                │ add_to_standby, list_other_open_shifts,
                                                                │ request_callback, transfer_to_coordinator, end_call
                                                                ▼ {type:"end", handoffData}
                                                              /action → hang up, or <Dial> the coordinator
 /status ── when a call ends, frees its slot and dials the next nurse
```

- **First yes wins.** `claimShift` runs synchronously, so two nurses can't both get the same shift. When a nurse accepts, calls that are still ringing are cancelled. A nurse already on the line who says yes is offered standby or another open shift.
- **Eligibility:** credential (RN/LPN), unit orientation, weekly hour cap, and opt-out status. The nurse with the fewest hours this week is called first.
- **Identity first:** the agent won't share shift details until the person confirms their name. Voicemails stay generic.
- **Callbacks:** when a nurse calls the Twilio number back, `/voice` matches their caller ID to an open shift they were called about. Unknown callers go straight to the coordinator.
- **Outcomes** are written to `data/outcomes.csv`. Possible values: accepted, declined, standby, voicemail, no-answer, busy, hung-up, transferred, wrong_person, callback-requested, accepted-but-filled.

## Setup

```bash
npm install
cp .env.example .env        # fill in Twilio, OpenAI, coordinator number, hospital name
ngrok http 8080                      # put the https URL in SERVER_URL
npm start
```

In the Twilio Console, set the phone number's **A call comes in** webhook to `POST {SERVER_URL}/voice`. Nurses use it to call back.

Edit `seed/nurses.json` with real test phone numbers, then:

```bash
curl {SERVER_URL}/shifts -H "x-api-key: $ADMIN_API_KEY"
curl -X POST {SERVER_URL}/campaign/S1001/start -H "x-api-key: $ADMIN_API_KEY"
curl {SERVER_URL}/campaign/S1001 -H "x-api-key: $ADMIN_API_KEY"     # live progress
```

## ConversationRelay Lab (interactive learning UI)

Open **http://localhost:8080/lab** while the server runs. Like QualtricsVerifyDemo, the left side shows the behavior and the right side shows what's being called:

- **Left:** a live architecture diagram that pulses as messages flow, call controls, and the live transcript. The transcript marks interruptions (the unheard part is struck through), shows tool calls, and has a "⏱ ms to first word" badge on every nurse turn.
  - **🧪 Simulate in browser:** the page plays Twilio's role. It fetches the real TwiML, opens the real `/ws` socket, and sends `setup`/`prompt`/`interrupt`/`dtmf`. It follows `interruptible`, `welcomeGreetingInterruptible`, `reportInputDuringAgentSpeech`, `dtmfDetection` and `partialPrompts`. There's an optional browser voice, and 🎤 push-to-talk in Chrome (use headphones). Needs only `OPENAI_API_KEY`.
  - **📞 Real phone call:** Twilio rings *your* phone and you play a nurse from the roster. The transcript streams live during the call.
- **Right tabs:**
  - **Lessons:** 10 guided lessons whose tasks check themselves off when the matching frame happens.
  - **Inspector:** every webhook (params in, TwiML out), REST call (as curl), WebSocket frame, tool call and LLM timing, each with a "what this means" explanation.
  - **Parameters:** every `<ConversationRelay>` attribute with what to consider and combination warnings. **Apply** changes the TwiML for the next call.
  - **Campaign:** the shift-filling dialer.

The Lab is served only to this machine (requests through the tunnel get a 404), and its parameter overrides live in memory.

## Production notes

- **Scheduling system:** `services/staffing.js` is an in-memory stand-in seeded from JSON. To connect the customer's scheduler (UKG/Kronos, ShiftWizard, API Healthcare, etc.), replace this file's functions. Campaign state is also in memory, so a restart loses it.
- **Calling consent:** the agent records opt-outs, but the customer is responsible for consent to automated calls (TCPA). Calling employees usually works differently from consumer outreach, so confirm with their counsel.
- **SMS confirmations** (`SEND_SMS_CONFIRMATION=true`) need A2P 10DLC or toll-free verification on the sending number.
- **HIPAA:** the flow never handles patient data. If the customer extends it to anything involving PHI, they need a Twilio BAA and HIPAA-eligible product configuration.
- **Goodbye timing:** ConversationRelay cuts audio when the session ends, so `scheduleEnd` waits an estimated speaking time before sending `end`. For exact timing, subscribe to `events="tokens-played"`.
