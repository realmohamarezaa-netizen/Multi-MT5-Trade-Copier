"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface UsePollingResult<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  refresh: () => void;
}

/**
 * Resilient polling hook.
 * - fetches `url` immediately and then every `intervalMs`
 * - keeps the last successful payload on error (error is only surfaced, data stays)
 * - aborts in-flight requests on unmount / url change / disable
 * - `refresh()` forces an immediate re-fetch
 */
export function usePolling<T>(
  url: string,
  intervalMs: number,
  enabled = true
): UsePollingResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(enabled);
  const hasDataRef = useRef(false);
  const controllerRef = useRef<AbortController | null>(null);

  const fetchNow = useCallback(async () => {
    if (!enabled || !url) return;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    try {
      const res = await fetch(url, { signal: controller.signal, cache: "no-store" });
      if (!res.ok) {
        let message = `خطای سرور (${res.status})`;
        try {
          const body = (await res.json()) as { error?: unknown };
          if (body && typeof body.error === "string") message = body.error;
        } catch {
          /* ignore parse errors */
        }
        throw new Error(message);
      }
      const json = (await res.json()) as T;
      if (controller.signal.aborted) return;
      hasDataRef.current = true;
      setData(json);
      setError(null);
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [url, enabled]);

  useEffect(() => {
    if (!enabled || !url) {
      setLoading(false);
      return;
    }
    if (!hasDataRef.current) setLoading(true);
    fetchNow();
    const id = setInterval(fetchNow, intervalMs);
    return () => {
      clearInterval(id);
      controllerRef.current?.abort();
    };
  }, [fetchNow, intervalMs, enabled, url]);

  const refresh = useCallback(() => {
    fetchNow();
  }, [fetchNow]);

  return { data, error, loading, refresh };
}
