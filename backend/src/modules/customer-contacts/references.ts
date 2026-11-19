/** Mirrors source UserController.is_real_email, including the established temp.id placeholder convention. */
export function hasRealCustomerEmail(email: string | null) {
  const value = (email || '').trim();
  return value !== '' && value !== 'None' && !value.includes('temp.id');
}
