import { db, type LocalDraft } from '../../src/offline/database';
import { saveRecovery } from '../../src/pages/checkout/client';
import { profileDraft, profileDraftVersion, profileCheckout } from '../../../backend/tools/customer-profile/native-workflow-contracts';

// Only a normal saved sale and its existing native checkout recovery reference
// are fixture input. App obtains identity/session/stores from actual HTTP.
const draft: LocalDraft = {
  ownerId: '7', id: profileDraft, storeId: '1', counterId: '2', customerId: '777', version: 1,
  createdAt: profileDraftVersion, updatedAt: profileDraftVersion,
  lines: [{ productId: '10', name: 'Synthetic profile fixture product', barcode: null, unitPrice: '125.00', quantity: 1 }],
};
await db.drafts.put(draft);
saveRecovery('7', profileDraft, { checkoutId: profileCheckout, draftVersion: profileDraftVersion, pendingOperationId: null });
document.body.dataset.ready = 'true';
