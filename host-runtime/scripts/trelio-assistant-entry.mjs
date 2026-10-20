#!/usr/bin/env node
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { isDirectModuleInvocation } from './trelio-local-path.mjs';
import { createAssistantSetup } from './trelio-assistant-setup.mjs';

const UUID = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$';
const enrollment = { type: 'string', pattern: UUID };
const schema = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
export const ASSISTANT_SETUP_TOOLS = Object.freeze([
  { name: 'begin_assistant_setup', description: 'Begin protected computer enrollment using the owner-provided locator. Returns a pairing code for review on the owner device, never credentials.',
    inputSchema: schema({ enrollmentId: enrollment, deviceName: { type: 'string', minLength: 1, maxLength: 120 } }) },
  { name: 'finish_assistant_setup', description: 'Check owner approval and complete the one-use protected exchange. A lost exchange requires a new enrollment; never blindly retry it.',
    inputSchema: schema({ enrollmentId: enrollment }) },
  { name: 'get_assistant_setup_status', description: 'Read local setup state and, for a paired device, verify live server contact. Does not imply task execution or background service readiness.',
    inputSchema: schema({ enrollmentId: enrollment }), annotations: { readOnlyHint: true, idempotentHint: true } },
]);
const codes = new Set(['begin_assistant_setup', 'finish_assistant_setup', 'get_assistant_setup_status']);
const safeError = error => /^(?:ASSISTANT_|DIGITAL_ASSISTANTS_)[A-Z_]{1,100}$/u.test(error?.code ?? '')
  ? error.code : 'ASSISTANT_SETUP_UNAVAILABLE';

export const callAssistantSetupTool = async (setup, name, args) => {
  if (!codes.has(name)) throw Object.assign(new Error(), { code: 'ASSISTANT_CAPABILITY_UNAVAILABLE' });
  const expected = name === 'begin_assistant_setup' ? ['enrollmentId', 'deviceName'] : ['enrollmentId'];
  if (!args || Object.getPrototypeOf(args) !== Object.prototype
    || Object.keys(args).length !== expected.length || Object.keys(args).some(key => !expected.includes(key))
    || typeof args.enrollmentId !== 'string' || !new RegExp(UUID, 'u').test(args.enrollmentId)
    || (name === 'begin_assistant_setup' && (typeof args.deviceName !== 'string'
      || !args.deviceName.trim() || args.deviceName.length > 120 || /[\x00-\x1f\x7f]/u.test(args.deviceName)))) {
    throw Object.assign(new Error(), { code: 'ASSISTANT_SETUP_INVALID_INPUT' });
  }
  if (name === 'begin_assistant_setup') return setup.begin(args.enrollmentId, args.deviceName);
  if (name === 'finish_assistant_setup') return setup.finish(args.enrollmentId);
  return setup.status(args.enrollmentId);
};

/** This profile never imports/starts the human local MCP, reads its OAuth, or
 * migrates Codex configuration. Private primitives are loaded lazily on an
 * actual setup call, not for tools/list or an unsupported command. */
export const createProductionAssistantSetup = async () => {
  const [{ createAssistantPrivateStore }, { createAssistantHttp }, common, { withPrivateProcessSession }, { createAssistantHostState }] = await Promise.all([
    import('./trelio-assistant-private.mjs'), import('./trelio-assistant-transport.mjs'), import('./trelio-workspace.mjs'),
    import('./trelio-hook-private-session.mjs'), import('./trelio-assistant-hook.mjs'),
  ]);
  const origin = 'https://trelio.ru';
  const store = createAssistantPrivateStore({ directory: path.join(common.resolveWorkspaceBridgeConfigDirectory(), 'digital-assistants', 'credentials') });
  const hostState = createAssistantHostState({ directory: path.join(common.resolveWorkspaceBridgeConfigDirectory(), 'digital-assistants'), store });
  const setup = createAssistantSetup({ origin, store, http: createAssistantHttp({ origin }) });
  // As in the common bridge, share one native worker only inside this tool
  // invocation. A long-lived MCP must not retain its ACL results or pipes.
  return Object.fromEntries(Object.entries(setup).map(([name, action]) => [name,
    (...args) => withPrivateProcessSession(async () => {
      const result = await action(...args);
      if (result.state === 'paired') await hostState.saveIdentity({ origin, assistantId: result.assistantId, deviceId: result.deviceId });
      return result;
    })]));
};

