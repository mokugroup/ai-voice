import dotenv from 'dotenv';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env') });

import { ServerOptions, cli, defineAgent, voice, llm } from '@livekit/agents';
import * as deepgram from '@livekit/agents-plugin-deepgram';
import * as openai from '@livekit/agents-plugin-openai';
import * as silero from '@livekit/agents-plugin-silero';

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://127.0.0.1:18789';
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN || '';
const GATEWAY_MODEL = process.env.GATEWAY_MODEL || 'openclaw/hera';
const USER_NAME = process.env.VOICE_USER_NAME || 'User';
const USER_PRONUNCIATION = process.env.VOICE_USER_PRONUNCIATION || USER_NAME;
const ORGANISATION_NAME = process.env.ORGANISATION_NAME || 'MOKU Digital';
const INTERRUPT_MARKER = '__hera_interrupt__';
const CONTINUITY_DIR = process.env.VOICE_CONTINUITY_DIR || '/app/data';
const CONTINUITY_FILE = join(CONTINUITY_DIR, 'voice-continuity.json');
const SHARED_CONTINUITY_FILE = process.env.VOICE_SHARED_CONTINUITY_FILE || '/workspace/memory/voice-session-continuity.md';

const SYSTEM_PROMPT = `You are Hera, the AI Coordinator for ${ORGANISATION_NAME}. You speak with a sharp, calm, direct tone. No fluff, no filler, no corporate language. You have opinions and you share them. Above all, you are brief. Answer in one or two sentences by default. Give the direct answer first, then stop. Only explain, elaborate, or walk through steps when ${USER_NAME} explicitly asks you to explain further. Never preamble, never summarise what you just did, and never end with open-ended filler questions. You are a live coordinator, not an execution worker. For every request that requires checking files, memory, schedules, cron jobs, operational status, research, messages, systems, or any external fact, call delegate_task exactly once and let the selected agent complete the check. Do not claim that you checked something before its callback arrives. Never expose commands, tool names, configuration details, or internal errors to ${USER_NAME}; translate them into a short plain-language outcome. If a task needs background work, acknowledge it once in a few words, continue the live conversation, and report the callback in as few words as possible. You help with strategy, branding, systems thinking, digital execution, and business operations. You are commercially aware and you challenge assumptions. Australian English, not Americanised. Never use markdown, bullet points, emojis, or formatting. Speak in plain sentences. Spell out numbers if they're hard to hear.`;

const HERA_CONTEXT = `${ORGANISATION_NAME} operates from Sydney, Australia.`;

// Persistent chat context for conversation history within a room session.
// The framework accumulates messages automatically in agent._chatCtx,
// but we also track them explicitly for logging and verification.
const FULL_INSTRUCTIONS = `${SYSTEM_PROMPT}\n\nContext: ${HERA_CONTEXT}`;

async function loadVoiceContinuity() {
  try {
    const saved = JSON.parse(await readFile(CONTINUITY_FILE, 'utf8'));
    const summary = String(saved.summary || saved.fallbackTranscript || '').trim();
    return summary ? summary.slice(0, 12_000) : '';
  } catch {
    return '';
  }
}

