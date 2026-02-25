import type { PtcSession, PtcTool } from "./types.ts";

export class SessionStore {
  private sessions = new Map<string, PtcSession>();

  create(sessionId: string, runtimeTools: PtcTool[]): PtcSession {
    const session: PtcSession = {
      id: sessionId,
      runtimeTools,
      createdAt: Date.now(),
    };
    this.sessions.set(sessionId, session);
    return session;
  }

  get(sessionId: string): PtcSession | undefined {
    return this.sessions.get(sessionId);
  }

  delete(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  cleanup(maxAgeMs: number = 5 * 60 * 1000): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.createdAt > maxAgeMs) {
        this.sessions.delete(id);
      }
    }
  }
}

export class CallToSessionMap {
  private map = new Map<string, string>();

  set(callId: string, sessionId: string): void {
    this.map.set(callId, sessionId);
  }

  get(callId: string): string | undefined {
    return this.map.get(callId);
  }

  has(callId: string): boolean {
    return this.map.has(callId);
  }

  delete(callId: string): void {
    this.map.delete(callId);
  }

  clear(): void {
    this.map.clear();
  }
}

export const sessions = new SessionStore();
export const callToSession = new CallToSessionMap();
