# Contact reference query candidate

Verified metadata in `evidence/mysql-customer-contact-schema.json` shows `refund_alternate_payment_details` has its PK, unique `refund_request_id` and single-column `idx_status`; it has no order-leading index. The source/current replacement select and update eligible pending refund addresses by the customer's order IDs plus status and failed refund request. A status-only path can examine pending rows belonging to other customers.

Candidate for writer review, not applied to live MySQL:

```sql
CREATE INDEX ix_contact_refund_order_status_request
  ON refund_alternate_payment_details(order_id,status,refund_request_id);
```

The relevant query remains bound:

```sql
SELECT a.order_id,a.refund_request_id
FROM refund_alternate_payment_details AS a
JOIN orders AS o ON o.id=a.order_id
JOIN refund_requests AS r ON r.id=a.refund_request_id
WHERE o.user_id=:customer_id
  AND a.status='PENDING'
  AND r.is_completed='FAILED';
```

The index is nonunique and changes no recipient, join, status predicate, response formatting, financial amount or audit rule. `references.mysql.test.ts` runs the pinned Python helper before the candidate, installs the index only in its isolated localhost fixture, and compares the Node transaction's complete membership/Juspay/voucher/welcome/refund result against that oracle. It also verifies the index is eligible for the bound order/status lookup. The test removes the candidate afterward.

This is a response-preserving index candidate, not a measured production speed claim. Review representative writer plans/cardinalities and the deployment's index-build behavior before application. Existing `users.email/telephone`, EAV, voucher recipient, welcome email and coupon-user indexes are retained; no unsupported unique constraint is proposed on legacy contact columns. No live DDL or contact rows were read or changed for this suggestion.
