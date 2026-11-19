import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronDown, Search, X } from 'lucide-react';

export interface MultiSelectOption {
  value: string;
  label: string;
}

/**
 * Searchable multi-select (W27), replacing raw `<select multiple>` lists. The trigger is a
 * button named by the field label; the panel holds a search box and one checkbox per option.
 * Selected values keep the options' order. An empty selection means "all", as the callers'
 * legacy filters define it, and the trigger then shows `emptyLabel`.
 */
export function MultiSelect({
  label,
  options,
  value,
  onChange,
  emptyLabel = 'All',
  searchLabel,
  disabled = false,
  hint,
}: {
  label: string;
  options: readonly MultiSelectOption[];
  value: readonly string[];
  onChange: (value: string[]) => void;
  emptyLabel?: string;
  searchLabel?: string;
  disabled?: boolean;
  hint?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState('');
  const root = useRef<HTMLDivElement>(null),
    trigger = useRef<HTMLButtonElement>(null);
  const selected = useMemo(() => new Set(value), [value]);
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle
      ? options.filter((option) => option.label.toLowerCase().includes(needle))
      : options;
  }, [options, query]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (root.current && event.target instanceof Node && !root.current.contains(event.target))
        setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  const chosen = options.filter((option) => selected.has(option.value));
  const summary =
    chosen.length === 0
      ? emptyLabel
      : chosen.length <= 2
        ? chosen.map((option) => option.label).join(', ')
        : `${chosen.length} selected`;
  function toggle(optionValue: string, checked: boolean) {
    const next = new Set(selected);
    if (checked) next.add(optionValue);
    else next.delete(optionValue);
    onChange(options.filter((option) => next.has(option.value)).map((option) => option.value));
  }
  return (
    <div
      className="field multi-select"
      ref={root}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          trigger.current?.focus();
        }
      }}
    >
      <span className="field-label" id={`${id}-label`}>
        {label}
      </span>
      <button
        ref={trigger}
        type="button"
        className="multi-select-trigger"
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-summary`}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={`${id}-panel`}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <span id={`${id}-summary`} className={chosen.length ? '' : 'placeholder'} title={summary}>
          {summary}
        </span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {hint && <small className="field-hint">{hint}</small>}
      {open && (
        <div className="multi-select-panel" id={`${id}-panel`} role="group" aria-label={label}>
          <label className="multi-select-search">
            <Search size={14} aria-hidden="true" />
            <input
              autoFocus
              type="search"
              aria-label={searchLabel ?? `Search ${label.toLowerCase()}`}
              placeholder="Search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <div className="multi-select-actions">
            <span>{chosen.length ? `${chosen.length} selected` : emptyLabel}</span>
            {chosen.length > 0 && (
              <button type="button" className="text-button" onClick={() => onChange([])}>
                <X size={12} aria-hidden="true" /> Clear
              </button>
            )}
          </div>
          <ul className="multi-select-options">
            {visible.map((option) => (
              <li key={option.value}>
                <label title={option.label}>
                  <input
                    type="checkbox"
                    value={option.value}
                    checked={selected.has(option.value)}
                    onChange={(event) => toggle(option.value, event.target.checked)}
                  />
                  <span>{option.label}</span>
                </label>
              </li>
            ))}
            {visible.length === 0 && <li className="multi-select-empty">No matches</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
