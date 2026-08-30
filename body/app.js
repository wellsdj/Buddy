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
const artifactEditor = document.querySelector('#artifact-editor');
const editorRecipient = document.querySelector('#editor-recipient');
const editorSubject = document.querySelector('#editor-subject');
const editorBody = document.querySelector('#editor-body');
const editorOk = document.querySelector('#editor-ok');
const wakePattern = /\b(?:hey|hi|hay)\s+(?:buddy|buddey|buddie|body)\b[,.]?\s*/i;
let imageIndex = 0, awake = false, voiceEnabled = true, speaking = false;
let audioContext, micAnalyser, micStream, activeAnalyser, ringFrame, mediaRecorder;
let voiceMonitorFrame, speechStartedAt = 0, silenceStartedAt = 0, transcribing = false, recordingStopping = false;
let voiceColorPhase = 0;
let currentAudio, lastUserActivity = Date.now(), nextJobId = 1;
const speechQueue = [];
const backgroundJobs = new Map();
let pendingArtifact;
let pendingCompositionRequest;
const conversationStorageKey = 'buddy-conversation-v1';
let conversation = [];
try {
  const savedConversation = JSON.parse(localStorage.getItem(conversationStorageKey) || '[]');
  if (Array.isArray(savedConversation)) conversation = savedConversation.slice(-20);
} catch (_) { /* start a fresh conversation if saved data is invalid */ }

function newRequestId(prefix = 'web') {
  return `${prefix}-${Date.now()}-${crypto.randomUUID?.() || Math.random().toString(36).slice(2)}`;
}

function clientLog(event, details = {}, requestId = newRequestId('log')) {
  console.info('[Buddy]', event, { requestId, ...details });
  fetch('/api/client-log', {
    method: 'POST',
    keepalive: true,
    headers: { 'Content-Type': 'application/json', 'x-buddy-request-id': requestId },
    body: JSON.stringify({ event, details })
  }).catch(() => {});
}

