import { NavLink, useLocation } from 'react-router-dom';
import type { Principal } from '../../api/types';
import { PageTitle } from '../../components/common';
import { ReturnsPage } from './index';
import { readReturnOrderEntry } from './order-entry';

export default function ReturnEntryPage(props: {
  user: Principal;
  storeId: string;
  counterId: string;
}) {
  const { search } = useLocation();
  const selection = readReturnOrderEntry(search, {
    operatorId: props.user.id,
    storeId: props.storeId,
    counterId: props.counterId,
  });
  if (selection.status === 'invalid' || selection.status === 'mismatch') {
    return (
      <>
        <PageTitle eyebrow="CUSTOMER CARE" title="Returns" />
        <p role="alert">
          {selection.status === 'invalid'
            ? 'This return link is incomplete or invalid. Open the order again.'
            : 'This return link belongs to a different operator, store or counter. Restore that workspace and check in before opening it.'}
        </p>
        <NavLink to="/returns">Open returns in the current workspace</NavLink>
      </>
    );
  }
  return (
    <ReturnsPage
      key={search}
      {...props}
      entry={selection.status === 'ready' ? selection.entry : undefined}
    />
  );
}
