import { useEffect } from 'react';
import { NavLink } from 'react-router-dom';
import { Bell, X } from 'lucide-react';
import type { OrderLinkScope } from '../checkout/order-link';
import type { IncomingNotificationAlert, StoreNotice } from './notification-contracts';
import { notificationDestination } from './notification-links';

function IncomingAlert({
  alert,
  scope,
  dismiss,
  visit,
}: {
  alert: IncomingNotificationAlert;
  scope: OrderLinkScope;
  dismiss: (id: string) => void;
  visit: (notice: StoreNotice) => void;
}) {
  useEffect(() => {
    const timer = setTimeout(() => dismiss(alert.notice.id), 8000);
    return () => clearTimeout(timer);
  }, [alert.notice.id, dismiss]);
  const destination = notificationDestination(alert.notice, scope, alert.isNewOrder);
  return (
    <article className="notification-toast">
      <header>
        <strong>
          <Bell size={15} /> {alert.isNewOrder ? 'New order received' : 'Store notification'}
        </strong>
        <button
          className="icon-button"
          type="button"
          aria-label="Dismiss notification alert"
          onClick={() => dismiss(alert.notice.id)}
        >
          <X size={15} />
        </button>
      </header>
      <p>{alert.notice.title}</p>
      {alert.notice.orderId && <small>Order {alert.notice.orderId}</small>}
      {destination && (
        <NavLink
          to={destination.to}
          state={destination.state}
          onClick={() => {
            visit(alert.notice);
            dismiss(alert.notice.id);
          }}
        >
          {alert.isNewOrder ? 'View order queue' : 'View order'}
        </NavLink>
      )}
    </article>
  );
}

export function IncomingNotificationAlerts({
  alerts,
  scope,
  dismiss,
  visit,
}: {
  alerts: IncomingNotificationAlert[];
  scope: OrderLinkScope;
  dismiss: (id: string) => void;
  visit: (notice: StoreNotice) => void;
}) {
  return (
    <div
      className="notification-toast-stack"
      role="status"
      aria-live="polite"
      aria-label="Incoming notifications"
    >
      {alerts.map((alert) => (
        <IncomingAlert
          key={alert.notice.id}
          alert={alert}
          scope={scope}
          dismiss={dismiss}
          visit={visit}
        />
      ))}
    </div>
  );
}
