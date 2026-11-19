import { useEffect, useState } from 'react';
import { registrationSchema, type Checkout, type CheckoutReply, type Registration } from './client';

export interface CustomerRegistrationProps {
  checkout: Checkout;
  disabled: boolean;
  act(task: () => Promise<void>): Promise<void>;
  mutate(
    path: string,
    method: 'POST' | 'PUT',
    body?: Record<string, unknown>,
  ): Promise<CheckoutReply>;
  refresh(): Promise<Checkout>;
}
export function CustomerRegistration({
  checkout,
  disabled,
  act,
  mutate,
  refresh,
}: CustomerRegistrationProps) {
  const [registration, setRegistration] = useState<Registration | null>(
      checkout.registration ?? null,
    ),
    [name, setName] = useState(''),
    [telephone, setTelephone] = useState(''),
    [email, setEmail] = useState(''),
    [birthdate, setBirthdate] = useState(''),
    [customerType, setCustomerType] = useState<'' | 'B2B' | 'B2C'>(''),
    [gstin, setGstin] = useState(''),
    [code, setCode] = useState(''),
    // The mobile the OTP went to: legacy posts the dialog's mobile again with `self_verify=1`.
    [sentTelephone, setSentTelephone] = useState(''),
    [clock, setClock] = useState(Date.now());
  useEffect(() => {
    setRegistration(checkout.registration ?? null);
  }, [checkout.registration]);
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const apply = async (path: string, body: Record<string, unknown> = {}) => {
    const reply = await mutate(path, 'POST', body);
    const value = registrationSchema.parse(reply.result?.registration);
    setRegistration(value);
    setCode('');
    return value;
  };
  /**
   * Legacy "Verify with OTP" (`create_order.html:4954-5024`): one action verifies the code,
   * registers through API-v2 `store-register`, then syncs the walk-in cart to the new customer
   * (`ajax-sync-cart`). Each later step can be retried from its own button if one fails.
   */
  const connect = async (value: Registration) => {
    if (value.status === 'registered' && value.customerId)
      await mutate('customer', 'PUT', { customerId: value.customerId });
  };
  const registerVerified = async (verified: Registration) => {
    if (verified.status !== 'verified' && verified.status !== 'registered') return;
    const registered =
      verified.status === 'registered' ? verified : await apply('customer-registrations');
    await connect(registered);
  };
  const verifyAndRegister = async () =>
    registerVerified(await apply('customer-registration-challenges/verifications', { code }));
  /**
   * Legacy "Self Verify (Without OTP)" (`create_order.html:4856,4996`; `order/views.py:2448`):
   * registers and connects without the code. The server accepts it only for the mobile this
   * sale's OTP was sent to, within the OTP window, and never treats it as a verified customer.
   */
  const selfVerifyAndRegister = async () =>
    registerVerified(
      await apply('customer-registration-challenges/self-verifications', {
        telephone: sentTelephone,
      }),
    );
  const otpSent = registration?.deliveries.some((delivery) => delivery.status === 'sent') ?? false;
  if (checkout.customerId) return null;
  return (
    <details open={registration !== null}>
      <summary>Create a customer account</summary>
      {!registration ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void act(async () => {
              await apply('customer-registration-challenges', {
                details: {
                  name,
                  telephone,
                  email,
                  birthdate,
                  customerType,
                  gstin: customerType === 'B2B' ? gstin : '',
                },
              });
              setSentTelephone(telephone);
              setName('');
              setTelephone('');
              setEmail('');
              setBirthdate('');
              setCustomerType('');
              setGstin('');
            });
          }}
        >
          <label>
            Customer name
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              maxLength={45}
              autoComplete="name"
            />
          </label>
          <label>
            Customer mobile
            <input
              value={telephone}
              onChange={(event) => setTelephone(event.target.value.replace(/\D/g, '').slice(0, 10))}
              required
              inputMode="tel"
              pattern="[6-9][0-9]{9}"
              maxLength={10}
              autoComplete="tel-national"
            />
          </label>
          <label>
            Customer email (optional)
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              maxLength={254}
              autoComplete="email"
            />
          </label>
          <label>
            Date of birth (optional)
            <input
              type="date"
              value={birthdate}
              onChange={(event) => setBirthdate(event.target.value)}
              min="1900-01-01"
              autoComplete="bday"
            />
          </label>
          <label>
            Customer type
            <select
              aria-label="Customer type"
              value={customerType}
              required
              onChange={(event) => {
                const value = event.target.value;
                setCustomerType(value === 'B2B' || value === 'B2C' ? value : '');
                setGstin('');
              }}
            >
              <option value="">Select Customer Type</option>
              <option value="B2B">B2B</option>
              <option value="B2C">B2C</option>
            </select>
          </label>
          {customerType === 'B2B' && (
            <label>
              Customer GSTIN
              <input
                value={gstin}
                onChange={(event) =>
                  setGstin(
                    event.target.value
                      .toUpperCase()
                      .replace(/[^A-Z0-9]/g, '')
                      .slice(0, 15),
                  )
                }
                required
                pattern="[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]"
                minLength={15}
                maxLength={15}
              />
            </label>
          )}
          <button className="button secondary" disabled={disabled || !customerType}>
            Get OTP
          </button>
          <p className="caption">
            The customer must verify their mobile before an account is created. An omitted email
            uses the existing mobile@temp.id convention.
          </p>
        </form>
      ) : (
        <div>
          <p role="status">
            Registration {registration.status}. Reference {registration.id}.
          </p>
          {registration.deliveries.map((delivery) => (
            <p className="caption" key={delivery.channel}>
              {delivery.channel === 'sms' ? 'SMS' : 'WhatsApp'}: {delivery.status}
            </p>
          ))}
          <button
            type="button"
            className="button secondary"
            disabled={disabled}
            onClick={() =>
              void act(async () => {
                const latest = await refresh();
                setRegistration(latest.registration ?? null);
              })
            }
          >
            Check registration status
          </button>
          {['pending', 'expired', 'locked'].includes(registration.status) ||
          (['dispatching', 'uncertain'].includes(registration.status) &&
            !registration.verifiedAt) ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void act(verifyAndRegister);
              }}
            >
              <label>
                One Time Password (OTP)
                <input
                  value={code}
                  onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  minLength={6}
                  maxLength={6}
                  autoComplete="one-time-code"
                  required
                />
              </label>
              <p className="caption">
                {registration.attemptsRemaining} attempts remain. The server enforces the expiry and
                shared attempt limits.
              </p>
              <button
                className="button secondary"
                disabled={
                  disabled ||
                  clock >= registration.expiresAt ||
                  registration.attemptsRemaining === 0
                }
              >
                Verify with OTP
              </button>
              {registration.status === 'pending' && otpSent && (
                <>
                  {!sentTelephone && (
                    <label>
                      Customer mobile
                      <input
                        value={sentTelephone}
                        onChange={(event) =>
                          setSentTelephone(event.target.value.replace(/\D/g, '').slice(0, 10))
                        }
                        inputMode="tel"
                        pattern="[6-9][0-9]{9}"
                        maxLength={10}
                        autoComplete="tel-national"
                      />
                    </label>
                  )}
                  <button
                    type="button"
                    className="button secondary"
                    disabled={
                      disabled ||
                      clock >= registration.expiresAt ||
                      !/^[6-9]\d{9}$/.test(sentTelephone)
                    }
                    onClick={() => void act(selfVerifyAndRegister)}
                  >
                    Self Verify (Without OTP)
                  </button>
                </>
              )}
            </form>
          ) : null}
          {registration.status === 'verified' && (
            <button
              type="button"
              className="button primary"
              disabled={disabled}
              onClick={() =>
                void act(async () => {
                  await connect(await apply('customer-registrations'));
                })
              }
            >
              Create verified customer
            </button>
          )}
          {['dispatching', 'uncertain'].includes(registration.status) && (
            <>
              <p className="caption">
                Registration may have completed. Reconciliation checks the writer without sending
                another registration.
              </p>
              <button
                type="button"
                className="button secondary"
                disabled={disabled || !registration.verifiedAt}
                onClick={() =>
                  void act(async () => {
                    await connect(await apply('customer-registration-reconciliations'));
                  })
                }
              >
                Reconcile registration
              </button>
            </>
          )}
          {registration.status === 'registered' && registration.customerId && (
            <button
              type="button"
              className="button primary"
              disabled={disabled}
              onClick={() =>
                void act(async () => {
                  await mutate('customer', 'PUT', { customerId: registration.customerId });
                })
              }
            >
              Connect registered customer
            </button>
          )}
          {registration.status !== 'registered' && (
            <button
              type="button"
              className="button secondary"
              disabled={disabled || clock < registration.retryAt}
              onClick={() =>
                void act(async () => {
                  await apply('customer-registration-challenges/resends');
                })
              }
            >
              Request a new registration code
            </button>
          )}
          {!['dispatching', 'uncertain'].includes(registration.status) && (
            <button
              type="button"
              className="button secondary"
              disabled={disabled}
              onClick={() =>
                void act(async () => {
                  await mutate('customer-registration-cancellations', 'POST');
                  setRegistration(null);
                  setCode('');
                  setSentTelephone('');
                })
              }
            >
              Close registration
            </button>
          )}
        </div>
      )}
    </details>
  );
}
