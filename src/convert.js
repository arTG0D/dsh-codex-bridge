import { randomUUID } from 'node:crypto';

/**
 * Conversion of one Codex Desktop thread into the seed log of one DSH Session.
 *
 * Codex records a thread as an ordered list of typed items grouped by turn. This
 * module maps the item types that carry model-visible content and tool activity,
 * drops the UI-only ones, and emits the event sequence a DSH Session expects:
 * `turn/start` → `step/start` → `user/message` → `assistant/message` →
 * `tool/call`/`tool/result` → `step/end` → `turn/end`, with contiguous `seq`
 * values and non-decreasing times.
 *
 * Everything here is pure: no filesystem, no services, no clock. The importer
 * validates the result with `Session.create` before anything is written.
 */

/** Provider and model recorded on every imported assistant message. */
export const IMPORTED_MODEL_SOURCE = Object.freeze({ provider: 'codex', model: 'codex' });

/** Longest single diff or tool output kept verbatim; longer content is truncated for the log. */
const MAX_BLOCK_CHARS = 4_000;

/** Thrown when a thread holds nothing the model ever saw, so it becomes no Session. */
export class NoImportableTurnError extends Error {
  constructor(message = 'the thread contains no importable turn') {
    super(message);
    this.name = 'NoImportableTurnError';
  }
}

/**
 * Convert one thread to a seed log.
 * @param {object} input - thread metadata, turns, and items read from the Codex databases.
 * @returns {{ title: string, createdAt: number, events: object[] }}
 */
export function convertThread({ thread, turns, items, maxTitleBytes = 200 }) {
  const title = normalizeTitle(thread.title, maxTitleBytes);
  const orderedItems = [...items].sort((a, b) => a.ordinal - b.ordinal);
  const turnOrder = orderTurns(turns, orderedItems);
  const byTurn = new Map();
  for (const item of orderedItems) {
    const bucket = byTurn.get(item.turnId);
    if (bucket === undefined) byTurn.set(item.turnId, [item]);
    else bucket.push(item);
  }

  const builder = new EventBuilder();
  const createdAt = thread.createdAtMs > 0 ? thread.createdAtMs : firstItemTime(orderedItems);
  builder.startAt(createdAt);

  let turnNumber = 0;
  for (const turn of turnOrder) {
    const turnItems = byTurn.get(turn.turnId) ?? [];
    const built = buildTurn(turnItems);
    if (built === undefined) continue;
    turnNumber += 1;
    builder.turn(built, turnNumber, turn);
    if (turnNumber === 1 && title.length > 0) {
      builder.emit({ type: 'session/title', data: { title, messageSeqs: [], source: { kind: 'user' } } });
    }
  }

  if (turnNumber === 0) {
    throw new NoImportableTurnError();
  }
  return { title, createdAt, events: builder.events };
}

/** One turn's mapping: a user message plus the assistant steps that answered it. */
function buildTurn(items) {
  const userBlocks = [];
  const steps = [];
  let current = emptyStep();
  let afterTool = false;

  const flush = () => {
    if (current.content.length > 0 || current.calls.length > 0) steps.push(current);
    current = emptyStep();
  };

  for (const item of items) {
    switch (item.type) {
      case 'userMessage': {
        for (const block of contentBlocks(item.payload)) {
          if (block.type === 'text') userBlocks.push(block);
        }
        break;
      }
      case 'reasoning': {
        if (afterTool) { flush(); afterTool = false; }
        const text = reasoningText(item.payload);
        if (text.length > 0) current.content.push({ type: 'reasoning', text });
        break;
      }
      case 'agentMessage': {
        if (afterTool) { flush(); afterTool = false; }
        const text = typeof item.payload?.text === 'string' ? item.payload.text : '';
        if (text.length > 0) current.content.push({ type: 'text', text });
        break;
      }
      case 'webSearch':
      case 'mcpToolCall':
      case 'fileChange': {
        const call = toolCallOf(item);
        if (call !== undefined) {
          current.calls.push(call);
          afterTool = true;
        }
        break;
      }
      default:
        // `contextCompaction` and any future UI-only item type carry nothing the
        // model saw as content, so they leave no event behind.
        break;
    }
  }
  flush();

  if (userBlocks.length === 0 && steps.length === 0) return undefined;
  return { userBlocks, steps };
}

/** The user turn's text blocks, tolerating both the array and string shapes Codex has used. */
function contentBlocks(payload) {
  const blocks = [];
  const content = payload?.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block === null || typeof block !== 'object') continue;
      if (block.type === 'text' && typeof block.text === 'string') blocks.push({ type: 'text', text: block.text });
      else if (block.type === 'image') blocks.push({ type: 'text', text: '[image]' });
    }
  } else if (typeof content === 'string' && content.length > 0) {
    blocks.push({ type: 'text', text: content });
  }
  return blocks;
}

