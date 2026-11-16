import { ArrowUpRight } from 'lucide-react';
import { NavLink } from 'react-router-dom';
import type { Principal } from '../api/types';
import './report-navigation.css';

const reports = [
  {
    path: 'order-transactions',
    title: 'Order transactions',
    description: 'Sales, returns, taxes and payment allocations.',
  },
  {
    path: 'returned-orders',
    title: 'Returned orders',
    description: 'Returned items and refund activity.',
  },
  {
    path: 'flash-sales',
    title: 'Flash sales',
    description: 'Daily sales and payment totals by store.',
  },
  {
    path: 'hyperlocal-daily',
    title: 'Hyperlocal daily report',
    description: 'Order allocation, packing and delivery.',
  },
  {
    path: 'day-close-history',
    title: 'Day close history',
    description: 'Filed closes and reconciliation.',
  },
  {
    path: 'customer-feedback',
    title: 'Customer feedback',
    description: 'Customer ratings and responses.',
  },
  {
    path: 'exports',
    title: 'Export history',
    description: 'Download completed reports and review progress.',
  },
  {
    path: 'hyperlocal-acceptance',
    title: 'Hyperlocal acceptance',
    description: 'Store acceptance and fulfillment timing.',
    roles: [1],
  },
  {
    path: 'salesperson-performance',
    title: 'Salesperson performance',
    description: 'Sales and membership conversion.',
    roles: [1],
  },
  {
    path: 'cashier-performance',
    title: 'Cashier performance',
    description: 'Counter activity and operator totals.',
    roles: [1],
  },
];
export function ReportNavigation({ user }: { user: Principal }) {
  return (
    <nav className="report-navigation" aria-label="Other reports">
      {reports
        .filter((report) => !report.roles || report.roles.includes(user.role))
        .map((report) => (
          <NavLink key={report.path} to={'/reports/' + report.path}>
            <span>
              <strong>{report.title}</strong>
              <small>{report.description}</small>
            </span>
            <ArrowUpRight size={17} aria-hidden="true" />
          </NavLink>
        ))}
    </nav>
  );
}
