import { memo, useEffect, useState } from 'react';

/** Local device time, matching the legacy shell without rerendering the workspace. */
export const RealtimeClock = memo(function RealtimeClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const update = () => setNow(new Date());
    const timer = window.setInterval(update, 1000);
    document.addEventListener('visibilitychange', update);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', update);
    };
  }, []);
  const text = [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map((value) => String(value).padStart(2, '0'))
    .join(':');
  return (
    <div className="sidebar-version">
      <span>Device time</span>
      <time
        className="mono"
        dateTime={now.toISOString()}
        role="timer"
        aria-label="Device time"
        aria-live="off"
      >
        {text}
      </time>
    </div>
  );
});
