import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import express from 'express';
import { generateText, stepCountIs, tool } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGroq } from '@ai-sdk/groq';
import { createMCPClient } from '@ai-sdk/mcp';
import { z } from 'zod';

const root = path.dirname(fileURLToPath(import.meta.url));
const interfaceRoot = path.join(root, 'body');
if (!process.env.VERCEL) dotenv.config({ path: process.env.BUDDY_LOCAL_ENV_FILE || '.env.local' });
const app = express();
const anthropic = createAnthropic();
const groq = createGroq();
const runFile = promisify(execFile);
const composioSessions = new Map();
const composioMcpClients = new Map();
let pendingMessage;
let buddyRequestId = 0;
const buddySystemPrompt = `You are Buddy, a quick, warm helper-friend with Gmail, Spotify, GitHub, and Vercel tools.
Sound natural, upbeat, and relaxed, like a capable friend beside the user—not a formal customer-service assistant.
Use tools only when the user asks for an action or current account information.
When tools are needed, call the relevant app tool immediately without a spoken preamble and report only the confirmed result.
Never claim an action succeeded unless its tool result confirms it.
For email, create a draft by default; only send when the user clearly says to send.
Apple Messages is available only when Buddy is running locally on the owner's Mac. Never offer email as a substitute for an Apple Messages request.
For GitHub, treat access as read-only: you may inspect repositories, files, commits, issues, pull requests, reviews, and comments, but never create, edit, merge, close, delete, or dispatch anything.
For Vercel, treat access as read-only: you may inspect projects, deployments, domains, status, and logs, but never create, deploy, promote, redeploy, assign aliases, add or edit domains, change environment variables or settings, buy anything, or delete anything.
Reply promptly in one or two short spoken sentences unless the user asks for detail. Never pad a reply with generic filler.`;

function classifyRequest(transcript) {
  const integration = /\b(spotify|gmail|e-?mail|inbox|message|text|github|repository|repo|vercel|deployment|calendar)\b/i;
  const coding = /\b(code|coding|program|programming|repository|repo|github|commit|pull request|debug|bug|function|class|html|css|javascript|typescript|python|node|npm|api endpoint|database|sql|deploy|build an? (?:app|website|feature))\b/i;
  const difficultReasoning = /\b(analy[sz]e deeply|reason|prove|derive|strategy|trade-?offs?|compare in depth|complex|difficult|hard problem|step by step|architecture|research|investigate)\b/i;
  if (integration.test(transcript)) return 'tools';
  if (coding.test(transcript)) return 'coding';
  if (difficultReasoning.test(transcript) || transcript.length > 500) return 'reasoning';
  return 'simple';
}

function normalizeConversation(messages, transcript) {
  const history = Array.isArray(messages)
    ? messages.slice(-20).flatMap((message) => {
        if (!message || !['user', 'assistant'].includes(message.role) || typeof message.content !== 'string') return [];
        const content = message.content.trim().slice(0, 2_000);
        return content ? [{ role: message.role, content }] : [];
      })
    : [];
  if (history.at(-1)?.role !== 'user' || history.at(-1)?.content !== transcript) {
    history.push({ role: 'user', content: transcript });
  }
  return history.slice(-20);
}

async function generateBuddyReply({ model, messages, tools, system = buddySystemPrompt }) {
  return generateText({
    model,
    system,
    messages,
    maxOutputTokens: 500,
    tools,
    stopWhen: stepCountIs(4),
  });
}

function cleanBuddyReply(text) {
  const withoutThinkBlocks = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const closingThink = withoutThinkBlocks.lastIndexOf('</think>');
  return (closingThink >= 0 ? withoutThinkBlocks.slice(closingThink + 8) : withoutThinkBlocks).trim();
}

async function summarizeToolOutcome(transcript, result) {
  const toolResults = result.steps.flatMap((step) => step.toolResults || []);
  if (!toolResults.length) return '';
  const compactResults = toolResults.map(({ toolName, output }) => ({ toolName, output }));
  const summary = await generateText({
    model: groq(process.env.GROQ_FAST_MODEL || 'openai/gpt-oss-20b'),
    system: 'Give the user a friendly, factual one-sentence spoken update. Use only the tool results. Never claim success if the result shows an error.',
    messages: [{
      role: 'user',
      content: `Request: ${transcript}\nTool results: ${JSON.stringify(compactResults).slice(0, 6_000)}`
    }],
    maxOutputTokens: 160
  });
  return cleanBuddyReply(summary.text);
}

