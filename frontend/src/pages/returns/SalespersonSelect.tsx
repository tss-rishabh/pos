import type { Salesperson } from './client';
export function SalespersonSelect({
  people,
  value,
  onChange,
  disabled = false,
}: {
  people: Salesperson[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <label>
      Salesperson
      <select
        aria-label="Exchange salesperson"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        required
      >
        <option value="">Select a salesperson</option>
        {people.map((person) => (
          <option key={person.id} value={person.id}>
            {person.name}
          </option>
        ))}
      </select>
    </label>
  );
}
