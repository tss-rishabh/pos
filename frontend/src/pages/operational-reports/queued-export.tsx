import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowDownToLine } from 'lucide-react';
import type { Principal } from '../../api/types';
import { ErrorState } from '../../components/common';
import { queueReportExport, type ReportExportFilters } from './export-commands';
import './style.css';

/** Legacy server "Export": queue the report task with an optional report name and message. */
export function QueuedExport({
  user,
  disabled,
  filters,
}: {
  user: Principal;
  disabled: boolean;
  filters: () => Omit<ReportExportFilters, 'label' | 'note'>;
}) {
  const client = useQueryClient(),
    [label, setLabel] = useState(''),
    [note, setNote] = useState(''),
    queue = useMutation({
      mutationFn: () => queueReportExport(user.id, { ...filters(), label, note }),
      onSuccess: () => client.invalidateQueries({ queryKey: [user.id, 'report-exports'] }),
    });
  return (
    <details className="surface queued-export-request">
      <summary>Export all matching records</summary>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          queue.mutate();
        }}
      >
        <label>
          Report name
          <input
            value={label}
            maxLength={255}
            placeholder="Optional"
            disabled={queue.isPending}
            onChange={(event) => setLabel(event.target.value)}
          />
        </label>
        <label>
          Report message
          <input
            value={note}
            maxLength={255}
            placeholder="Optional"
            disabled={queue.isPending}
            onChange={(event) => setNote(event.target.value)}
          />
        </label>
        <button className="button secondary" disabled={disabled || queue.isPending}>
          <ArrowDownToLine size={16} />
          {queue.isPending ? 'Requesting…' : 'Export'}
        </button>
      </form>
      {queue.isError && <ErrorState error={queue.error} />}
      {queue.isSuccess && (
        <p className="operational-report-success" role="status">
          {queue.data.message} <a href="/reports/exports">Open report exports</a>
        </p>
      )}
    </details>
  );
}