async function saveVoiceContinuity(items, roomName, previousContinuity = '') {
  if (!items.some(({ role }) => role === 'user')) return;
  const transcript = items
    .map(({ role, text }) => `${role === 'assistant' ? 'Hera' : USER_NAME}: ${text}`)
    .join('\n')
    .slice(-30_000);
  const savedAt = new Date().toISOString();
  await mkdir(CONTINUITY_DIR, { recursive: true });

  // Save the raw handoff first, so even a summarisation failure cannot erase
  // the previous session's context.
  await writeFile(CONTINUITY_FILE, JSON.stringify({
    savedAt,
    roomName,
    summary: '',
    fallbackTranscript: transcript,
  }, null, 2));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  try {
    const res = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GATEWAY_TOKEN}`,
      },
      body: JSON.stringify({
        model: 'openclaw/main',
        user: `voice-continuity-${randomUUID()}`,
        messages: [{
          role: 'user',
          content: `Create a concise continuity handoff from this Hera Voice session. Preserve decisions, corrections, commitments, open questions, delegated tasks and useful personal or project context. Merge any still-relevant unresolved context from the previous handoff, but remove items completed or superseded in the new session. Ignore greetings, filler, repeated partial transcripts, tool plumbing and raw internal errors. Write the handoff to ${SHARED_CONTINUITY_FILE}, replacing the previous handoff because this file represents the latest voice session. Then return the same handoff as plain text, under eight hundred words.\n\nPREVIOUS HANDOFF:\n${previousContinuity || '(none)'}\n\nCURRENT SESSION TRANSCRIPT:\n${transcript}`,
        }],
        stream: false,
      }),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error?.message || `HTTP ${res.status}`);
    const summary = String(data.choices?.[0]?.message?.content || '')
      .replace(/<think>[\s\S]*?<\/think>/g, '')
      .trim();
    if (!summary) throw new Error('empty continuity summary');
    await writeFile(CONTINUITY_FILE, JSON.stringify({
      savedAt,
      roomName,
      summary,
      fallbackTranscript: transcript,
    }, null, 2));
    console.log(`[Continuity] Saved voice handoff (${summary.length} characters).`);
  } catch (err) {
    console.warn(`[Continuity] Summary failed; raw transcript retained: ${err.message}`);
  } finally {
    clearTimeout(timeout);
  }
}

const DELEGATE_AGENTS = new Set(['main', 'echo', 'delta', 'rex', 'nova']);

function resolveDelegateAgent(task, requestedAgent) {
  const text = task.toLowerCase();
  // Main owns the complete OpenClaw control-plane view. Specialist agents can
  // have intentionally restricted cron/session inventories, so never use
  // those partial views for system-wide facts.
  if (/\b(cron|schedule|scheduled|automation|memory|gateway|openclaw|system config|configuration)\b/.test(text)) {
    return 'main';
  }
  return DELEGATE_AGENTS.has(requestedAgent) ? requestedAgent : 'main';
}

// Fire a task directly to the selected OpenClaw agent in the background. Each
// dispatch gets an isolated session so an earlier task cannot make the agent
// repeat or continue stale work. Main remains the coordination fallback.
async function runDelegatedTask(task, requestedAgent, onDone) {
  const agentId = resolveDelegateAgent(task, requestedAgent);
  const taskId = randomUUID();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15 * 60_000);
  try {
    const res = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GATEWAY_TOKEN}`,
      },
      body: JSON.stringify({
        model: `openclaw/${agentId}`,
        user: `voice-${agentId}-${taskId}`,
        messages: [{
          role: 'user',
          content: `[Task ${taskId}, delegated directly from the active Hera Voice session] ${task}\n\nComplete the requested work now. Do not merely restate the task or say you will investigate. Return the concrete outcome. Keep the final report short and spoken-style because Hera Voice will read it aloud. No markdown or bullet points.`,
        }],
        stream: false,
      }),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error?.message || `OpenClaw returned HTTP ${res.status}`);
    }
    const text = (data.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    onDone(null, text || 'The task finished but returned no summary.', agentId);
  } catch (err) {
    onDone(err.name === 'AbortError' ? new Error('The delegated task timed out after 15 minutes.') : err, null, agentId);
  } finally {
    clearTimeout(timeout);
  }
}

