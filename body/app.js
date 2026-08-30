const images = [
  'assets/lake-canyon.jpg', 'assets/ice-mountains.jpg', 'assets/rain-forest.jpg',
  'assets/mountain-sunset.jpg', 'assets/earth-space.jpg', 'assets/starfield-lavender.png',
  'assets/alpine-dawn.png', 'assets/coastal-sunset.png', 'assets/forest-waterfall.png',
  'assets/desert-moonrise.png'
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
let imageIndex = 0, busy = false, awake = false, voiceEnabled = true, speaking = false;
let audioContext, micAnalyser, micStream, activeAnalyser, ringFrame, mediaRecorder;
let voiceMonitorFrame, speechStartedAt = 0, silenceStartedAt = 0, transcribing = false, recordingStopping = false;
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

function recorderMimeType() {
  return ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']
    .find(type => MediaRecorder.isTypeSupported(type)) || '';
}

function startSpeechRecording() {
  if (!micStream || mediaRecorder?.state === 'recording' || recordingStopping || busy || speaking || transcribing) return;
  const chunks = [];
  mediaRecorder = new MediaRecorder(micStream, recorderMimeType() ? { mimeType: recorderMimeType() } : undefined);
  mediaRecorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
  mediaRecorder.onstop = async () => {
    recordingStopping = false;
    if (!chunks.length || busy || speaking || !voiceEnabled) return;
    const audio = new Blob(chunks, { type: mediaRecorder.mimeType || 'audio/webm' });
    if (audio.size < 1_000) return;
    transcribing = true;
    try {
      const response = await fetch('/api/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': audio.type || 'audio/webm' },
        body: audio
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Groq transcription failed.');
      handleRecognizedSpeech(data.text || '');
    } catch (error) {
      console.warn('Groq speech recognition unavailable.', error);
    } finally {
      transcribing = false;
    }
  };
  speechStartedAt = performance.now();
  silenceStartedAt = 0;
  mediaRecorder.start();
}

function stopSpeechRecording() {
  if (mediaRecorder?.state === 'recording') {
    recordingStopping = true;
    mediaRecorder.stop();
  }
}

function monitorVoiceActivity(time = 0) {
  if (voiceEnabled && !busy && !speaking && micAnalyser) {
    const samples = new Uint8Array(micAnalyser.fftSize);
    micAnalyser.getByteTimeDomainData(samples);
    let energy = 0;
    for (const sample of samples) energy += Math.pow((sample - 128) / 128, 2);
    const volume = Math.sqrt(energy / samples.length);
    if (volume > .028) {
      silenceStartedAt = 0;
      startSpeechRecording();
    } else if (mediaRecorder?.state === 'recording') {
      silenceStartedAt ||= time;
      const speechLength = time - speechStartedAt;
      if ((speechLength > 650 && time - silenceStartedAt > 850) || speechLength > 12_000) stopSpeechRecording();
    }
  }
  voiceMonitorFrame = requestAnimationFrame(monitorVoiceActivity);
}

function handleRecognizedSpeech(words) {
  const cleanWords = words.trim();
  if (!cleanWords || busy || speaking) return;
  const wakeMatch = cleanWords.match(wakePattern);
  if (!awake && wakeMatch) {
    awake = true;
    orb.classList.add('is-listening');
    const request = cleanWords.slice((wakeMatch.index || 0) + wakeMatch[0].length).trim();
    if (request) answer(request);
    else acknowledgeWake();
    return;
  }
  if (awake) {
    const request = cleanWords.replace(wakePattern, '').trim();
    if (request) answer(request);
  }
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
  stopSpeechRecording();
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
  const message = 'I’m here.';
  showTranscript('I’m listening…');
  reply.querySelector('p').textContent = message;
  say(message, () => { if (voiceEnabled && !busy) startRecognition(); });
}

async function answer(request) {
  if (busy) return;
  busy = true;
  try {
    const response = await fetch('/api/buddy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript: request, messages: conversation.slice(-20) })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Buddy could not respond.');
    const message = data.message;
    conversation.push(
      { role: 'user', content: request },
      { role: 'assistant', content: message }
    );
    if (conversation.length > 20) conversation.splice(0, conversation.length - 20);
    localStorage.setItem(conversationStorageKey, JSON.stringify(conversation));
    reply.querySelector('p').textContent = message;
    orb.classList.remove('is-listening');
    say(message, resetVoice);
  } catch (error) {
    console.warn('Buddy API unavailable.', error);
    busy = false;
    orb.classList.remove('is-listening', 'is-speaking');
    startRecognition();
  }
}

function resetVoice() {
  busy = false;
  // Once Buddy has been woken, keep the conversation open until Voice is turned off.
  setTimeout(startRecognition, 350);
}

async function startRecognition() {
  if (busy || !voiceEnabled || speaking) return;
  await startMicMeter();
  if (awake) {
    orb.classList.add('is-listening');
  }
}
startRecognition();
orb.addEventListener('click', startRecognition);
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
    stopSpeechRecording();
    micStream?.getTracks().forEach(track => track.stop());
    micStream = undefined;
    micAnalyser = undefined;
    activeAnalyser = undefined;
    window.speechSynthesis?.cancel();
    speaking = false;
    reply.querySelector('p').textContent = 'Voice is off — no requests will be sent.';
  }
});
updateClock();
drawVoiceRing();
monitorVoiceActivity();
setInterval(updateClock, 1000);
setInterval(nextScene, 180000);