/** The host identity is selected by completed protected pairing, never tool
 * arguments or an inherited human thread. Every invocation gets its own native
 * ACL/DPAPI lifetime and the common non-sliding hook clock. */
export const createProductionAssistantHook = async () => {
  const [{ createAssistantPrivateStore }, { createAssistantHttp, createAssistantDeviceClient }, common,
    { createAssistantHostState, createAssistantTaskHook }] = await Promise.all([
    import('./trelio-assistant-private.mjs'), import('./trelio-assistant-transport.mjs'), import('./trelio-workspace.mjs'),
    import('./trelio-assistant-hook.mjs'),
  ]);
  const directory = path.join(common.resolveWorkspaceBridgeConfigDirectory(), 'digital-assistants');
  const store = createAssistantPrivateStore({ directory: path.join(directory, 'credentials') });
  const hostState = createAssistantHostState({ directory, store });
  const identity = await hostState.readIdentity();
  if (!identity) throw Object.assign(new Error(), { code: 'ASSISTANT_HOST_NOT_CONFIGURED' });
  if (identity.origin !== 'https://trelio.ru') throw Object.assign(new Error(), { code: 'ASSISTANT_HOST_STATE_INVALID' });
  const client = createAssistantDeviceClient({ ...identity, store, http: createAssistantHttp({ origin: identity.origin }) });
  return createAssistantTaskHook({ identity, client, store, readActivePass: hostState.readActivePass,
    lockDirectory: path.join(directory, 'runtime-locks') });
};

/** Bounded JSON-lines MCP facade for setup only. No raw incoming body, transport
 * exception or store envelope is returned/logged. Calls are serialized, so two
 * exchanges from this client cannot race its one-use private journal. */