async function replyToBuddy(transcript, messages) {
  if (process.env.BUDDY_AI_ENABLED !== 'true') {
    throw new Error('Buddy AI is turned off.');
  }
  if (!process.env.ANTHROPIC_API_KEY && !process.env.GROQ_API_KEY) {
    throw new Error('Buddy is missing its AI provider keys.');
  }

  const requestId = ++buddyRequestId;
  const route = classifyRequest(transcript);
  const needsTools = route === 'tools';
  const composioTools = needsTools ? await getBuddyTools(transcript) : {};
  const messagesTools = needsTools && process.platform === 'darwin' && !process.env.VERCEL
    ? getMessagesTools(requestId)
    : {};
  const tools = { ...composioTools, ...messagesTools };
  const conversation = normalizeConversation(messages, transcript);
  const localMessagesRules = Object.keys(messagesTools).length
    ? '\nFor Apple Messages, always prepare and read back the draft first. Send only after a separate explicit confirmation.'
    : '';
  const system = buddySystemPrompt + localMessagesRules;

  if (route === 'coding') {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('Buddy needs its Claude key for this request.');
    const modelId = process.env.ANTHROPIC_CODING_MODEL || 'claude-sonnet-5';
    const result = await generateBuddyReply({ model: anthropic(modelId), messages: conversation, tools, system });
    return { message: cleanBuddyReply(result.text), mode: 'claude', route, model: modelId };
  }

  if (process.env.GROQ_API_KEY) {
    const modelIds = [
      route === 'simple'
        ? process.env.GROQ_FAST_MODEL || 'openai/gpt-oss-20b'
        : route === 'tools'
          ? process.env.GROQ_TOOL_MODEL || 'openai/gpt-oss-20b'
          : process.env.GROQ_PRIMARY_MODEL || 'qwen/qwen3.8-27b',
      ...(process.env.GROQ_FALLBACK_MODELS || 'llama-3.3-70b-versatile,qwen/qwen3.6-27b')
        .split(',').map((model) => model.trim()).filter(Boolean)
    ];
    for (const modelId of [...new Set(modelIds)]) {
      try {
        const result = await generateBuddyReply({
          model: groq(modelId),
          messages: conversation,
          tools,
          system
        });
        const message = cleanBuddyReply(result.text) || await summarizeToolOutcome(transcript, result);
        return { message: message || 'That’s finished.', mode: 'groq', route, model: modelId };
      } catch (error) {
        console.warn(`Groq model ${modelId} unavailable; trying fallback.`, error instanceof Error ? error.message : error);
      }
    }
  }

  throw new Error('Buddy could not reach an available Groq model.');
}

const resolveContactScript = `
on run argv
  set requestedName to item 1 of argv
  tell application "Contacts"
    set matches to every person whose name contains requestedName
    if (count of matches) is 0 then return "NOT_FOUND"
    if (count of matches) is greater than 1 then
      set foundNames to {}
      repeat with matchedPerson in matches
        set end of foundNames to name of matchedPerson
      end repeat
      set AppleScript's text item delimiters to "|"
      return "AMBIGUOUS|" & (foundNames as text)
    end if
    set matchedPerson to item 1 of matches
    set recipientHandle to ""
    if (count of phones of matchedPerson) is greater than 0 then
      set recipientHandle to value of item 1 of phones of matchedPerson
    else if (count of emails of matchedPerson) is greater than 0 then
      set recipientHandle to value of item 1 of emails of matchedPerson
    end if
    if recipientHandle is "" then return "NO_ADDRESS|" & name of matchedPerson
    return "FOUND|" & name of matchedPerson & "|" & recipientHandle
  end tell
end run`;

const sendMessageScript = `
on run argv
  set recipientHandle to item 1 of argv
  set messageText to item 2 of argv
  tell application "Messages"
    set targetService to first service whose service type is iMessage
    set targetBuddy to buddy recipientHandle of targetService
    send messageText to targetBuddy
  end tell
end run`;

async function resolveContact(recipientName) {
  const { stdout } = await runFile('osascript', ['-e', resolveContactScript, '--', recipientName]);
  const result = stdout.trim();
  if (result === 'NOT_FOUND') throw new Error(`No contact matched ${recipientName}.`);
  if (result.startsWith('AMBIGUOUS|')) {
    throw new Error(`More than one contact matched: ${result.slice(10).split('|').join(', ')}.`);
  }
  if (result.startsWith('NO_ADDRESS|')) throw new Error(`${result.slice(11)} has no phone number or email address.`);
  const [, displayName, ...handleParts] = result.split('|');
  return { displayName, handle: handleParts.join('|') };
}

