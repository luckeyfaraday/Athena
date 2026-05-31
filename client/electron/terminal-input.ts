type TerminalInputTargetBody = {
  terminal_id?: string;
  terminalId?: string;
  session_id?: string;
  sessionId?: string;
  target?: string;
  data?: string;
};

export function rawInputPreview(data: string): string {
  return `<raw PTY input: ${Buffer.byteLength(data, "utf8")} bytes>`;
}

export function parseRawTerminalInputRequest(body: unknown): { target: string; data: string } {
  const target = targetFromBody(body);
  if (!target) throw new Error("terminal_id, session_id, or target is required.");
  const request = body as TerminalInputTargetBody;
  const data = typeof request.data === "string" && request.data.length ? request.data : undefined;
  if (!data) throw new Error("data is required.");
  return { target, data };
}

function targetFromBody(body: unknown): string | undefined {
  if (!body || typeof body !== "object") throw new Error("Request body must be an object.");
  const request = body as TerminalInputTargetBody;
  return stringValue(request.target)
    ?? stringValue(request.terminal_id)
    ?? stringValue(request.terminalId)
    ?? stringValue(request.session_id)
    ?? stringValue(request.sessionId);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
