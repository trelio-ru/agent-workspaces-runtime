/**
 * Opt-in local startup evidence. Only closed phase names and process clocks
 * may cross this boundary: no request ids, arguments, paths or server output.
 * This is stderr diagnostics, never MCP stdout or remote telemetry/admission.
 */
const STAGES = new Set([
  "runtime_entry", "mcp_spawn", "stdio_start", "stdio_ready",
  "initialize_received", "initialize_response",
]);

export const createMcpStartupTrace = ({
  environment = process.env,
  write = (line) => process.stderr.write(line),
  uptime = () => process.uptime(),
  now = () => Date.now(),
} = {}) => (stage) => {
  if (environment.TRELIO_MCP_STARTUP_TRACE !== "1" || !STAGES.has(stage)) return;
  // A full/closed stderr must not change startup, ACL or the protocol result.
  // Uptime starts at this Node process, not at the outer shell. PID/parentPID
  // and wall time let a controlled process trace correlate adjacent processes
  // without pretending that separate clients/chats form one causal chain.
  try {
    write(`${JSON.stringify({
      type: "trelio_mcp_startup", stage, pid: process.pid, parentPid: process.ppid,
      timestampMs: now(), elapsedMs: Math.round(uptime() * 1_000),
    })}\n`);
  } catch { /* Optional evidence never replaces the original operation. */ }
};
