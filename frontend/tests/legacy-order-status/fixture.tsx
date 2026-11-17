import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { setRequestOperator } from '../../src/api/client';
import { WholeOrderStatusActions } from '../../src/pages/order-status';
import '../../src/styles.css';
setRequestOperator('1');
function Fixture() {
  const [online, setOnline] = useState(true),
    [owner, setOwner] = useState('1');
  return (
    <>
      <button onClick={() => setOnline((value) => !value)}>Toggle connection</button>
      <button
        onClick={() => {
          setRequestOperator('2');
          setOwner('2');
        }}
      >
        Change operator
      </button>
      <WholeOrderStatusActions
        user={{ id: owner, role: 2, userType: 1, storeIds: ['1'], name: 'Synthetic', email: '' }}
        storeId="1"
        orderId="9007199254740993"
        online={online}
      />
    </>
  );
}
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Fixture />
  </React.StrictMode>,
);
