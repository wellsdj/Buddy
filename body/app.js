const images = [
  'assets/starfield-lavender.png', 'assets/alpine-dawn.png', 'assets/coastal-sunset.png',
  'assets/forest-waterfall.png', 'assets/desert-moonrise.png'
];
const replies = [
  'The room feels like it is waiting for a good idea.',
  'A tiny note from tomorrow: you are closer than you think.',
  'I would put the kettle on, if I had hands.',
  'The quietest things are often doing the most work.',
  'I have filed that thought under: worth keeping.'
];
const orb = document.querySelector('.orb');
const scenery = document.querySelector('.scenery');
const clock = document.querySelector('#clock');
const date = document.querySelector('#date');
const greeting = document.querySelector('#greeting');
const transcript = document.querySelector('#transcript');
const reply = document.querySelector('#reply');
const voiceToggle = document.querySelector('#voice-toggle');
const wakePattern = /\b(?:hey|hi|hay)\s+(?:buddy|buddey|buddie|body)\b[,.]?\s*/i;
const wakeReplies = ['Yes?', 'I’m here.', 'Ohh — I’m listening.', 'What’s up?'];
let imageIndex = 0, busy = false, awake = false, recognition, voiceEnabled = true, speaking = false;

function updateClock() {
  const now = new Date();
  clock.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  date.textContent = now.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  const hour = now.getHours();
  greeting.textContent = hour < 12 ? 'good morning, wells' : hour < 18 ? 'good afternoon, wells' : 'good evening, wells';
}
function nextScene() {
  imageIndex = (imageIndex + 1) % images.length;
  scenery.style.opacity = '0';
  setTimeout(() => { scenery.style.backgroundImage = `url('${images[imageIndex]}')`; scenery.style.opacity = '1'; }, 900);
}
function showTranscript(words) {
  reply.classList.remove('show');
  transcript.querySelector('p').textContent = words || 'I’m listening…';
  transcript.classList.add('show');
}

async function say(text, onend) {
  speaking = true;
  recognition?.stop();
  const finish = () => { speaking = false; onend?.(); };
  try {
    const response = await fetch('/api/voice', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text })
    });
    if (!response.ok) throw new Error('ElevenLabs voice unavailable');
    const audio = new Audio(URL.createObjectURL(await response.blob()));
    audio.onended = finish;
    audio.onerror = finish;
    await audio.play();
  } catch (_) {
    if (!('speechSynthesis' in window)) return finish();
    const voice = new SpeechSynthesisUtterance(text);
    voice.rate = .94;
    voice.pitch = 1.02;
    voice.onend = finish;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(voice);
  }
}

function acknowledgeWake() {
  const message = wakeReplies[Math.floor(Math.random() * wakeReplies.length)];
  showTranscript('I’m listening…');
  reply.querySelector('p').textContent = message;
  reply.classList.add('show');
  say(message, () => { if (voiceEnabled && !busy) startRecognition(); });
}

async function answer(request) {
  if (busy) return;
  busy = true;
  let message = replies[Math.floor(Math.random() * replies.length)];
  transcript.classList.remove('show');
  try {
    const response = await fetch('/api/buddy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript: request })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Buddy could not respond.');
    message = data.message;
  } catch (error) {
    console.warn('Buddy API unavailable; using local reply.', error);
  }
  reply.querySelector('p').textContent = message;
  reply.classList.add('show');
  orb.classList.remove('is-listening');
  say(message, resetVoice);
}

function resetVoice() {
  busy = false;
  // Once Buddy has been woken, keep the conversation open until Voice is turned off.
  setTimeout(startRecognition, 350);
}

function startRecognition() {
  if (!recognition || busy || !voiceEnabled || speaking) return;
  try { recognition.start(); } catch (_) { /* already listening */ }
}

if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  recognition = new Recognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = navigator.language || 'en-US';
  recognition.onresult = event => {
    if (busy) return;
    let words = '';
    let final = false;
    for (let i = event.resultIndex; i < event.results.length; i++) {
      words += event.results[i][0].transcript;
      final ||= event.results[i].isFinal;
    }
    const wakeMatch = words.match(wakePattern);
    if (!awake && wakeMatch) {
      awake = true;
      orb.classList.add('is-listening');
      const request = words.slice((wakeMatch.index || 0) + wakeMatch[0].length).trim();
      if (final && request) {
        showTranscript(request);
        setTimeout(() => answer(request), 550);
      } else if (final) {
        acknowledgeWake();
      }
      return;
    }
    if (awake && words.trim()) {
      const request = words.replace(wakePattern, '').trim();
      if (!request) return;
      showTranscript(request);
      if (final) setTimeout(() => answer(request), 550);
    }
  };
  recognition.onend = () => { if (!busy && voiceEnabled && !speaking) setTimeout(startRecognition, 300); };
  recognition.onerror = event => {
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') return;
    if (!busy) setTimeout(startRecognition, 800);
  };
  startRecognition();
  orb.addEventListener('click', startRecognition);
}
voiceToggle.addEventListener('click', () => {
  voiceEnabled = !voiceEnabled;
  voiceToggle.textContent = voiceEnabled ? 'Voice on' : 'Voice off';
  voiceToggle.setAttribute('aria-pressed', String(voiceEnabled));
  if (voiceEnabled) {
    reply.classList.remove('show');
    startRecognition();
  } else {
    awake = false;
    busy = false;
    orb.classList.remove('is-listening');
    recognition?.stop();
    window.speechSynthesis?.cancel();
    speaking = false;
    transcript.classList.remove('show');
    reply.querySelector('p').textContent = 'Voice is off — no requests will be sent.';
    reply.classList.add('show');
  }
});
updateClock(); setInterval(updateClock, 1000); setInterval(nextScene, 600000);
