const images = [
  'assets/lake-canyon.jpg', 'assets/ice-mountains.jpg', 'assets/rain-forest.jpg',
  'assets/mountain-sunset.jpg', 'assets/earth-space.jpg', 'assets/starfield-lavender.png',
  'assets/alpine-dawn.png', 'assets/coastal-sunset.png', 'assets/forest-waterfall.png',
  'assets/desert-moonrise.png'
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
const voiceRing = document.querySelector('#voice-ring');
const ringContext = voiceRing.getContext('2d');
const voiceToggle = document.querySelector('#voice-toggle');
const wakePattern = /\b(?:hey|hi|hay)\s+(?:buddy|buddey|buddie|body)\b[,.]?\s*/i;
const wakeReplies = ['Yes?', 'I’m here.', 'Ohh — I’m listening.', 'What’s up?'];
let imageIndex = 0, busy = false, awake = false, recognition, voiceEnabled = true, speaking = false;
let audioContext, micAnalyser, micStream, activeAnalyser, ringFrame;
const conversationStorageKey = 'buddy-conversation-v1';
let conversation = [];
try {
  const savedConversation = JSON.parse(localStorage.getItem(conversationStorageKey) || '[]');
  if (Array.isArray(savedConversation)) conversation = savedConversation.slice(-20);
} catch (_) { /* start a fresh conversation if saved data is invalid */ }

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
  transcript.querySelector('p').textContent = words || 'I’m listening…';
}

function drawVoiceRing(time = 0) {
  const size = orb.clientWidth;
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  if (voiceRing.width !== Math.round(size * pixelRatio)) {
    voiceRing.width = Math.round(size * pixelRatio);
    voiceRing.height = Math.round(size * pixelRatio);
  }
  ringContext.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  ringContext.clearRect(0, 0, size, size);

  if (!orb.classList.contains('is-listening') && !orb.classList.contains('is-speaking')) {
    ringFrame = requestAnimationFrame(drawVoiceRing);
    return;
  }

  const bins = new Uint8Array(activeAnalyser?.frequencyBinCount || 64);
  if (activeAnalyser) activeAnalyser.getByteFrequencyData(bins);
  const center = size / 2;
  const baseRadius = center - 12;
  const segments = 150;
  const idlePulse = .16 + Math.sin(time / 420) * .05;
  ringContext.lineCap = 'round';

  ringContext.save();
  ringContext.beginPath();
  ringContext.arc(center, center, baseRadius, 0, Math.PI * 2);
  ringContext.strokeStyle = 'rgba(255,255,255,.26)';
  ringContext.shadowColor = 'rgba(170,225,255,.75)';
  ringContext.shadowBlur = 18;
  ringContext.lineWidth = 2.2;
  ringContext.stroke();
  ringContext.restore();

  for (let index = 0; index < segments; index++) {
    const angle = (index / segments) * Math.PI * 2 - Math.PI / 2;
    const nextAngle = angle + (Math.PI * 2 / segments) * .72;
    const bin = bins[Math.floor((index / segments) * bins.length)] || 0;
    const energy = Math.max(idlePulse, Math.pow(bin / 255, .72));
    const hue = 188 + (index / segments) * 42;
    ringContext.beginPath();
    ringContext.arc(center, center, baseRadius - energy * 3.5, angle, nextAngle);
    ringContext.strokeStyle = `hsla(${hue}, 96%, ${72 + energy * 20}%, ${.42 + energy * .58})`;
    ringContext.shadowColor = `hsla(${hue}, 100%, 72%, .95)`;
    ringContext.shadowBlur = 8 + energy * 23;
    ringContext.lineWidth = 2.4 + energy * 7;
    ringContext.stroke();
  }
  ringFrame = requestAnimationFrame(drawVoiceRing);
}

async function startMicMeter() {
  if (!navigator.mediaDevices?.getUserMedia) return;
  try {
    audioContext ||= new AudioContext();
    if (audioContext.state === 'suspended') await audioContext.resume();
    if (!micStream) micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (!micAnalyser) {
      micAnalyser = audioContext.createAnalyser();
      micAnalyser.fftSize = 256;
      micAnalyser.smoothingTimeConstant = .72;
      audioContext.createMediaStreamSource(micStream).connect(micAnalyser);
    }
    activeAnalyser = micAnalyser;
  } catch (_) { activeAnalyser = undefined; }
}

async function connectResponseMeter(audio) {
  try {
    audioContext ||= new AudioContext();
    if (audioContext.state === 'suspended') await audioContext.resume();
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = .76;
    const source = audioContext.createMediaElementSource(audio);
    source.connect(analyser);
    analyser.connect(audioContext.destination);
    activeAnalyser = analyser;
  } catch (_) { activeAnalyser = undefined; }
}

async function say(text, onend) {
  speaking = true;
  orb.classList.remove('is-listening');
  orb.classList.add('is-speaking');
  recognition?.stop();
  const finish = () => {
    speaking = false;
    orb.classList.remove('is-speaking');
    activeAnalyser = micAnalyser;
    onend?.();
  };
  try {
    const response = await fetch('/api/voice', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text })
    });
    if (!response.ok) throw new Error('ElevenLabs voice unavailable');
    const audio = new Audio(URL.createObjectURL(await response.blob()));
    await connectResponseMeter(audio);
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
  say(message, () => { if (voiceEnabled && !busy) startRecognition(); });
}

async function answer(request) {
  if (busy) return;
  busy = true;
  let message = replies[Math.floor(Math.random() * replies.length)];
  try {
    const response = await fetch('/api/buddy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript: request, messages: conversation.slice(-20) })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Buddy could not respond.');
    message = data.message;
    conversation.push(
      { role: 'user', content: request },
      { role: 'assistant', content: message }
    );
    if (conversation.length > 20) conversation.splice(0, conversation.length - 20);
    localStorage.setItem(conversationStorageKey, JSON.stringify(conversation));
  } catch (error) {
    console.warn('Buddy API unavailable; using local reply.', error);
  }
  reply.querySelector('p').textContent = message;
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
  if (awake) {
    orb.classList.add('is-listening');
    startMicMeter();
  }
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
      startMicMeter();
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
    startRecognition();
  } else {
    awake = false;
    busy = false;
    orb.classList.remove('is-listening', 'is-speaking');
    recognition?.stop();
    window.speechSynthesis?.cancel();
    speaking = false;
    reply.querySelector('p').textContent = 'Voice is off — no requests will be sent.';
  }
});
updateClock();
drawVoiceRing();
setInterval(updateClock, 1000);
setInterval(nextScene, 180000);
