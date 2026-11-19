import { z } from 'zod';

const details = z.object({ name: z.string(), object: z.string() }).passthrough();
const changed = z
  .object({
    fields: z.array(z.string()),
    name: z.string().optional(),
    object: z.string().optional(),
  })
  .passthrough();
const pythonFalsy = (value: unknown) =>
  value === null ||
  value === false ||
  value === 0 ||
  value === '' ||
  (Array.isArray(value) && value.length === 0) ||
  (typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0);
function fieldsList(fields: readonly string[]) {
  return fields.length < 2
    ? fields.join('')
    : fields.slice(0, -1).join(', ') + ' and ' + fields[fields.length - 1];
}

/** Django4.2.5 LogEntry.get_change_message under the source en-us locale. Never return raw JSON for structurally corrupt messages. */
export function administrationChangeMessage(raw: string): {
  text: string;
  state: 'available' | 'invalid';
} {
  if (!raw.startsWith('[')) return { text: raw, state: 'available' };
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw) as unknown;
  } catch {
    return { text: raw, state: 'available' };
  }
  if (!Array.isArray(decoded))
    return { text: 'This history message is unavailable.', state: 'invalid' };
  const messages: string[] = [];
  for (const value of decoded as unknown[]) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      return { text: 'This history message is unavailable.', state: 'invalid' };
    const item = value as Record<string, unknown>;
    if ('added' in item) {
      if (pythonFalsy(item.added)) messages.push('Added.');
      else {
        const parsed = details.safeParse(item.added);
        if (!parsed.success)
          return { text: 'This history message is unavailable.', state: 'invalid' };
        messages.push(`Added ${parsed.data.name} “${parsed.data.object}”.`);
      }
    } else if ('changed' in item) {
      const parsed = changed.safeParse(item.changed);
      if (!parsed.success || (parsed.data.name !== undefined && parsed.data.object === undefined))
        return { text: 'This history message is unavailable.', state: 'invalid' };
      const fields = fieldsList(parsed.data.fields);
      messages.push(
        parsed.data.name === undefined
          ? `Changed ${fields}.`
          : `Changed ${fields} for ${parsed.data.name} “${parsed.data.object}”.`,
      );
    } else if ('deleted' in item) {
      const parsed = details.safeParse(item.deleted);
      if (!parsed.success)
        return { text: 'This history message is unavailable.', state: 'invalid' };
      messages.push(`Deleted ${parsed.data.name} “${parsed.data.object}”.`);
    }
  }
  return { text: messages.join(' ') || 'No fields changed.', state: 'available' };
}
function pythonWhitespace(character: string) {
  const code = character.codePointAt(0)!;
  return /\p{White_Space}/u.test(character) || (code >= 0x1c && code <= 0x1f);
}
export function administrationActorName(username: string, firstName: string, lastName: string) {
  const fullName = sourceAdministrationFullName(firstName, lastName);
  return fullName ? `${username} (${fullName})` : username;
}
export function sourceAdministrationFullName(firstName: string | null, lastName: string | null) {
  // Django get_full_name() formats '%s %s'; nullable pos_user names print as 'None'.
  const points = [...((firstName ?? 'None') + ' ' + (lastName ?? 'None'))];
  let from = 0,
    to = points.length;
  while (from < to && pythonWhitespace(points[from]!)) from++;
  while (to > from && pythonWhitespace(points[to - 1]!)) to--;
  const fullName = points.slice(from, to).join('');
  return fullName;
}
