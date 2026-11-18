/** Synthetic fixture identifiers only; this module contains no runtime seams. */
export const profileCheckout = '55fd65d0-72b5-4d9d-8c9c-f799bdd5b64c';
export const profileDraft = 'e42d847f-7634-4234-8b83-47f48fc69d06';
export const profileDraftVersion = 1763500000000;
export const profileBase = `/api/v1/stores/1/checkout-sessions/${profileCheckout}`;
export const profileApi = profileBase + '/customer-profile';
export const profileAdjustmentApi = profileBase + '/customer-profile-adjustments';
export const profileInitial = {
  birthdate: '2000-02-29',
  anniversary: '2020-01-01',
  gender: 'F',
  customer_type: 'B2C',
  gstin: '',
};
