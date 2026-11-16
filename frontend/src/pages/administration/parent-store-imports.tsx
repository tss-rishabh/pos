import type { Principal } from '../../api/types';
import { ParentStoreImportAdministration } from './imports';
import './styles.css';

export default function ParentStoreImportsPage({
  user,
  online,
}: {
  user: Principal;
  online: boolean;
}) {
  if (!online)
    return (
      <section className="surface">
        <h1>Parent/store assignments</h1>
        <p>
          Connect to import or manage assignments. Previously queued imports continue on the server.
        </p>
      </section>
    );
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">Administration</p>
          <h1>Parent/store CSV imports</h1>
        </div>
      </div>
      <ParentStoreImportAdministration user={user} />
    </>
  );
}
