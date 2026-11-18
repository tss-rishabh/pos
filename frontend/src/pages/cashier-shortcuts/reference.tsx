import { PageTitle } from '../../components/common';
import { CashierShortcutReferenceContent } from './help';
import { useCashierShortcutPreference } from './preference';

export default function ShortcutReferencePage({ operatorId }: { operatorId: string }) {
  const [enabled, setEnabled] = useCashierShortcutPreference(operatorId);
  return (
    <>
      <PageTitle eyebrow="AT THE COUNTER" title="Shortcut reference" />
      <section className="surface shortcut-reference">
        <p>A quick reference for billing at the counter.</p>
        <CashierShortcutReferenceContent enabled={enabled} onChange={setEnabled} />
      </section>
    </>
  );
}
