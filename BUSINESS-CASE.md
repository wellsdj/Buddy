# Deskmate — cost, revenue, and whether it's any good

A little screen on your desk with a face. It listens, talks, watches through a camera,
and drives an agent that can read and change files on your laptop, and read, write, and
delete your email.

This document answers three questions: what it costs to build, what it would make as a
business, and whether it's a good idea. Short version up front, working underneath.

---

## Verdict in three lines

- **As a personal project: excellent.** ~$220 of parts, a few weekends, genuinely delightful.
- **As a business, as described: weak.** It's three hard businesses stapled together, and the
  most valuable one is already given away free with a $20/mo chatbot subscription.
- **There is a good business hiding inside it** — but it's the software half without the
  hardware, or the hardware half without the agent. Not both. See "The two businesses that
  actually work."

---

## 1. What it costs to build

### 1a. One unit, for yourself

| Part | Choice | Cost |
|---|---|---|
| Compute | Raspberry Pi 5, 8 GB | $80 |
| Screen | 5" DSI touch LCD (or 2.1" round for the "eye" look) | $45 |
| Camera | Camera Module 3 | $25 |
| Mic | ReSpeaker 2-mic HAT (4-mic array is $35) | $15 |
| Audio out | 3 W speaker + I2S amp | $12 |
| Power | 27 W USB-C PSU | $12 |
| Storage | 64 GB A2 microSD | $10 |
| Enclosure | 3D printed, ~200 g filament | $8 |
| Wiring, standoffs, misc | | $10 |
| **Total** | | **≈ $217** |

Add ~$60 if you want it battery-powered and portable. Call it **$220–280 and 3–4 weekends.**

The laptop-only version — same face, same agent, rendered in an app window using the mic,
camera and speakers you already own — costs **$0 in hardware.** Hold that thought; it matters
a lot in section 3.

### 1b. Running cost (the number people forget)

This is the one that decides whether it's a business.

Assume 30 minutes of real conversation a day, plus background agent work on files and email.

**Naive build** — pipe audio straight into a speech-to-speech model:

