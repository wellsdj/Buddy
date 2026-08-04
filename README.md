# AI Deskmate

A little face that lives on your desk. It listens, it talks back, it can see through your
webcam, and it runs for pennies a month.

One HTML file. No build step, no dependencies, no server.

<!-- drop a screenshot in here once you've got it running -->

## Try it

```
git clone https://github.com/wellsdj/ai-deskmate.git
cd ai-deskmate
open index.html        # macOS  (Linux: xdg-open, Windows: start)
```

Use **Chrome or Edge** — Firefox has no speech recognition and Safari's is patchy.
Click the face to wake it, then **hold space and talk**. Let go and it answers.

It opens in demo mode with canned replies, so it works before you've spent anything.

## What it costs to run

This is the whole point, so here it is plainly:

| Part | Who does it | Cost |
|---|---|---|
| Hearing you | Your browser (Web Speech API) | **free** |
| Talking back | Your browser (speechSynthesis) | **free** |
| Seeing | Your webcam | **free** |
| The face | Canvas, ~200 lines | **free** |
| Thinking | An LLM API | **~$0.0004 a turn** |

Speech is the expensive layer in every voice assistant, and your browser gives it away.
That's why a build like this costs **under $2/month** instead of the $22–43 a hosted
always-on assistant runs to. Fifty conversations a day on Haiku is about **60¢ a month**.
See [BUSINESS-CASE.md](BUSINESS-CASE.md) for where those numbers come from.

Three deliberate choices keep it there. Keep all three:

- **Hold-to-talk, not always-listening.** Always-on is where the money goes, and it means an
  open microphone in your room all day. Push-to-talk fixes the bill and the creepiness at once.
- **The camera only grabs a frame when you say something that needs eyes** — "look at this",
  "what am I holding". Never streamed. Image tokens are the most expensive thing here.
- **A live spend counter, top right.** Nobody who can see the number gets a surprise bill.

Cheaper still: point it at **Ollama or LM Studio** on your own machine (Brain →
OpenAI-compatible → `http://localhost:11434/v1/chat/completions`, no key). Free forever,
works offline. An 8B model is worse company than Haiku, but it's *yours*.

## Giving it a brain

Click **Brain**. Three options:

| Mode | What you need |
|---|---|
| **Demo** | Nothing. Canned replies, free. |
| **Anthropic** | An [API key](https://console.anthropic.com). Defaults to Haiku, the cheap one. |
| **OpenAI-compatible** | Works with OpenAI, Groq, Together, or a local Ollama / LM Studio (leave the key blank). |

Your key is stored in that browser's localStorage and goes nowhere except the endpoint you
name. There's no backend here to leak it.

## The money ladder

Don't buy anything until the step below has been running for a fortnight.

**Step 0 — £0. Browser tab.** Full-screen it on a second monitor, or just leave the tab open.

> This step *is* the experiment. The question was never whether you can build it — that's an
> evening. It's whether you still talk to it in week six. Rabbit sold 100,000 R1s and had
> 5,000 users left after five months. Find out which way you go for £0.

**Step 1 — £0. Your old phone.** Run `python3 -m http.server 8000` in this folder and open
`http://<your-laptop-ip>:8000` on the phone. Prop it against your monitor. Now it's a real
object on your desk with its own screen and camera, for nothing — about 90% of the feeling
of the £220 build. (Host it over HTTPS and you can add it to the home screen; mic and camera
need a secure origin, though `localhost` is exempt.)

**Step 2 — ~£20. A round display.** A Waveshare ESP32-S3 round LCD is about £18. It's a dumb
face — your laptop still thinks and talks, the board just shows the eyes. This is where it
stops being a screen and starts being an object.

**Step 3 — ~£45. A second-hand Pi.** Used Pi 4 plus a 3.5" screen off eBay. Only worth it
once you know you want it standalone.

Skip to Step 3 and you'll spend £45 learning what Step 0 tells you for free.

## Giving it hands

Files and email are where this gets genuinely useful and genuinely dangerous. The approval
gate is already built: `requestApproval(what, body)` shows a card and resolves true or false.
It exists before any tool does, on purpose.

When you wire up real tools, hold these:

- **Reading is free, writing asks.** Anything that creates, edits, deletes or sends goes
  through `requestApproval` and shows you the exact content first.
- **One folder.** Point it at `~/deskmate-files`, not your home directory. A misheard path
  should cost you a scratch file, not your coursework.
- **Email is draft-only.** It writes, you press send. Deleting stays yours. Voice
  misrecognition is common enough that "delete that email" *will* eventually fire on the
  wrong thread, and there's no undo worth relying on.

The browser can't touch your filesystem, so this needs a small Node process on localhost
exposing read/write tools, with every write routed back through the approval card. Build it
when you want it, not before.

## The face

Three strokes on a dark circle — two eyes and a mouth. No eyeballs, no pupils. Everything
it feels comes out of how those three lines bend.

The character is one object near the top of the script:

```js
const MOODS = {
  idle:      { eyeW: 0.105, eyeBow: 0.030, lift:  0.000, bow:  0.075, open: 0.03, hue: 200, glow: 0.72 },
  thinking:  { eyeW: 0.088, eyeBow: 0.010, lift: -0.034, bow: -0.030, open: 0.02, hue: 265, glow: 0.66 },
};
```

| | |
|---|---|
| `eyeW` | how long each eye stroke is |
| `eyeBow` | how much it curves; negative arcs upward |
| `lift` | raises the *outer* end of each eye — this is the eyebrow, and it does most of the emotional work |
| `bow` | mouth curvature; negative frowns |
| `open` | how far apart the mouth sits at rest |
| `hue` / `glow` | colour and how lit the strokes are |

The draw loop eases toward whichever mood is set, so you never write transitions — change a
number and the personality changes. Blinking isn't a lid: the eye stroke flattens and pulls
in, which on a line reads as an eye shutting.

Add a `sulking`. Give it a `curious`. That's the fun part, and it's free.

### How the mouth knows what it's saying

The browser won't hand over the audio it synthesises, so there's no waveform to measure.
What it *does* give is an event at the start of each spoken word. So the mouth works from
the text: each letter maps to a shape — how far open, how wide — and they're played out at
roughly the rate the voice is talking.

```js
const VISEME = {
  a: [0.95, 1.06],   // jaw down, wide
  o: [0.88, 0.68],   // open but rounded
  m: [0.00, 0.86],   // lips shut
  f: [0.16, 0.92],   // lip to teeth
};
```

Saying "hello" runs *h → e → l → l → o*, so you get the round `o` at the end instead of a
jaw flapping at random. It isn't phonetically correct — English spelling doesn't deserve
that kind of faith — but it's the difference between a mouth moving and a mouth speaking.
Tune the numbers, or add digraphs like `th` and `sh` if you want it sharper.

### Just the circle

Everything that isn't the face fades out after about three seconds of no input, so what's
left on your desk is a circle. Move the mouse, press a key, or talk to it and the controls
come back.

## Files

| | |
|---|---|
| `index.html` | Everything. Face, ears, mouth, eyes, brain, approval gate. |
| `BUSINESS-CASE.md` | What the company version would cost and earn, and why this is the better first move. |

## Licence

MIT.
