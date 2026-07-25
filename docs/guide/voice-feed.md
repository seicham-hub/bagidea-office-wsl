# Voice & Feed Mode

## 🎤 Voice commands

There are two completely separate paths:

**1. The 🎤 button in the app (speak into the text field)**
- Click = mic on — the button **stays red** the whole time it's listening · click again = off
- Your speech is typed into the text field next to the button, so you can review/edit before sending yourself
- Available next to the chat box, on the command form, and on the notes board

**2. The push-to-talk hotkey — default Right Ctrl (direct line to the Director — works in every mode)**
- **Press Right Ctrl = mic on** → a red pulsing pill shows every word it hears live
- **Press Right Ctrl again = mic off + message sent to the Director immediately**
- Doesn't touch any input field — works the same in normal / minimized / 📡 feed mode
- In normal mode you'll see a chip "🎤 Command to Director: …" confirming what was sent
- Rebind the key at ⚙ → AGENTS — **Right Ctrl** (default), Right Alt, Right Shift, or F6–F9

> **Voice engine**: the program records audio itself (with a VU meter in the pill so you can see it's listening),
> then transcribes with **OpenAI Whisper** or **Gemini** using the API key from ⚙ CONNECT —
> very accurate for Thai, no longer relying on the Windows mic panel · **the first time**, the WebView asks
> for microphone permission, click Allow once and you're done (remembered permanently) · limited to 60 seconds per clip

## 🎙 Choosing a microphone / speaker

Pick your audio devices at **⚙ → AGENTS** (below the voice-command HOTKEY selector):

- **🎙 Microphone (input)** — the device used to capture your speech (for the 🎤 button, the hotkey, and live voice chat 📞)
- **🔊 Speaker (output)** — agent voices and sound effects come out of this
- Both default to **"system default"** — your selection is remembered automatically, no save needed

**Testing**: when you pick a new speaker, a confirmation blip plays out of the device you just selected immediately ·
for the mic, press 🎤 and watch the VU meter in the pill to see if it moves with your voice

**If audio isn't coming through / you don't see the device list**:
- The device list only appears once **microphone permission is granted** — opening this panel the first time may prompt for permission, click Allow first
  (if you see "Couldn't read the audio device list — try granting microphone permission first", grant it and reopen the panel)
- Some systems can't select the **speaker** in the app — the field will be disabled with a note; change it in your Windows/macOS sound settings instead

## 🗣 Agent voices (TTS)

Set a voice for each agent on the **agent edit page → 🔊 Voice** — there are **16 voices** to choose from,
clearly split by gender (♀ 8 · ♂ 8), each with its own character.

- **▶ Preview** — speaks a self-introduction that **matches the voice's gender and the office's language** (male voices introduce
  themselves as male, female as female · in the language set in ⚙); no more a single "Hello" for every voice.
- **A bit of spontaneous speech for flavor** — an agent with a voice set will occasionally "say something short" for real
  (a greeting, a task confirmation, a one-sentence summary) via the `SPEAK:` protocol in its own reply.
- **Long reading only on request** — if you want it to read/report aloud in full, just tell it directly.
- Turn agent voices on/off office-wide at ⚙ → AGENTS → the **🗣 Agent voices** switch.
- Live voice chat (📞) with the main agent uses the same voice you set.

> Requires **GEMINI_API_KEY** (⚙ CONNECT) — if it's not set, voice buttons and features are disabled,
> and they enable automatically the moment you add the key.

## 💬 Ambient mood murmurs

When the office is idle, one of the agents will **blurt out a short mood phrase** for flavor, e.g.
"Really feel like working today 💪", "Could use a coffee ☕", "Nice and quiet today 🌿" — it appears as a
speech bubble for any of them, and **if that agent has a voice set**, it will sometimes "say it out loud" for real.

- **How often**: at most **~every 55 seconds**, and each beat only has about a **45%** chance
  (so in practice they're spaced much further apart) · it **goes completely silent when a task is running or agents are talking to each other**
- **When it's spoken aloud**: only for an agent that has a voice + TTS enabled, and it still has to pass a random roll
  (~60% of murmurs) before you hear it for real — otherwise it's just a silent bubble
- **On/off (text + voice murmurs)**: **⚙ → AGENTS → 💬 Ambient murmurs** — turns off solo mood lines entirely (bubbles and TTS). Independent of ☕ SOCIAL
- **Voice only**: **⚙ → AGENTS → 🗣 Agent voices** — keeps the text bubbles, stops the spoken part
- To quiet group hangouts / brainstorms, reduce **⚙ → AGENTS → ☕ SOCIAL** (set 0 = off)

## 📡 Feed Mode — the event stream bar

**Right-click the chat head** → the chat window turns into a translucent bar in the bottom-right corner
streaming every movement in the office: who said what, which tool was used, tasks done/failed,
ghosts splitting off, delegations, messages from channels, and so on.

| Capability | How to use |
|---|---|
| Read back | just scroll up — new messages won't drag you down while you're reading |
| Read clearly | hover the mouse → the background turns opaque automatically |
| Clear the list | the 🧹 button at the top of the bar (keeps up to 60 items) |
| Permission requests | pop up as cards with ✓ Allow / ✓✓ Always / ✗ No buttons — answer right in the bar |
| Voice command | hold Right Ctrl and speak — sent to the Director automatically |

Switch back: right-click the chat head again — any windows/tabs you'd left open come back as they were,
and if all permission requests were answered from the feed, the Security Center folds itself away.

## 🔵 NOW WORKING — see every running task

The moment you give a command, a summary bar appears (under the header in normal mode / under the OFFICE FEED head in feed mode):

```
● 3 tasks running   Flamingo: building a calculator website…          ▼ Show all
```

- Always a single line, never blocking the screen, even with ten tasks running — press **▼ Show all** to expand the full list
  (scrollable, with page + name + task title for each)
- Click a task in the list → opens that agent's chat
- Tasks disappear on their own when done · restart the program and the list comes back by itself
- Scheduled tasks (jobs) are still viewed at 🗂 → TASKS as before
