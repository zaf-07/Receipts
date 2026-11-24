import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { Snapshot } from '../../shared/types';

export async function call<T = unknown>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    // Non-JSON response. Handled below through res.ok.
  }
  if (!res.ok) {
    const message = (json as { error?: string } | null)?.error;
    throw new Error(message ?? `The server answered with HTTP ${res.status}.`);
  }
  return json as T;
}

/** The whole app state in one payload, refetched whenever the server says something changed. */
export function useSnapshot() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [offline, setOffline] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  const refresh = useCallback(async () => {
    try {
      setSnap(await call<Snapshot>('/snapshot'));
      setOffline(false);
    } catch {
      setOffline(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const schedule = () => {
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void refresh(), 120);
    };
    const events = new EventSource('/api/events');
    events.onmessage = schedule;
    events.onerror = () => setOffline(true);
    events.onopen = schedule;
    const poll = window.setInterval(() => void refresh(), 20_000);
    return () => {
      events.close();
      window.clearInterval(poll);
      window.clearTimeout(timer.current);
    };
  }, [refresh]);

  return { snap, offline, refresh };
}

export interface Ui {
  snap: Snapshot;
  /** Run a server action. Failures surface as a notice instead of being swallowed. */
  act: (path: string, body?: unknown) => Promise<boolean>;
  openLead: (id: string) => void;
  /** Show a task run on the team screen. */
  openTask: (id: string) => void;
  taskId: string | null;
  /** Start the guided demo, which resets the data and plays the whole script. */
  startTour: () => void;
  go: (view: string) => void;
  reviewer: string;
}

export const UiContext = createContext<Ui | null>(null);

export function useUi(): Ui {
  const ui = useContext(UiContext);
  if (!ui) throw new Error('UiContext is missing');
  return ui;
}
