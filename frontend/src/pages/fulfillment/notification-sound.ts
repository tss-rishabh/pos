import { useCallback, useEffect, useRef, useState } from 'react';

const preferenceEvent = 'pos-notification-sound-preference';
const preferenceKey = (operatorId: string, storeId: string) =>
  `pos-notification-sound:${operatorId}:${storeId}`;

function readPreference(key: string): boolean {
  try {
    return localStorage.getItem(key) !== 'off';
  } catch {
    return true;
  }
}

function chime(context: AudioContext) {
  const start = context.currentTime;
  for (const [delay, frequency] of [
    [0, 740],
    [0.15, 988],
  ] as const) {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0, start + delay);
    gain.gain.linearRampToValueAtTime(0.12, start + delay + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.001, start + delay + 0.16);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.onended = () => {
      oscillator.disconnect();
      gain.disconnect();
    };
    oscillator.start(start + delay);
    oscillator.stop(start + delay + 0.18);
  }
}

/** Browser AudioContext works in web and Electron without exposing native APIs. */
export function useNotificationSound(operatorId: string, storeId: string) {
  const key = preferenceKey(operatorId, storeId);
  const [choice, setChoice] = useState(() => ({ key, enabled: readPreference(key) }));
  const [ready, setReady] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const audio = useRef<AudioContext | null>(null);
  const lastPlayed = useRef(Number.NEGATIVE_INFINITY);
  const enabled = choice.key === key ? choice.enabled : readPreference(key);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const close = useCallback(() => {
    const previous = audio.current;
    audio.current = null;
    setReady(false);
    if (previous && previous.state !== 'closed') void previous.close().catch(() => {});
  }, []);

  useEffect(() => {
    setChoice({ key, enabled: readPreference(key) });
    setUnavailable(typeof window.AudioContext !== 'function');
    const apply = (value: boolean) => {
      setChoice({ key, enabled: value });
      if (!value) close();
    };
    const update = (event: Event) => {
      const detail: unknown = event instanceof CustomEvent ? event.detail : null;
      if (
        typeof detail !== 'object' ||
        detail === null ||
        !('key' in detail) ||
        !('enabled' in detail)
      )
        return;
      if (detail.key === key && typeof detail.enabled === 'boolean') apply(detail.enabled);
    };
    const storage = (event: StorageEvent) => {
      if (event.key === key || event.key === null) apply(readPreference(key));
    };
    window.addEventListener('storage', storage);
    window.addEventListener(preferenceEvent, update);
    return () => {
      window.removeEventListener('storage', storage);
      window.removeEventListener(preferenceEvent, update);
      close();
    };
  }, [close, key]);

  useEffect(() => {
    if (!enabled || !operatorId || !storeId || typeof window.AudioContext !== 'function') return;
    let current: AudioContext;
    try {
      current = audio.current ?? new AudioContext();
      audio.current = current;
      current.onstatechange = () => {
        if (audio.current === current) setReady(current.state === 'running');
      };
      // Existing browser/Electron autoplay permission can restore an enabled
      // preference. Otherwise this remains suspended until Enable sound is used.
      void current
        .resume()
        .then(() => {
          if (audio.current === current) setReady(current.state === 'running');
        })
        .catch(() => {
          if (audio.current === current) setReady(false);
        });
    } catch {
      setReady(false);
      return;
    }
    return () => {
      current.onstatechange = null;
    };
  }, [enabled, key, operatorId, storeId]);

  const remember = useCallback(
    (value: boolean) => {
      setChoice({ key, enabled: value });
      enabledRef.current = value;
      try {
        localStorage.setItem(key, value ? 'on' : 'off');
      } catch {
        // Honor the current view's choice even if browser storage is unavailable.
      }
      window.dispatchEvent(new CustomEvent(preferenceEvent, { detail: { key, enabled: value } }));
    },
    [key],
  );

  const enable = useCallback(async () => {
    remember(true);
    if (typeof window.AudioContext !== 'function') {
      setUnavailable(true);
      return;
    }
    try {
      // Both construction and resume start synchronously inside the user gesture.
      const current = audio.current ?? new AudioContext();
      audio.current = current;
      await current.resume();
      if (audio.current !== current || !enabledRef.current) return;
      setReady(current.state === 'running');
      if (current.state === 'running') {
        chime(current);
        lastPlayed.current = performance.now();
      }
    } catch {
      setReady(false);
    }
  }, [remember]);

  const mute = useCallback(() => {
    remember(false);
    close();
  }, [close, remember]);

  const play = useCallback(() => {
    const current = audio.current;
    if (!enabledRef.current || !current || current.state !== 'running') {
      if (current && current.state !== 'running') setReady(false);
      return;
    }
    const now = performance.now();
    if (now - lastPlayed.current < 800) return;
    try {
      chime(current);
      lastPlayed.current = now;
    } catch {
      setReady(false);
    }
  }, []);

  return { enabled, ready, unavailable, enable, mute, play };
}