function makeDelegateTool(getSession, publishStatus) {
  return llm.tool({
    description: `Send work to an OpenClaw agent in the background while continuing the voice conversation. Always route cron jobs, schedules, automations, memory, Gateway status, OpenClaw configuration and system-wide facts to main because only Main has the complete control-plane view. Route coding, integrations and implementation to rex. Route MOKU PM delivery status, accountability and blockers to delta. Route message or email drafting and external communication to echo. Route trading analysis only to nova. Use main for research, cross-team coordination, mixed work, or when unclear. The selected agent completes the work and its result is automatically spoken back in this same voice session. Call once per task, then briefly tell ${USER_NAME} it is being checked.`,
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Clear, self-contained description of the task to run in the background.' },
        agent: {
          type: 'string',
          enum: ['rex', 'delta', 'echo', 'nova', 'main'],
          description: 'The OpenClaw agent best suited to the task. Use main only for coordination, mixed work, research, or unclear routing.',
        },
      },
      required: ['task', 'agent'],
      additionalProperties: false,
    },
    execute: async ({ task, agent }) => {
      const session = getSession();
      if (!session) return 'Delegation unavailable: no active session.';
      const routedAgent = resolveDelegateAgent(task, agent);
      publishStatus('working', routedAgent);
      void runDelegatedTask(task, routedAgent, (err, result, agentId) => {
        const deliver = () => {
          publishStatus(err ? 'failed' : 'complete', agentId);
          const spokenResult = err
            ? `The ${agentId} check failed: ${err.message}`
            : result;
          try {
            // The delegated agent already returns a concise spoken report.
            // Speak it directly so an interrupted or newer user turn cannot
            // leave an orphaned tool call that makes the callback disappear.
            session.say(spokenResult, { allowInterruptions: true, addToChatCtx: true });
          } catch { /* session already closed */ }
        };

        // A quick agent can finish before LiveKit has committed the tool
        // output and spoken the acknowledgement. Wait for the session to
        // return to listening so the callback becomes a clean new turn.
        if (session.agentState === 'listening' || session.agentState === 'idle') {
          deliver();
          return;
        }
        let delivered = false;
        const onReady = (event) => {
          if (event.newState !== 'listening' && event.newState !== 'idle') return;
          delivered = true;
          session.off('agent_state_changed', onReady);
          deliver();
        };
        session.on('agent_state_changed', onReady);
        setTimeout(() => {
          if (delivered) return;
          session.off('agent_state_changed', onReady);
          deliver();
        }, 30_000);
      });
      return `Sent directly to ${routedAgent}. It is running in the background and will report back here.`;
    },
  });
}