- Realtime speech-to-speech runs ~$0.04/min in practice with voice-activity detection and
  prompt caching ([measured over 4,000 sessions](https://hackernoon.com/openai-realtime-api-pricing-in-2026-real-world-data-from-4000-measured-sessions)).
- 30 min/day × $0.04 = **$1.20/day → ~$36/month per user.**

**Tuned build** — local wake word (openWakeWord, free), streaming STT, text LLM, TTS:

| Layer | Rate | Daily | Monthly |
|---|---|---|---|
| Wake word | local, free | $0 | $0 |
| STT (streaming) | ~$0.003–0.006/min | $0.09 | $2.70 |
| LLM (agent turns, cached prompts) | Sonnet $3/$15 per Mtok | $0.30–1.00 | $9–30 |
| TTS | ~$0.015/1k chars, ~20k chars/day | $0.30 | $9 |
| Vision (on-demand frames only) | | $0.05 | $1.50 |
| **Total** | | **$0.74–1.44** | **$22–43** |

So: **$22–43/month per active user at moderate use.** Always-on vision or a chatty user
pushes it to $80–150. Local models on the Pi cut this but a Pi 5 can't run anything good
enough to be the brain — you'd be shipping a worse assistant to save money on the thing
people are paying for.

**The structural problem is visible already:** a $249 device with ~$110 of gross profit is
underwater on API costs by month three.

### 1c. Cost to build it as a company

Benchmarks for a consumer electronics device from zero to first shipment:

| Line | Cost |
|---|---|
| Industrial design + mechanical engineering | $80–150k |
| Electrical / PCB design | $60–120k |
| Certification (FCC, CE/UKCA, UN38.3 if battery) | $30–60k |
| Injection mould tooling | $30–80k |
| Firmware, app, cloud — 2–3 engineers × 12 months, loaded | $500–700k |
| First production run (5,000 × ~$60 landed) | $300k |
| Packaging, logistics, support setup | $100k |
| **To first unit shipped** | **$1.1–1.5M, 12–18 months** |

Budget **$2M** honestly. Hardware timelines slip and the first run always has a defect.

---

## 2. What it would make as a business

### 2a. Unit economics

At 5,000-unit volume a Pi-CM-class design lands at **$55–70 BOM+assembly**. A cheaper
ESP32-S3 or Allwinner design gets to $25–35, but then it can't do local wake word well and
every interaction is a round trip.

Consumer electronics prices at [2.5–4× BOM](https://blog.dragoninnovation.com/blog/2016/05/26/understanding-gross-margin-hardware),
so **$199–299 retail**. After landed cost, tariffs, payment fees and a realistic return rate,
gross margin is ~45% — **$90–130 contribution per unit.** Electronics
[rarely clears 45% gross margin](https://eightx.co/blog/electronics-financial-benchmark) without
a software attach, and you need >50% to be healthy.

That contribution covers **three months** of the $30/mo API bill. So the device *must* carry a
subscription, and every comparable companion product on the market ships **without one**:
Casio's Moflin is $380 outright, Ropet is $299 outright. You'd be asking for a price premium
*and* a subscription that competitors don't charge.

### 2b. Revenue scenarios

| Scenario | Units/yr | Hardware rev | Sub attach | Sub ARR | Total rev | Gross profit | Verdict |
|---|---|---|---|---|---|---|---|
| Indie / Etsy | 500 @ $299 | $150k | 30% @ $19 | $34k | $184k | ~$70k | A nice side income, not a company |
| Kickstarter-grade (Ropet did [1,134 backers / ~$400k](https://www.kickstarter.com)) | 1,500 | $400k one-off | 25% | $85k | $485k | ~$180k | Doesn't repay the $2M |
| Good execution | 20,000 @ $249 | $5.0M | 40% @ $19 | $1.8M | $6.8M | ~$2.5M | Roughly breakeven vs $3–4M opex |
| Hit (Moflin-tier, [7,000 units at $380](https://asianews.network/chinas-cute-robot-pets-emerge-as-cuddly-companions/) in its first months) | 60,000 | $15M | 40% | $5.5M | $20M | ~$8M | A real, profitable, mid-sized company |

**Expected value is not the "good execution" row.** The base rates are brutal:

- **Humane AI Pin**: raised $230M, shipped [fewer than 10,000 units](https://www.digitalapplied.com/blog/ai-product-failures-2026-sora-humane-rabbit-lessons), returns exceeded sales within months, sold to HP for $116M, servers dead Feb 2025 and every device bricked.
- **Rabbit R1**: sold 100,000 units at $199 — and had **5,000 active users five months later.** A 95% abandonment rate. The company [couldn't make payroll](https://techstory.in/rabbit-r1-maker-plagued-by-unpaid-employees-as-company-vows-new-ai-hardware/).

Both failed the same way: enormous novelty-driven launch demand that the teams read as
product-market fit, for a device that duplicated what the phone already did.

### 2c. The market is small

AI electronic pets: **$224M in 2024 → $438M by 2034, 10.4% CAGR.** A $438M global market a
decade out means the category leader does maybe $80–120M. That's a good business. It is not
a venture-scale one, and it's already contested by Sony (AIBO), Casio (Moflin), Yukai,
Ageless Innovation, Tombot, Ropet and KEYi.

---

## 3. How good is the idea

### The concept is two products fused, and the fusion is the problem

**Product A — a cute companion.** Emotional, ambient, no job to do. Proven modest demand
(Moflin: 7,000 units at $380; Ropet: $400k on Kickstarter). People buy these because they're
charming, not useful.

**Product B — an agent with write access to your files and email.** Genuinely valuable. Also
already free: ChatGPT's desktop app has native computer use on a **$20/mo** Plus plan, Claude
Cowork ships with **Claude Pro at $20/mo**, Microsoft Scout is bundled into M365, and
Perplexity Computer does full autonomous file and app control. Plus open-source options like
OpenClaw at $0.

Now the fatal detail: **the deskmate cannot do the file work.** Your laptop does. The Pi is a
face on a stick that forwards a request to software running on the machine it's sitting next
to — a machine with a better mic, a better camera, more compute, and no extra network hop.
The screen adds latency and a second thing to keep charged, in exchange for a face.

That is the Rabbit R1 failure pattern stated precisely: **a device that duplicates what the
computer beside it already does, with novelty as the only differentiator.** Novelty has a
half-life of about six weeks, which is exactly the shape of Rabbit's 95% churn.

### And the permission model is the hardest trust ask in consumer tech

Always-listening + always-watching + can-delete-my-email is three separate red lines at once.

- A camera on a desk is banned outright in a lot of offices.
- Face recognition puts you under GDPR Article 9 and Illinois BIPA — biometric consent regimes with real teeth.
- Voice and vision both misrecognise. When a misrecognition deletes the wrong email or overwrites the wrong file, that's your liability, and "the AI misheard" is not a defence customers accept.
- Humane's shutdown is the cautionary tale for the trust side too: when the company died, every device became a paperweight. Anyone who has watched that happen is slower to hand the next one their inbox.

An honest v1 gives it **read access plus drafted actions you approve with a tap.** That's not
a compromise, it's the only version that survives contact with a real user's inbox. It is
also, notably, a much less exciting demo.

### What's genuinely good about it

Not nothing — the instinct is right in two places:

1. **Presence is a real product quality.** A thing that's *there*, glanceable, that you talk to
   without opening an app, is meaningfully different from a chat window. Nobody has nailed
   ambient AI presence yet.
2. **The agent stack is now free.** The reason this is buildable in a weekend and wasn't in
   2023 is that the hard part — an agent that can actually operate a computer competently — is
   a library call now. That's a real change and worth exploiting.

The mistake is spending $2M and 18 months on injection moulds to deliver those two things,
when a window on the screen delivers both for $0.

---

## 4. The two businesses that actually work

**Option A — drop the hardware. Ship the face as a desktop app.**

A persistent character living on your screen: idle, listening, thinking, talking states.
Wake word, voice in and out, sees the screen on request, drives the agent, gates every write
and delete behind a one-tap approval.

- BOM: $0. Tooling: $0. Certification: $0. Ship in 6–8 weeks, solo.
- Price $29/mo, or **$9/mo bring-your-own-API-key** — which moves the $30 API cost off your
  P&L entirely and turns a 0% margin into a 90% one.
- 500 subscribers = $175k ARR for one person. 5,000 = $1.7M.
- Risk: OpenAI or Anthropic ship a personality layer and you're a feature. Mitigate by owning
  the character and the trust model, not the intelligence.

**Option B — keep the hardware, drop the agent.**

Pure companion. No laptop control, no email, no camera. Local wake word, charming, no
subscription, $249. That's Moflin's business, proven at ~7,000 units, and it sidesteps every
privacy and liability problem in section 3.

**Option A is the better business. Option B is the better object.** Doing both at once is the
one that fails.

---

## 5. What I'd actually do

Build it for yourself this month for $220. You'll learn whether you still talk to it in week
six — that single data point is worth more than everything above, and it costs a rounding
error compared to the $2M the company version needs.

If you're still talking to it in week six, build Option A. If you've stopped, you just saved
yourself eighteen months.

---

## Sources

- [OpenAI Realtime API pricing measured over 4,000 sessions](https://hackernoon.com/openai-realtime-api-pricing-in-2026-real-world-data-from-4000-measured-sessions)
- [Voice AI pricing breakdown 2026](https://www.cloudtalk.io/blog/how-much-does-voice-ai-cost/)
- [Speech-to-text API pricing comparison](https://www.assemblyai.com/blog/speech-to-text-api-pricing)
- [Understanding gross margin in hardware — Dragon Innovation](https://blog.dragoninnovation.com/blog/2016/05/26/understanding-gross-margin-hardware)
- [Consumer electronics financial benchmarks 2026](https://eightx.co/blog/electronics-financial-benchmark)
- [Hardware by the numbers: retail and exits — Bolt](https://blog.bolt.io/hardware-retail-exits/)
- [AI product failures 2026: Humane and Rabbit](https://www.digitalapplied.com/blog/ai-product-failures-2026-sora-humane-rabbit-lessons)
- [Rabbit R1 maker plagued by unpaid employees](https://techstory.in/rabbit-r1-maker-plagued-by-unpaid-employees-as-company-vows-new-ai-hardware/)
- [Humane flooded with $1M in AI Pin returns](https://www.tomsguide.com/ai/humane-flooded-with-dollar1-million-in-ai-pin-returns-as-ai-gadget-dumpster-fire-rages-on)
- [China's cute robot pets emerge as cuddly companions (Moflin unit sales)](https://asianews.network/chinas-cute-robot-pets-emerge-as-cuddly-companions/)
- [AI electronic pets market outlook 2026–2032](https://www.intelmarketresearch.com/ai-electronic-pets-market-26138)
- [Best AI agents for desktop 2026](https://manus.im/blog/best-ai-agents-for-desktop)
- [AI that controls your computer: 4 tools tested](https://www.originalobjective.com/blog/ai-agents-can-now-control-your-desktop-here-is-how-to-use-them-safely)
