export type PtyHostSpawnRequest = {
  id: string;
  command: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  env: Record<string, string>;
};

export type PtyHostRequest =
  | { requestId: string; type: "spawn"; payload: PtyHostSpawnRequest }
  | { requestId: string; type: "write"; id: string; data: string }
  | { requestId: string; type: "resize"; id: string; cols: number; rows: number }
  | { requestId: string; type: "kill"; id: string }
  | { requestId: string; type: "shutdown" };

export type PtyHostResponse =
  | { requestId: string; ok: true; pid?: number | null }
  | { requestId: string; ok: false; error: string };

export type PtyHostEvent =
  | { type: "data"; id: string; data: string }
  | { type: "exit"; id: string; exitCode: number | null }
  | { type: "error"; id: string | null; error: string };

export type PtyHostMessage = PtyHostResponse | PtyHostEvent;