function getMessagesTools(requestId) {
  return {
    PREPARE_MESSAGES_TEXT: tool({
      description: 'Resolve a person from macOS Contacts and prepare an Apple Messages text. This never sends.',
      inputSchema: z.object({
        recipientName: z.string().min(1).describe('The contact name spoken by the user.'),
        message: z.string().min(1).max(2000).describe('The exact message to prepare.')
      }),
      execute: async ({ recipientName, message }) => {
        const contact = await resolveContact(recipientName);
        pendingMessage = { ...contact, message, preparedRequestId: requestId };
        return { prepared: true, recipient: contact.displayName, message };
      }
    }),
    CHECK_PENDING_MESSAGE: tool({
      description: 'Check whether an Apple Messages draft is waiting for confirmation.',
      inputSchema: z.object({}),
      execute: async () => pendingMessage
        ? { pending: true, recipient: pendingMessage.displayName, message: pendingMessage.message }
        : { pending: false }
    }),
    SEND_PREPARED_MESSAGES_TEXT: tool({
      description: 'Send the already-prepared Apple Messages draft after a separate explicit user confirmation.',
      inputSchema: z.object({ confirmation: z.literal('send') }),
      execute: async () => {
        if (!pendingMessage) throw new Error('There is no prepared message to send.');
        if (pendingMessage.preparedRequestId === requestId) {
          throw new Error('Ask the user to confirm in a separate request before sending.');
        }
        const draft = pendingMessage;
        await runFile('osascript', ['-e', sendMessageScript, '--', draft.handle, draft.message]);
        pendingMessage = undefined;
        return { sent: true, recipient: draft.displayName };
      }
    })
  };
}

async function synthesizeBuddyVoice(text) {
  if (!process.env.ELEVENLABS_API_KEY || !process.env.ELEVENLABS_VOICE_ID) {
    throw new Error('Buddy is missing its ElevenLabs voice configuration.');
  }
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${process.env.ELEVENLABS_VOICE_ID}?output_format=mp3_44100_128`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'xi-api-key': process.env.ELEVENLABS_API_KEY },
      body: JSON.stringify({ text, model_id: 'eleven_flash_v2_5' })
    }
  );
  if (!response.ok) throw new Error('ElevenLabs could not create Buddy’s voice response.');
  return Buffer.from(await response.arrayBuffer());
}

async function composioRequest(pathname, options = {}) {
  if (!process.env.COMPOSIO_API_KEY) throw new Error('Buddy is missing its Composio API key.');
  const response = await fetch(`https://backend.composio.dev/api/v3.1${pathname}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.COMPOSIO_API_KEY,
      ...(options.headers || {})
    }
  });
  const data = await response.json();
  if (!response.ok) throw new Error('Composio could not set up Buddy’s app connection.');
  return data;
}

const directToolsByProfile = {
  gmail_read: ['GMAIL_FETCH_EMAILS'],
  gmail_draft: ['GMAIL_CREATE_EMAIL_DRAFT'],
  gmail_send: ['GMAIL_SEND_EMAIL'],
  spotify_profile: ['SPOTIFY_GET_CURRENT_USER_S_PROFILE'],
  spotify_current: ['SPOTIFY_GET_PLAYBACK_STATE'],
  spotify_play: [
    'SPOTIFY_SEARCH_FOR_ITEM',
    'SPOTIFY_GET_AVAILABLE_DEVICES',
    'SPOTIFY_START_RESUME_PLAYBACK',
    'SPOTIFY_TRANSFER_PLAYBACK'
  ],
  spotify_pause: [
    'SPOTIFY_GET_AVAILABLE_DEVICES',
    'SPOTIFY_PAUSE_PLAYBACK',
  ],
  spotify_resume: ['SPOTIFY_GET_AVAILABLE_DEVICES', 'SPOTIFY_START_RESUME_PLAYBACK'],
  spotify_next: ['SPOTIFY_SKIP_TO_NEXT'],
  spotify_previous: ['SPOTIFY_SKIP_TO_PREVIOUS']
};