/** Reasoning items carry a `summary` array of strings; older builds also carry `content`. */
function reasoningText(payload) {
  const parts = [];
  if (Array.isArray(payload?.summary)) {
    for (const entry of payload.summary) {
      if (typeof entry === 'string' && entry.trim().length > 0) parts.push(entry);
      else if (entry !== null && typeof entry === 'object' && typeof entry.text === 'string') parts.push(entry.text);
    }
  }
  if (Array.isArray(payload?.content)) {
    for (const entry of payload.content) {
      if (entry !== null && typeof entry === 'object' && typeof entry.text === 'string' && entry.text.trim().length > 0) {
        parts.push(entry.text);
      }
    }
  }
  return parts.join('\n\n').trim();
}

/** Map one tool-bearing Codex item to a DSH tool call paired with its recorded result. */
function toolCallOf(item) {
  if (item.type === 'webSearch') {
    const action = item.payload?.action ?? {};
    const url = typeof action.url === 'string' ? action.url : '';
    const query = typeof item.payload?.query === 'string' ? item.payload.query : '';
    if (action.type === 'openPage' && url.length > 0) {
      return buildCall('web_fetch', { url }, textResult(payloadText(item.payload?.results) ?? `Opened ${url} in Codex.`));
    }
    if (query.length > 0) {
      return buildCall('web_search', { query }, textResult(payloadText(item.payload?.results) ?? `Codex searched for: ${query}`));
    }
    return undefined;
  }
  if (item.type === 'mcpToolCall') {
    const server = typeof item.payload?.server === 'string' ? item.payload.server : 'mcp';
    const tool = typeof item.payload?.tool === 'string' ? item.payload.tool : 'call';
    const output = payloadText(item.payload?.result) ?? `Codex MCP call ${server}/${tool} recorded status ${String(item.payload?.status ?? 'unknown')}.`;
    return buildCall(`${server}__${tool}`, item.payload?.arguments ?? {}, textResult(output, item.payload?.status === 'failed'));
  }
  if (item.type === 'fileChange') {
    const changes = Array.isArray(item.payload?.changes) ? item.payload.changes : [];
    const paths = changes.map((change) => String(change?.path ?? '')).filter((path) => path.length > 0);
    const diff = changes.map((change) => String(change?.diff ?? '')).filter((text) => text.length > 0).join('\n');
    const body = diff.length > 0 ? truncate(diff, MAX_BLOCK_CHARS) : paths.join('\n');
    return buildCall('codex_file_change', { paths }, textResult(body));
  }
  return undefined;
}

/** Flatten a recorded tool payload's content blocks into text. */
function payloadText(payload) {
  if (payload === null || payload === undefined) return undefined;
  if (typeof payload === 'string') return payload;
  const content = payload.content;
  if (Array.isArray(content)) {
    const parts = content
      .filter((block) => block !== null && typeof block === 'object' && typeof block.text === 'string')
      .map((block) => block.text);
    if (parts.length > 0) return parts.join('\n');
  }
  if (Array.isArray(payload.sources)) {
    const lines = payload.sources
      .map((source) => (typeof source?.url === 'string' ? `- ${source.title ?? source.url} (${source.url})` : ''))
      .filter((line) => line.length > 0);
    if (lines.length > 0) return lines.join('\n');
  }
  return undefined;
}

function buildCall(name, args, result) {
  return {
    id: randomUUID(),
    name,
    arguments: JSON.stringify(args ?? {}),
    result,
  };
}

function textResult(text, isError = false) {
  return { blocks: [{ type: 'text', text: truncate(text ?? '', MAX_BLOCK_CHARS) }], isError };
}

