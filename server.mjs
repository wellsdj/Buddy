import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import express from 'express';
import { generateText, stepCountIs, tool } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createMCPClient } from '@ai-sdk/mcp';
import { z } from 'zod';

const root = path.dirname(fileURLToPath(import.meta.url));
const interfaceRoot = path.join(root, 'body');
if (!process.env.VERCEL) dotenv.config({ path: process.env.BUDDY_LOCAL_ENV_FILE || '.env.local' });
const app = express();
const anthropic = createAnthropic();
const runFile = promisify(execFile);
let composioSession;
let composioMcpClient;
let pendingMessage;
let buddyRequestId = 0;
const mockReplies = [
  'The room feels like it is waiting for a good idea.',
  'A tiny note from tomorrow: you are closer than you think.',
  'I would put the kettle on, if I had hands.',
  'The quietest things are often doing the most work.',
  'I have filed that thought under: worth keeping.'
];
async function replyToBuddy(transcript) {
  if (process.env.BUDDY_AI_ENABLED !== 'true') {
    return { message: mockReplies[Math.floor(Math.random() * mockReplies.length)], mode: 'mock' };
  }
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('Buddy is missing its Claude API key.');

  const requestId = ++buddyRequestId;
  const composioTools = await getBuddyTools();
  const messagesTools = process.platform === 'darwin' && !process.env.VERCEL
    ? getMessagesTools(requestId)
    : {};
  const tools = { ...composioTools, ...messagesTools };
  const result = await generateText({
    model: anthropic(process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001'),
    system: `You are Buddy, a warm, concise desk companion with Gmail, Spotify, GitHub, and Vercel tools${Object.keys(messagesTools).length ? ', plus local Apple Messages tools' : ''}.
Use tools only when the user asks for an action or current account information.
When tools are needed, call COMPOSIO_SEARCH_TOOLS immediately without a spoken preamble,
then execute the selected tool and report only the confirmed result.
Never claim an action succeeded unless its tool result confirms it.
For email, create a draft by default; only send when the user clearly says to send.
For GitHub, treat access as read-only: you may inspect repositories, files, commits, issues, pull requests, reviews, and comments, but never create, edit, merge, close, delete, or dispatch anything.
For Vercel, treat access as read-only: you may inspect projects, deployments, domains, status, and logs, but never create, deploy, promote, redeploy, assign aliases, add or edit domains, change environment variables or settings, buy anything, or delete anything.
For Apple Messages, always call PREPARE_MESSAGES_TEXT first and read the draft back.
Never call SEND_PREPARED_MESSAGES_TEXT in the same request that prepared it.
Only send a prepared message after the user separately says "send it" or clearly confirms sending.
Reply in one or two short spoken sentences.`,
    prompt: transcript,
    maxOutputTokens: 800,
    tools,
    stopWhen: stepCountIs(6),
  });
  return { message: result.text.trim(), mode: 'claude' };
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

async function getBuddyComposioSession() {
  if (composioSession) return composioSession;
  const vercelAccountId = await getLatestActiveConnectedAccountId('vercel');
  composioSession = await composioRequest('/tool_router/session', {
    method: 'POST',
    body: JSON.stringify({
      user_id: 'buddy-owner',
      toolkits: { enable: ['gmail', 'spotify', 'github', 'vercel'] },
      auth_configs: { spotify: 'ac_qbhoTCOXoeiu' },
      ...(vercelAccountId
        ? { connected_accounts: { vercel: [vercelAccountId] } }
        : {})
    })
  });
  return composioSession;
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

async function getBuddyTools() {
  const session = await getBuddyComposioSession();
  if (!composioMcpClient) {
    composioMcpClient = await createMCPClient({
      transport: {
        type: 'http',
        url: session.mcp.url,
        headers: { 'x-api-key': process.env.COMPOSIO_API_KEY }
      }
    });
  }
  const tools = await composioMcpClient.tools();
  return Object.fromEntries(
    Object.entries(tools).filter(([name]) => !name.includes('REMOTE_'))
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

app.post('/api/buddy', async (request, response, next) => {
  try {
    const { transcript } = request.body || {};
    if (typeof transcript !== 'string' || !transcript.trim()) {
      return response.status(400).json({ error: 'Buddy needs something to respond to.' });
    }
    return response.json(await replyToBuddy(transcript.trim().slice(0, 2_000)));
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