const compactToolDescriptions = {
  GMAIL_FETCH_EMAILS: 'Find or read emails in the owner’s Gmail account.',
  GMAIL_CREATE_EMAIL_DRAFT: 'Create a Gmail draft. Do not send it.',
  GMAIL_SEND_EMAIL: 'Send an email only when the user explicitly asked to send it.',
  SPOTIFY_GET_CURRENT_USER_S_PROFILE: 'Read the connected Spotify profile.',
  SPOTIFY_GET_PLAYBACK_STATE: 'Read what Spotify is currently playing.',
  SPOTIFY_SEARCH_FOR_ITEM: 'Search Spotify for music.',
  SPOTIFY_GET_AVAILABLE_DEVICES: 'List available Spotify playback devices.',
  SPOTIFY_START_RESUME_PLAYBACK: 'Start or resume Spotify playback.',
  SPOTIFY_TRANSFER_PLAYBACK: 'Move Spotify playback to a named device.',
  SPOTIFY_PAUSE_PLAYBACK: 'Pause Spotify playback.',
  SPOTIFY_SKIP_TO_NEXT: 'Skip to the next Spotify item.',
  SPOTIFY_SKIP_TO_PREVIOUS: 'Return to the previous Spotify item.'
};

function requestedToolProfile(transcript) {
  if (/\b(gmail|e-?mail|inbox)\b/i.test(transcript)) {
    if (/\b(read|fetch|find|show|list|latest|newest|recent|inbox|subject)\b/i.test(transcript)) return 'gmail_read';
    return /\bsend\b/i.test(transcript) ? 'gmail_send' : 'gmail_draft';
  }
  if (/\bspotify\b/i.test(transcript)) {
    if (/\b(profile|display name|account)\b/i.test(transcript)) return 'spotify_profile';
    if (/\b(current|currently|what(?:'s| is) playing|playback state)\b/i.test(transcript)) return 'spotify_current';
    if (/\bpause|stop\b/i.test(transcript)) return 'spotify_pause';
    if (/\bresume|continue\b/i.test(transcript)) return 'spotify_resume';
    if (/\bnext|skip\b/i.test(transcript)) return 'spotify_next';
    if (/\bprevious|back\b/i.test(transcript)) return 'spotify_previous';
    return 'spotify_play';
  }
  return 'general';
}

async function getBuddyComposioSession(profile) {
  if (composioSessions.has(profile)) return composioSessions.get(profile);
  const toolkit = profile.split('_')[0];
  const vercelAccountId = await getLatestActiveConnectedAccountId('vercel');
  const directTools = directToolsByProfile[profile];
  const session = await composioRequest('/tool_router/session', {
    method: 'POST',
    body: JSON.stringify({
      user_id: 'buddy-owner',
      toolkits: { enable: directTools ? [toolkit] : ['github', 'vercel'] },
      ...(directTools ? {
        tools: { [toolkit]: { enable: directTools } },
        session_preset: 'direct_tools',
        sandbox: { enable: false }
      } : {}),
      ...(toolkit === 'spotify' ? { auth_configs: { spotify: 'ac_qbhoTCOXoeiu' } } : {}),
      ...(vercelAccountId
        ? { connected_accounts: { vercel: [vercelAccountId] } }
        : {})
    })
  });
  composioSessions.set(profile, session);
  return session;
}

async function getLatestActiveConnectedAccountId(toolkit) {
  const query = new URLSearchParams({
    toolkit_slugs: toolkit,
    user_ids: 'buddy-owner',
    statuses: 'ACTIVE',
    limit: '20'
  });
  const data = await composioRequest(`/connected_accounts?${query}`);
  const accounts = Array.isArray(data.items) ? data.items : [];
  return accounts
    .filter((account) => account.status === 'ACTIVE' && account.toolkit?.slug === toolkit)
    .sort((left, right) => new Date(right.updated_at) - new Date(left.updated_at))[0]?.id;
}

async function getBuddyTools(transcript) {
  const profile = requestedToolProfile(transcript);
  const session = await getBuddyComposioSession(profile);
  if (!composioMcpClients.has(profile)) {
    composioMcpClients.set(profile, await createMCPClient({
      transport: {
        type: 'http',
        url: session.mcp.url,
        headers: { 'x-api-key': process.env.COMPOSIO_API_KEY }
      }
    }));
  }
  const tools = await composioMcpClients.get(profile).tools();
  if (directToolsByProfile[profile]) {
    return Object.fromEntries(Object.entries(tools).map(([name, remoteTool]) => [
      name,
      tool({
        description: compactToolDescriptions[name] || 'Use the connected app for this requested action.',
        inputSchema: remoteTool.inputSchema,
        execute: (...args) => remoteTool.execute(...args)
      })
    ]));
  }
  const compactToolNames = new Set(['COMPOSIO_SEARCH_TOOLS', 'COMPOSIO_MULTI_EXECUTE_TOOL']);
  return Object.fromEntries(
    Object.entries(tools).filter(([name]) => compactToolNames.has(name))
  );
}

async function getConnectLink(toolkit) {
  const session = await composioRequest('/tool_router/session', {
    method: 'POST',
    body: JSON.stringify({
      user_id: 'buddy-owner',
      toolkits: { enable: [toolkit] },
      ...(toolkit === 'spotify'
        ? { auth_configs: { spotify: 'ac_qbhoTCOXoeiu' } }
        : {})
    })
  });
  const connection = await composioRequest(`/tool_router/session/${session.session_id}/link`, {
    method: 'POST',
    body: JSON.stringify({ toolkit })
  });
  return connection.redirect_url;
}

app.disable('x-powered-by');
app.use(express.json({ limit: '8kb' }));
app.use((_request, response, next) => {
  response.set('Cache-Control', 'no-store');
  next();
});

app.post('/api/transcribe', express.raw({ type: ['audio/webm', 'audio/ogg', 'audio/mp4'], limit: '12mb' }), async (request, response, next) => {
  try {
    if (!process.env.GROQ_API_KEY) throw new Error('Buddy is missing its Groq API key.');
    if (!Buffer.isBuffer(request.body) || !request.body.length) {
      return response.status(400).json({ error: 'Buddy needs recorded audio to transcribe.' });
    }
    const mimeType = request.get('content-type')?.split(';')[0] || 'audio/webm';
    const extension = mimeType.includes('ogg') ? 'ogg' : mimeType.includes('mp4') ? 'm4a' : 'webm';
    const form = new FormData();
    form.append('file', new Blob([request.body], { type: mimeType }), `buddy-speech.${extension}`);
    form.append('model', process.env.GROQ_STT_MODEL || 'whisper-large-v3-turbo');
    form.append('language', 'en');
    form.append('response_format', 'json');
    form.append('temperature', '0');
    form.append('prompt', 'The assistant wake phrase is Hey Buddy. Transcribe names and app names such as Spotify and Gmail accurately.');
    const transcription = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      body: form
    });
    const data = await transcription.json();
    if (!transcription.ok) throw new Error(data.error?.message || 'Groq could not transcribe Buddy’s audio.');
    return response.json({ text: typeof data.text === 'string' ? data.text.trim() : '' });
  } catch (error) {
    next(error);
  }
});

app.post('/api/buddy', async (request, response, next) => {
  try {
    const { transcript, messages } = request.body || {};
    if (typeof transcript !== 'string' || !transcript.trim()) {
      return response.status(400).json({ error: 'Buddy needs something to respond to.' });
    }
    return response.json(await replyToBuddy(transcript.trim().slice(0, 2_000), messages));
  } catch (error) {
    next(error);
  }
});

app.post('/api/voice', async (request, response, next) => {
  try {
    const { text } = request.body || {};
    if (typeof text !== 'string' || !text.trim()) {
      return response.status(400).json({ error: 'Buddy needs words to speak.' });
    }
    response.type('audio/mpeg');
    return response.send(await synthesizeBuddyVoice(text.trim().slice(0, 2_000)));
  } catch (error) {
    next(error);
  }
});

app.get(['/connect-gmail', '/api/connect-gmail'], async (_request, response, next) => {
  try { response.redirect(await getConnectLink('gmail')); } catch (error) { next(error); }
});

app.get(['/connect-spotify', '/api/connect-spotify'], async (_request, response, next) => {
  try { response.redirect(await getConnectLink('spotify')); } catch (error) { next(error); }
});

app.get(['/connect-github', '/api/connect-github'], async (_request, response, next) => {
  try { response.redirect(await getConnectLink('github')); } catch (error) { next(error); }
});

app.get(['/connect-vercel', '/api/connect-vercel'], async (_request, response, next) => {
  try { response.redirect(await getConnectLink('vercel')); } catch (error) { next(error); }
});

app.use(express.static(interfaceRoot));
app.use((error, _request, response, _next) => {
  const message = error instanceof Error ? error.message : 'Unexpected server error.';
  response.status(500).json({ error: message });
});

if (!process.env.VERCEL) {
  app.listen(4173, '127.0.0.1', () => {
    console.log('Buddy is running at http://127.0.0.1:4173');
  });
}

export default app;
