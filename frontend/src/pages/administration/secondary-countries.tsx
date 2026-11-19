import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import type { Principal } from '../../api/types';
import { captureOperatorScope, request } from '../../api/client';
import { ErrorState, PageTitle } from '../../components/common';
import { useOnline } from '../../hooks/use-pos';
const countryResponse = z
  .object({
    status: z.literal('success'),
    message: z.literal('Country name'),
    data: z
      .object({
        country: z
          .array(z.object({ id: z.string(), text: z.string() }))
          .max(1000)
          .optional(),
      })
      .strict(),
  })
  .strict();
function CountrySearch({ user }: { user: Principal }) {
  const online = useOnline(),
    [search, setSearch] = useState(''),
    [result, setResult] = useState<z.infer<typeof countryResponse> | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null),
    controller = useRef<AbortController | null>(null);
  useEffect(() => {
    const local = new AbortController();
    controller.current = local;
    return () => local.abort();
  }, []);
  async function find() {
    let signal: AbortSignal;
    try {
      if (!controller.current) throw new DOMException('This search is closed.', 'AbortError');
      signal = AbortSignal.any([captureOperatorScope(user.id), controller.current.signal]);
    } catch (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const reply = await request(
        '/api/v1/countries/secondary/search',
        { method: 'POST', operatorId: user.id, signal, body: JSON.stringify({ search }) },
        countryResponse,
      );
      signal.throwIfAborted();
      setResult(reply);
    } catch (problem) {
      if (!signal.aborted) setError(problem);
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  }
  return (
    <>
      <PageTitle title="Secondary country lookup" />
      <section className="surface administration-panel">
        <form
          className="form-grid"
          onSubmit={(event) => {
            event.preventDefault();
            void find();
          }}
        >
          <label>
            Country name
            <input
              value={search}
              maxLength={1000}
              disabled={busy}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <button
            className="button primary"
            disabled={!online || busy}
            aria-busy={busy}
            type="submit"
          >
            Search countries
          </button>
        </form>
        {!online && <p role="status">Reconnect to search countries.</p>}
        {error != null && <ErrorState error={error} />}{' '}
        {result && (
          <>
            {result.data.country ? (
              <>
                {result.data.country.length ? (
                  <table>
                    <caption>Matching secondary countries</caption>
                    <thead>
                      <tr>
                        <th>Country ID</th>
                        <th>Name</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.data.country.map((row) => (
                        <tr key={row.id}>
                          <td>{row.id}</td>
                          <td>{row.text}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p>No matching secondary countries.</p>
                )}
              </>
            ) : (
              <p>Enter a country name to search.</p>
            )}
          </>
        )}
      </section>
    </>
  );
}
export function SecondaryCountrySearchPage({ user }: { user: Principal }) {
  return <CountrySearch key={user.id} user={user} />;
}
export default SecondaryCountrySearchPage;