function emptyStep() {
  return { content: [], calls: [] };
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max)}\n…[truncated ${text.length - max} characters]` : text;
}

function firstItemTime(items) {
  for (const item of items) {
    if (item.createdAtMs > 0) return item.createdAtMs;
  }
  return Date.now();
}

function orderTurns(turns, items) {
  const seen = new Set();
  const ordered = [];
  for (const turn of [...turns].sort((a, b) => a.ordinal - b.ordinal)) {
    if (seen.has(turn.turnId)) continue;
    seen.add(turn.turnId);
    ordered.push(turn);
  }
  for (const item of items) {
    if (seen.has(item.turnId)) continue;
    seen.add(item.turnId);
    ordered.push({ turnId: item.turnId, status: 'completed', error: '', startedAtMs: item.createdAtMs, completedAtMs: 0, ordinal: item.ordinal });
  }
  return ordered;
}

function normalizeTitle(title, maxTitleBytes) {
  const collapsed = String(title ?? '').replace(/\s+/gu, ' ').trim();
  if (collapsed.length === 0) return '';
  const limit = Number.isFinite(maxTitleBytes) ? Math.max(1, Math.trunc(maxTitleBytes)) : 200;
  return collapsed.length > limit ? collapsed.slice(0, limit).trim() : collapsed;
}

/** Accumulates events with contiguous seqs and non-decreasing times. */
class EventBuilder {
  events = [];
  #time = 0;

  startAt(time) {
    this.#time = Math.max(this.#time, Number.isFinite(time) ? Math.trunc(time) : 0);
  }

  at(time) {
    const numeric = Number(time);
    if (Number.isFinite(numeric)) this.#time = Math.max(this.#time, Math.trunc(numeric));
  }

  emit(event, extra) {
    this.events.push({ ...event, ...(extra ?? {}), seq: this.events.length, time: this.#time });
  }

  turn(built, turnNumber, turn) {
    this.at(turn.startedAtMs || 0);
    this.emit({ type: 'turn/start', data: { turn: turnNumber } });

    let stepNumber = 0;
    for (const step of built.steps.length > 0 ? built.steps : [emptyStep()]) {
      stepNumber += 1;
      this.emit({ type: 'step/start', data: { turn: turnNumber, step: stepNumber } });
      if (turnNumber === 1 && stepNumber === 1) {
        // An empty system head holds surface node 0, so a resumed Agent replaces it
        // with the real prompt instead of appending a system message after the history.
        this.emit({
          type: 'system/message',
          data: { turn: turnNumber, step: stepNumber, message: { id: randomUUID(), role: 'system', content: [], source: { kind: 'system-prompt' } } },
          surfaceOp: 'append',
        });
      }
      if (stepNumber === 1) {
        const content = built.userBlocks.length > 0 ? built.userBlocks : [{ type: 'text', text: '' }];
        // `user/message` carries the message itself as `data`; the other message
        // events wrap theirs as `{ turn, step, message }`.
        this.emit({
          type: 'user/message',
          data: { id: randomUUID(), role: 'user', content, source: { kind: 'user' } },
          surfaceOp: 'append',
        });
      }
      if (step.content.length > 0 || step.calls.length > 0) {
        const content = [
          ...step.content,
          ...step.calls.map((call) => ({ type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments })),
        ];
        this.emit({
          type: 'assistant/message',
          data: {
            turn: turnNumber,
            step: stepNumber,
            message: { id: randomUUID(), role: 'assistant', content, source: { kind: 'model', ...IMPORTED_MODEL_SOURCE } },
            stream: [],
          },
          surfaceOp: 'append',
        });
        const callSeqs = step.calls.map((call) => {
          this.emit({ type: 'tool/call', data: { turn: turnNumber, step: stepNumber, callId: call.id, name: call.name, arguments: call.arguments } });
          return this.events.length - 1;
        });
        for (const [index, call] of step.calls.entries()) {
          this.emit(
            {
              type: 'tool/result',
              data: {
                turn: turnNumber,
                step: stepNumber,
                message: {
                  id: randomUUID(),
                  role: 'tool',
                  content: call.result.blocks,
                  isError: call.result.isError,
                  source: { kind: 'tool', callId: call.id },
                  toolCallId: call.id,
                },
              },
              surfaceOp: 'append',
              sourceEventSeqs: [callSeqs[index]],
            },
          );
        }
      }
      this.emit({ type: 'step/end', data: { turn: turnNumber, step: stepNumber } });
    }

    // A turn whose reply was never recorded (the user interrupted, or Codex wrote no
    // answer) must not claim completion: a completed turn without an assistant
    // message is not a shape a live Session produces.
    const completed = (turn.status === 'completed' || turn.status === '') && built.steps.length > 0;
    const failure = completed
      ? { kind: 'completed' }
      : turn.status === 'completed' || turn.status === ''
        ? { kind: 'error', error: { code: 'CODEX_TURN_NO_REPLY', message: 'Codex recorded no assistant reply for this turn.' } }
        : {
            kind: 'error',
            error: {
              code: `CODEX_TURN_${String(turn.status).toUpperCase().replace(/[^A-Z0-9]/gu, '_')}`,
              message: `Codex recorded this turn as ${String(turn.status)}.`,
            },
          };
    this.emit({ type: 'turn/end', data: { turn: turnNumber, reason: failure } });
  }
}