export const runAssistantSetupMcp = async ({ input = process.stdin, output = process.stdout,
  createSetup = createProductionAssistantSetup } = {}) => {
  let setup, initialized = false;
  const reply = value => output.write(JSON.stringify(value) + '\n');
  const dispatch = async message => {
    const requestId = message?.id;
    const hasId = typeof requestId === 'string' && requestId.length <= 128 || Number.isSafeInteger(requestId);
    if (!hasId) return; // Notifications, including cancellation, have no response.
    if (message?.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return reply({ jsonrpc: '2.0', id: requestId, error: { code: -32600, message: 'Invalid request' } });
    }
    const respond = result => reply({ jsonrpc: '2.0', id: requestId, result });
    if (message.method === 'initialize' && !initialized) {
      initialized = true;
      return respond({ protocolVersion: '2025-06-18', capabilities: { tools: {} },
        serverInfo: { name: 'trelio-assistant', version: '1.0.0' },
        instructions: 'This computer uses assistant device pairing, not human OAuth. Setup/contact alone does not authorize task work.' });
    }
    if (message.method === 'ping') return respond({});
    if (!initialized) return reply({ jsonrpc: '2.0', id: requestId, error: { code: -32000, message: 'Initialize first' } });
    if (message.method === 'tools/list') return respond({ tools: ASSISTANT_SETUP_TOOLS });
    if (message.method === 'tools/call') {
      try {
        // Validate before touching private storage. Unknown tools cannot cause
        // an auth read or be delegated to another MCP implementation.
        if (!codes.has(message.params?.name)) throw Object.assign(new Error(), { code: 'ASSISTANT_CAPABILITY_UNAVAILABLE' });
        // The adapter is constructed once but every paired status revalidates
        // the protected slot and live device. It contains no cached authority.
        setup ??= await createSetup();
        const result = await callAssistantSetupTool(setup, message.params.name, message.params.arguments);
        return respond({ content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result });
      } catch (error) {
        const result = { code: safeError(error) };
        return respond({ isError: true, content: [{ type: 'text', text: result.code }], structuredContent: result });
      }
    }
    return reply({ jsonrpc: '2.0', id: requestId, error: { code: -32601, message: 'Method not found' } });
  };
  const decoder = new StringDecoder('utf8');
  let pending = '';
  const consume = async text => {
    pending += text;
    for (;;) {
      const newline = pending.indexOf('\n');
      if (newline < 0) break;
      const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
      if (Buffer.byteLength(line) > 131_072) throw new Error('ASSISTANT_MCP_FRAME_TOO_LARGE');
      let parsed; try { parsed = JSON.parse(line); } catch {
        reply({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); continue;
      }
      await dispatch(parsed);
    }
    if (Buffer.byteLength(pending) > 131_072) throw new Error('ASSISTANT_MCP_FRAME_TOO_LARGE');
  };
  for await (const chunk of input) await consume(typeof chunk === 'string' ? chunk : decoder.write(chunk));
  await consume(decoder.end());
  if (pending.trim()) await consume('\n');
};

export const runAssistantEntry = async (args, options = {}) => {
  if (args.length !== 1 || !['mcp', 'hook'].includes(args[0])) throw new Error('ASSISTANT_COMMAND_UNSUPPORTED');
  if (args[0] === 'mcp') return runAssistantSetupMcp(options);
  let bytes = 0, text = '';
  for await (const chunk of options.input ?? process.stdin) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 131_072) throw new Error('ASSISTANT_MCP_FRAME_TOO_LARGE');
    text += chunk.toString();
  }
  let event; try { event = JSON.parse(text); } catch { throw new Error('ASSISTANT_HOOK_INVALID_INPUT'); }
  const tool = String(event.tool_name ?? '');
  const name = tool.split(/__|[:./-]/u).at(-1);
  const assistantTool = /^(?:mcp__)?trelio[-_]assistant__|^mcp__plugin_trelio-digital-assistant_trelio-assistant__|^(?:mcp[:./-])?trelio-assistant[:./-]/u.test(tool);
  let decision = {};
  if (event.hook_event_name === 'PreToolUse' && assistantTool && !codes.has(name) && name !== 'get_assistant_status') {
    const { withRuntimeHookPrivateSession } = await import('./trelio-hook-private-session.mjs');
    const { resolveRuntimeHookStartedAt, runtimeHookRemainingMilliseconds } = await import('./trelio-runtime-session-limits.mjs');
    try {
      decision = await withRuntimeHookPrivateSession(runtimeHookRemainingMilliseconds(event.hook_event_name,
        { startedAt: resolveRuntimeHookStartedAt() }), async () => {
        const hook = await (options.createHook ?? createProductionAssistantHook)();
        return hook(event, name);
      });
    } catch (error) {
      const suppliedCode = error?.diagnosticCode ?? error?.code;
      const code = /^(?:ASSISTANT_|TRELIO_)[A-Z_]{1,100}$/u.test(suppliedCode ?? '')
        ? suppliedCode : 'ASSISTANT_HOOK_UNAVAILABLE';
      decision = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: code } };
    }
  } else if (event.hook_event_name === 'SessionStart' && event.source === 'compact') {
    const { TRELIO_COMPACTION_RECOVERY_CONTEXT } = await import('./trelio-context-recovery.mjs');
    decision = { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: TRELIO_COMPACTION_RECOVERY_CONTEXT } };
  } else if (event.hook_event_name === 'SessionEnd') {
    const { withRuntimeHookPrivateSession } = await import('./trelio-hook-private-session.mjs');
    const { resolveRuntimeHookStartedAt, runtimeHookRemainingMilliseconds } = await import('./trelio-runtime-session-limits.mjs');
    try { await withRuntimeHookPrivateSession(runtimeHookRemainingMilliseconds('SessionEnd',
      { startedAt: resolveRuntimeHookStartedAt() }), async () => {
      const hook = await (options.createHook ?? createProductionAssistantHook)(); await hook(event);
    }); } catch { /* No grant or retry is issued by a failed end notification. */ }
  }

  (options.output ?? process.stdout).write(JSON.stringify(decision) + '\n');
};

if (isDirectModuleInvocation(import.meta.url)) {
  runAssistantEntry(process.argv.slice(2)).catch(() => {
    if (process.argv[2] === 'hook') {
      // Preserve the common JSON-deny/exit-0 contract across Windows shells.
      // Broken input cannot silently turn a protected hook into permission.
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse',
        permissionDecision: 'deny', permissionDecisionReason: 'ASSISTANT_HOOK_UNAVAILABLE' } }) + '\n');
    } else { process.stderr.write('ASSISTANT_ENTRY_UNAVAILABLE\n'); process.exitCode = 1; }
  });
}
