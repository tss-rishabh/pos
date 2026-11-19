import { useCallback, useEffect, useRef } from 'react';

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

/**
 * Legacy plays a notification sound when a store notification arrives
 * (users/templates/admin/layouts/base.html: `audiotag.play().catch(…)`), with no setting. W27
 * removed the rewrite's "Sound on" toggle and its stored preference: the chime is armed by the
 * operator's first interaction (browsers and Electron only start audio after a user gesture)
 * and plays only for a newly arrived notification.
 */
export function useNotificationSound() {
  const audio = useRef<AudioContext | null>(null);
  const lastPlayed = useRef(Number.NEGATIVE_INFINITY);
  useEffect(() => {
    if (typeof window.AudioContext !== 'function') return;
    const arm = () => {
      try {
        const current = audio.current ?? new AudioContext();
        audio.current = current;
        void current.resume().catch(() => {});
      } catch {
        audio.current = null;
      }
    };
    window.addEventListener('pointerdown', arm, { once: true, capture: true });
    window.addEventListener('keydown', arm, { once: true, capture: true });
    return () => {
      window.removeEventListener('pointerdown', arm, { capture: true });
      window.removeEventListener('keydown', arm, { capture: true });
      const current = audio.current;
      audio.current = null;
      if (current && current.state !== 'closed') void current.close().catch(() => {});
    };
  }, []);
  const play = useCallback(() => {
    const current = audio.current;
    if (!current || current.state !== 'running') return;
    const now = performance.now();
    if (now - lastPlayed.current < 800) return;
    try {
      chime(current);
      lastPlayed.current = now;
    } catch {
      // A failed chime never blocks the notification itself.
    }
  }, []);
  return { play };
}