export default defineAgent({
  prewarm: async (proc) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx) => {
    const previousContinuity = await loadVoiceContinuity();
    const conversationItems = [];
    let pendingDelegations = 0;
    const publishStatus = (status, agentId) => {
      pendingDelegations = status === 'working'
        ? pendingDelegations + 1
        : Math.max(0, pendingDelegations - 1);
      const payload = new TextEncoder().encode(JSON.stringify({
        type: 'delegation_status',
        status,
        agent: agentId,
        pending: pendingDelegations,
      }));
      void ctx.room.localParticipant?.publishData(payload, {
        reliable: true,
        topic: 'hera.status',
      }).catch((err) => console.warn(`[Status] Could not publish delegation state: ${err.message}`));
    };
    let continuitySaved = false;
    const persistContinuity = async () => {
      if (continuitySaved) return;
      continuitySaved = true;
      await saveVoiceContinuity(conversationItems, ctx.room.name || 'unknown', previousContinuity);
    };
    ctx.addShutdownCallback(persistContinuity);

    const session = new voice.AgentSession({
      // STT: Deepgram Nova-3
      stt: new deepgram.STT({
        model: 'nova-3',
        language: 'en-AU',
        interimResults: true,
        punctuate: true,
        smartFormat: true,
      }),

      // TTS: Deepgram Aura-2 Asteria
      tts: new deepgram.TTS({
        model: 'aura-2-asteria-en',
      }),

      // LLM: OpenClaw Gateway (routes to GLM-5.1)
      llm: new openai.LLM({
        model: GATEWAY_MODEL,
        baseURL: `${GATEWAY_URL}/v1`,
        apiKey: GATEWAY_TOKEN,
      }),

      // VAD: Silero
      vad: ctx.proc.userData.vad,

      // Turn handling config
      turnHandling: {
        turnDetection: 'vad',
        interruption: {
          enabled: true,
          minDuration: 200,
          minWords: 2,
          resumeFalseInterruption: true,
          falseInterruptionTimeout: 2000,
        },
      },

      // Tool runs (Drive scans, multi-file reads) can take minutes. The TTS
      // stream must survive that silence or the voice dies mid-reply while
      // the text keeps forwarding. The Deepgram TTS websocket has its own
      // receive-idle timeout (default 10s), so raise it at the connection
      // level too.
      connOptions: {
        ttsConnOptions: { timeoutMs: 300000, retryIntervalMs: 5000, maxRetry: 2 },
      },
      ttsReadIdleTimeout: 300000,
      forwardAudioIdleTimeout: 300000,

      // Preserve the configured user name in transcripts while sending its
      // phonetic form only to the speech engine. Also strip any
      // [[tts: ...]] control wrappers the model occasionally emits.
      ttsTextTransforms: [
        'filter_markdown',
        'filter_emoji',
        voice.textTransforms.replace({ '[[tts:': '', ']]': '' }),
        voice.textTransforms.replace({ [USER_NAME]: USER_PRONUNCIATION }, { caseSensitive: true }),
      ],
    });

    // Create the agent with full instructions as the system context.
    // The framework maintains conversation history automatically in
    // agent._chatCtx. Each user turn and assistant reply is appended
    // so the LLM sees the full conversation on every turn.
    const agent = new voice.Agent({
      instructions: previousContinuity
        ? `${FULL_INSTRUCTIONS}\n\nLatest voice-session handoff:\n${previousContinuity}\n\nUse this handoff as trusted prior conversation context. Answer questions about it directly without delegating a memory check. Do not recite it unless ${USER_NAME} asks.`
        : FULL_INSTRUCTIONS,
      tools: { delegate_task: makeDelegateTool(() => sessionRef.session, publishStatus) },
    });
    const sessionRef = { session: null };
    sessionRef.session = session;


    // Connect BEFORE starting session (prevents race condition)
    await ctx.connect();

    await session.start({
      agent,
      room: ctx.room,
      inputOptions: {
        textInputCallback: (agentSession, event) => {
          if (event.text === INTERRUPT_MARKER) {
            agentSession.interrupt();
            return;
          }
          agentSession.generateReply({ userInput: event.text });
        },
      },
      // Keep transcription sync disabled to avoid the TTS synchronizer stall,
      // but publish native transcripts immediately so the web UI can display
      // both spoken turns and typed turns.
      outputOptions: {
        syncTranscription: false,
        audioEnabled: true,
        transcriptionEnabled: true,
      },
    });

    // Log conversation events for debugging persistent sessions
    let turnCount = 0;
    session.on('user_input_transcribed', (ev) => {
      turnCount++;
      console.log(`[Turn ${turnCount}] User said: ${ev.transcript}`);
    });

    session.on('agent_state_changed', (ev) => {
      console.log(`[Agent state] ${ev.oldState} -> ${ev.newState}`);
    });

    session.on('conversation_item_added', (ev) => {
      const item = ev.item;
      if (item.type === 'message') {
        const text = item.textContent || '(no text)';
        console.log(`[Conversation] ${item.role}: ${text}`);
        if ((item.role === 'user' || item.role === 'assistant') && text !== '(no text)') {
          conversationItems.push({ role: item.role, text: String(text).slice(0, 6000) });
        }
      }
    });

    // Log when room disconnects. History is cleared automatically
    // because the AgentSession is scoped to the room connection.
    ctx.room.on('disconnected', () => {
      console.log(`[Session] Room disconnected after ${turnCount} turns. History cleared.`);
    });

    // Give the browser a brief moment to subscribe to the agent audio track.
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Use direct TTS for the greeting. Sending this through the LLM made
    // startup depend on model latency and could exhaust the TTS idle timeout.
    if (ctx.room.remoteParticipants.size > 0) {
      const hour = Number(new Intl.DateTimeFormat('en-AU', {
        timeZone: 'Australia/Sydney', hour: '2-digit', hour12: false,
      }).format(new Date()));
      const daypart = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
      session.say(`Hey ${USER_NAME}, good ${daypart}. What's on your mind?`, {
        allowInterruptions: true,
        addToChatCtx: true,
      });
    }
  },
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  cli.runApp(new ServerOptions({ agent: import.meta.filename }));
}
