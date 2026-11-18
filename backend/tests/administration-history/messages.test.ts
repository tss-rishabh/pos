import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { goldenStdout } from '../golden/load.js';
import {
  administrationActorName,
  administrationChangeMessage,
} from '../../src/modules/administration-history/messages.js';

describe('pinned Django administration history messages', () => {
  it('matches actual en-us Django formatting, malformed-data boundaries and current username/full-name display', () => {
    const raw = [
      '',
      'Password changed successfully.',
      '[',
      ' []',
      '[]',
      '[{}]',
      '[{"added":{}}]',
      '[{"added":null}]',
      '[{"added":[]}]',
      '[{"added":false}]',
      '[{"added":{"name":"group","object":"Fixture"}}]',
      '[{"changed":{"fields":[]}}]',
      '[{"changed":{"fields":["email"]}}]',
      '[{"changed":{"fields":["email","phone"]}}]',
      '[{"changed":{"fields":["email","phone","role"],"name":"operator","object":"Fixture"}}]',
      '[{"deleted":{"name":"group","object":"Fixture"}}]',
      '[{"added":{}},{"changed":{"fields":["email"]}},{"deleted":{"name":"group","object":"Fixture"}}]',
      '[{"added":{},"changed":{"fields":["ignored"]}}]',
      '[{"unknown":true}]',
      '[{"changed":{}}]',
      '[1]',
      '["added"]',
      '[{"deleted":null}]',
      '[{"changed":{"fields":["<script>"]}}]',
    ];
    const actors = [
      { username: 'fixture', firstName: '', lastName: '' },
      { username: 'fixture', firstName: '  First', lastName: 'Last  ' },
      { username: 'fixture', firstName: '\u0085\u001cFirst', lastName: 'Last\u001f' },
      { username: 'fixture', firstName: '\ufeff', lastName: '' },
      { username: 'fixture', firstName: '  ', lastName: '  ' },
    ];
    const expected = z
      .object({ djangoVersion: z.literal('4.2.5'), cases: z.array(z.unknown()) })
      .parse(
        JSON.parse(
          goldenStdout(
            'administration-history',
            'messages',
            JSON.stringify({
              cases: [
                ...raw.map((value) => ({ operation: 'message', raw: value })),
                ...actors.map((value) => ({ operation: 'actor', ...value })),
              ],
            }),
          ),
        ) as unknown,
      );
    for (const [index, value] of raw.entries())
      expect(administrationChangeMessage(value), 'message case ' + index).toEqual(
        expected.cases[index],
      );
    for (const [index, value] of actors.entries())
      expect(administrationActorName(value.username, value.firstName, value.lastName)).toBe(
        expected.cases[raw.length + index],
      );
  });
});