async function fetchWithTimeout(url, options, timeoutMs, requestId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs}ms.`)), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: { ...(options?.headers || {}), ...(requestId ? { 'x-buddy-request-id': requestId } : {}) }
    });
  } finally {
    clearTimeout(timer);
  }
}

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
  const baseRadius = center - 10;
  const averageEnergy = bins.reduce((sum, value) => sum + value, 0) / Math.max(1, bins.length) / 255;
  const weightedEnergy = bins.reduce((sum, value, index) => sum + value * index, 0);
  const spectralPosition = weightedEnergy
    ? weightedEnergy / bins.reduce((sum, value) => sum + value, 0) / bins.length
    : .5;
  voiceColorPhase += .0025 + averageEnergy * .055 + spectralPosition * .004;
  ringContext.lineCap = 'round';

  const gradient = ringContext.createConicGradient(voiceColorPhase, center, center);
  gradient.addColorStop(0, '#ff7f8f');
  gradient.addColorStop(.18, '#ffc0cb');
  gradient.addColorStop(.37, '#d6b7ff');
  gradient.addColorStop(.58, '#85cfff');
  gradient.addColorStop(.76, '#7898ff');
  gradient.addColorStop(.9, '#e59cdb');
  gradient.addColorStop(1, '#ff7f8f');

  for (const layer of [
    { width: 18, alpha: .16, blur: 28 },
    { width: 9, alpha: .34, blur: 18 },
    { width: 4.5, alpha: .96, blur: 10 }
  ]) {
    ringContext.save();
    ringContext.beginPath();
    ringContext.arc(center, center, baseRadius, 0, Math.PI * 2);
    ringContext.globalAlpha = layer.alpha + averageEnergy * .08;
    ringContext.strokeStyle = gradient;
    ringContext.shadowColor = spectralPosition > .5 ? '#809fff' : '#ff8fa3';
    ringContext.shadowBlur = layer.blur;
    ringContext.lineWidth = layer.width;
    ringContext.stroke();
    ringContext.restore();
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
  if (!micStream || artifactEditor.open || mediaRecorder?.state === 'recording' || recordingStopping || speaking || transcribing) return;
  const chunks = [];
  mediaRecorder = new MediaRecorder(micStream, recorderMimeType() ? { mimeType: recorderMimeType() } : undefined);
  mediaRecorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
  mediaRecorder.onstop = async () => {
    recordingStopping = false;
    if (!chunks.length || speaking || !voiceEnabled) return;
    const audio = new Blob(chunks, { type: mediaRecorder.mimeType || 'audio/webm' });
    if (audio.size < 1_000) return;
    transcribing = true;
    try {
      const requestId = newRequestId('stt');
      clientLog('transcription_start', { audioBytes: audio.size }, requestId);
      const response = await fetchWithTimeout('/api/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': audio.type || 'audio/webm' },
        body: audio
      }, 25_000, requestId);
      const responseType = response.headers.get('content-type') || '';
      const data = responseType.includes('application/json')
        ? await response.json()
        : { error: `Transcription service returned ${response.status}.` };
      if (!response.ok) throw new Error(data.error || 'Groq transcription failed.');
      clientLog('transcription_complete', { textLength: (data.text || '').length }, requestId);
      handleRecognizedSpeech(data.text || '');
    } catch (error) {
      console.warn('Groq speech recognition unavailable.', error);
      clientLog('transcription_error', { error: error instanceof Error ? error.message : String(error) });
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
  if (voiceEnabled && !artifactEditor.open && !speaking && micAnalyser) {
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
  if (!cleanWords || speaking) return;
  lastUserActivity = Date.now();
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

function say(text, onend) {
  if (!text?.trim()) return onend?.();
  speechQueue.push({ text: text.trim(), onend });
  playNextSpeech();
}

async function playNextSpeech() {
  if (speaking || !speechQueue.length || !voiceEnabled) return;
  const { text, onend } = speechQueue.shift();
  speaking = true;
  orb.classList.remove('is-listening');
  orb.classList.add('is-speaking');
  stopSpeechRecording();
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    speaking = false;
    currentAudio = undefined;
    orb.classList.remove('is-speaking');
    activeAnalyser = micAnalyser;
    onend?.();
    playNextSpeech();
  };
  try {
    const requestId = newRequestId('voice');
    clientLog('voice_start', { textLength: text.length }, requestId);
    const response = await fetchWithTimeout('/api/voice', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text })
    }, 25_000, requestId);
    if (!response.ok) throw new Error('ElevenLabs voice unavailable');
    clientLog('voice_audio_ready', {}, requestId);
    currentAudio = new Audio(URL.createObjectURL(await response.blob()));
    await connectResponseMeter(currentAudio);
    currentAudio.onended = finish;
    currentAudio.onerror = finish;
    await currentAudio.play();
  } catch (error) {
    clientLog('voice_fallback', { error: error instanceof Error ? error.message : String(error) });
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
  say(message, () => { if (voiceEnabled) startRecognition(); });
}

function isBackgroundAction(request) {
  const action = /\b(write|draft|send|email|message|text|reply|forward|find|read|check|play|put on|pause|resume|skip|open|create|update|search|look up|inspect)\b/i;
  const service = /\b(email|e-mail|gmail|spotify|message|text|github|repo|repository|vercel|deployment)\b/i;
  return action.test(request) && service.test(request);
}

function actionAcknowledgement(request) {
  if (/\b(email|e-mail|gmail)\b/i.test(request)) return /\b(send)\b/i.test(request)
    ? 'Yes—checking that and sending it now.'
    : 'Yes—writing that email now.';
  if (/\bspotify\b/i.test(request)) return 'Yep—sorting Spotify now.';
  if (/\b(message|text)\b/i.test(request)) return 'Yep—working on that message now.';
  if (/\b(github|repo|repository)\b/i.test(request)) return 'Sure—I’m checking GitHub now.';
  if (/\b(vercel|deployment)\b/i.test(request)) return 'Sure—I’m checking that deployment now.';
  return 'Yep—I’m on it.';
}

function requestedActionCategory(request) {
  if (/\b(email|e-mail|gmail)\b/i.test(request)) return 'gmail';
  if (/\bspotify\b/i.test(request)) return 'spotify';
  if (/\b(message|text)\b/i.test(request)) return 'messages';
  if (/\b(github|repo|repository)\b/i.test(request)) return 'github';
  if (/\b(vercel|deployment)\b/i.test(request)) return 'vercel';
  return 'general';
}

function saveConversation(userMessage, assistantMessage) {
  conversation.push(
    { role: 'user', content: userMessage },
    { role: 'assistant', content: assistantMessage }
  );
  if (conversation.length > 20) conversation.splice(0, conversation.length - 20);
  localStorage.setItem(conversationStorageKey, JSON.stringify(conversation));
}

async function requestBuddy(request, operation) {
  const requestId = newRequestId('buddy');
  const startedAt = performance.now();
  clientLog('request_start', { operation: operation || 'reply', textLength: request.length }, requestId);
  try {
    const response = await fetchWithTimeout('/api/buddy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript: request, messages: conversation.slice(-20), operation })
    }, 52_000, requestId);
    const responseType = response.headers.get('content-type') || '';
    const data = responseType.includes('application/json')
      ? await response.json()
      : { error: `Buddy returned ${response.status} instead of JSON.` };
    clientLog(response.ok ? 'request_complete' : 'request_error', {
      status: response.status,
      durationMs: Math.round(performance.now() - startedAt),
      error: response.ok ? undefined : data.error
    }, requestId);
    if (!response.ok) throw new Error(data.error || 'Buddy could not respond.');
    return data;
  } catch (error) {
    clientLog('request_failed', {
      durationMs: Math.round(performance.now() - startedAt),
      error: error instanceof Error ? error.message : String(error)
    }, requestId);
    throw error;
  }
}

function showArtifactEditor() {
  if (!pendingArtifact) return;
  stopSpeechRecording();
  editorRecipient.value = pendingArtifact.recipient || '';
  editorSubject.value = pendingArtifact.subject || '';
  editorBody.value = pendingArtifact.body || '';
  artifactEditor.showModal();
  setTimeout(() => editorBody.focus(), 50);
}

artifactEditor.addEventListener('close', () => startRecognition());

editorOk.addEventListener('click', event => {
  event.preventDefault();
  if (!pendingArtifact) return artifactEditor.close();
  pendingArtifact = {
    ...pendingArtifact,
    recipient: editorRecipient.value.trim(),
    subject: editorSubject.value.trim(),
    body: editorBody.value.trim(),
    reviewed: true
  };
  artifactEditor.close();
  const message = 'Got it—I’ll use exactly that text. Shall I create the Gmail draft, or send it?';
  reply.querySelector('p').textContent = message;
  say(message, startRecognition);
});

function isEmailComposition(request) {
  return /\b(email|e-mail|gmail)\b/i.test(request)
    && (/\b(write|draft|compose|send|reply|forward)\b/i.test(request) || /^email\b/i.test(request));
}

async function prepareEmailArtifact(request) {
  const acknowledgement = 'Of course—I’ll write it first so you can check it.';
  reply.querySelector('p').textContent = acknowledgement;
  say(acknowledgement, startRecognition);
  try {
    const data = await requestBuddy(request, 'compose_email');
    if (data.draft) {
      pendingArtifact = { ...data.draft, originalRequest: request, reviewed: false };
      pendingCompositionRequest = undefined;
    } else {
      pendingCompositionRequest = request;
    }
    saveConversation(request, data.message);
    reply.querySelector('p').textContent = data.message;
    say(data.message, startRecognition);
  } catch (error) {
    console.warn('Buddy could not prepare the email.', error);
    say('I couldn’t prepare that email just now. Please try again.', startRecognition);
  }
}

function executePendingEmail(send) {
  if (!pendingArtifact) return;
  if (!pendingArtifact.recipient.includes('@')) {
    const message = `I still need ${pendingArtifact.recipient || 'the recipient'}’s email address. Add it in the To field and press OK.`;
    reply.querySelector('p').textContent = message;
    say(message, showArtifactEditor);
    return;
  }
  if (send && !pendingArtifact.reviewed) {
    const message = 'Let me show it to you before I send anything.';
    reply.querySelector('p').textContent = message;
    say(message, showArtifactEditor);
    return;
  }
  const action = send ? 'Send this email now' : 'Create this Gmail draft without sending it';
  const exactRequest = `${action}. Use this exact content. To: ${pendingArtifact.recipient}. Subject: ${pendingArtifact.subject}. Body: ${pendingArtifact.body}`;
  runBackgroundAction(exactRequest);
}

function latestJobStatusReply() {
  const latest = [...backgroundJobs.values()].at(-1);
  if (!latest) return '';
  if (latest.status === 'running') return `I’m still ${latest.activity}. I’ll tell you the moment it’s ready.`;
  if (latest.status === 'failed') return `That job hit a problem: ${latest.result}`;
  return `It’s finished. ${latest.result}`;
}

function announceJobWhenFree(job) {
  if (job.announced || !voiceEnabled) return;
  const userIsActive = Date.now() - lastUserActivity < 1400;
  const microphoneIsActive = mediaRecorder?.state === 'recording' || transcribing;
  if (speaking || speechQueue.length || userIsActive || microphoneIsActive) {
    setTimeout(() => announceJobWhenFree(job), 500);
    return;
  }
  job.announced = true;
  const notice = job.status === 'done'
    ? `By the way, that’s finished. ${job.result}`
    : `Quick update—that didn’t work. ${job.result}`;
  reply.querySelector('p').textContent = notice;
  say(notice, startRecognition);
}

async function runBackgroundAction(request) {
  const acknowledgement = actionAcknowledgement(request);
  const job = {
    id: nextJobId++, request, status: 'running', result: '', announced: false,
    activity: acknowledgement.replace(/^(yes|yep|sure)[—,\s]+/i, '').replace(/[.!]$/, '').toLowerCase()
  };
  backgroundJobs.set(job.id, job);
  clientLog('background_job_started', { jobId: job.id, category: requestedActionCategory(request) });
  reply.querySelector('p').textContent = acknowledgement;
  say(acknowledgement, startRecognition);
  try {
    job.result = (await requestBuddy(request)).message;
    job.status = 'done';
    clientLog('background_job_completed', { jobId: job.id });
    saveConversation(request, job.result);
  } catch (error) {
    console.warn('Buddy background action failed.', error);
    job.status = 'failed';
    job.result = error instanceof Error ? error.message : 'I couldn’t finish it.';
    clientLog('background_job_failed', { jobId: job.id, error: job.result });
  }
  announceJobWhenFree(job);
}

async function answer(request) {
  if (pendingCompositionRequest) {
    if (/^(never mind|cancel|stop)(?:[.!])?$/i.test(request.trim())) {
      pendingCompositionRequest = undefined;
      say('No problem—I’ve cancelled that draft.', startRecognition);
      return;
    }
    const originalRequest = pendingCompositionRequest;
    pendingCompositionRequest = undefined;
    prepareEmailArtifact(`${originalRequest}\nAdditional information from Wells: ${request}`);
    return;
  }
  if (pendingArtifact && /\b(show|display|open|edit|change|correct|fix)\b.*\b(it|email|draft|text)\b|\b(show|display|edit) (?:the )?(?:email|draft)\b/i.test(request)) {
    showArtifactEditor();
    return;
  }
  if (pendingArtifact && /\b(send it|send the email|send that)\b/i.test(request)) {
    executePendingEmail(true);
    return;
  }
  if (pendingArtifact && (/\b(create|save|make)\b.*\b(draft|email)\b/i.test(request)
    || /^(yes|okay|ok|confirm)(?:[.!])?$/i.test(request.trim()))) {
    executePendingEmail(false);
    return;
  }
  if (isEmailComposition(request)) {
    prepareEmailArtifact(request);
    return;
  }
  if (/\b(is it done|are you done|finished yet|how is that going|what's the status|what is the status)\b/i.test(request)) {
    const status = latestJobStatusReply();
    if (status) {
      reply.querySelector('p').textContent = status;
      say(status, startRecognition);
      return;
    }
  }
  if (isBackgroundAction(request)) {
    runBackgroundAction(request);
    return;
  }
  try {
    const message = (await requestBuddy(request)).message;
    saveConversation(request, message);
    reply.querySelector('p').textContent = message;
    orb.classList.remove('is-listening');
    say(message, startRecognition);
  } catch (error) {
    console.warn('Buddy API unavailable.', error);
    orb.classList.remove('is-listening', 'is-speaking');
    const message = /timed out|abort/i.test(error instanceof Error ? error.message : '')
      ? 'Sorry—that took too long, so I stopped it instead of leaving you waiting. Please try that once more.'
      : 'Sorry—I hit a problem with that request. I’m still listening, so you can try again.';
    reply.querySelector('p').textContent = message;
    say(message, startRecognition);
  }
}

async function startRecognition() {
  if (!voiceEnabled || speaking) return;
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
    speechQueue.length = 0;
    orb.classList.remove('is-listening', 'is-speaking');
    stopSpeechRecording();
    micStream?.getTracks().forEach(track => track.stop());
    micStream = undefined;
    micAnalyser = undefined;
    activeAnalyser = undefined;
    currentAudio?.pause();
    currentAudio = undefined;
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
