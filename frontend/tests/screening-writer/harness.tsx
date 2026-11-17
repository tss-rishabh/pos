import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { ScreeningRecovery } from '../../src/pages/screening-writer';
import { setRequestOperator } from '../../src/api/client';
const operatorId = '1';
setRequestOperator(operatorId);
function Harness() {
  const [saved, setSaved] = useState(0),
    [pending, setPending] = useState(false),
    [online, setOnline] = useState(true);
  return (
    <>
      <button
        onClick={() => {
          setRequestOperator('2');
          setOnline(false);
        }}
      >
        Switch operator
      </button>
      <button onClick={() => setOnline((value) => !value)}>Toggle network</button>
      <output>
        Saved {saved}; pending {String(pending)}
      </output>
      <ScreeningRecovery
        scope={{
          operatorId,
          storeId: '1',
          checkoutId: '11111111-1111-4111-8111-111111111111',
          operationId: '22222222-2222-4222-8222-222222222222',
        }}
        online={online}
        onPending={setPending}
        onSaved={async () => {
          setSaved((value) => value + 1);
        }}
      />
    </>
  );
}
createRoot(document.getElementById('root')!).render(<Harness />);
