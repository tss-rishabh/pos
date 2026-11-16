# Customer-service thoughts

The pinned `core/views.py:970` randomly chooses one of the 83 exact strings in
`core/quotes.py`; the dashboard rotates it every seven seconds and the counter
loads it when opened. `/api/v1/motivational-quotes/random` keeps the authenticated
source pool, with static resource tracing and no database query. The React card
loads asynchronously, provides an explicit refresh control, renders plain text
and retains an already loaded thought when offline. Dashboard rotation pauses
while hidden or offline.

The source differential test executes the original Python handler against every
source choice. HTTP checks cover unauthenticated access, malformed query fields
and the resource event contract. A production-build browser scenario covers
initial display, responsive typing during refresh, HTML escaping and offline
retention. These are component-level checks; they do not certify unrelated
dashboard or cashier behavior.
