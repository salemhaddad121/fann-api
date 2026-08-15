# Payment providers

Every provider implements `PaymentProvider` in
`payment-provider.interface.ts`. Adding a real one should be: write the
class, register it in `PaymentProviderRegistry`, set the env vars, change
`PAYMENT_PROVIDER`. Nothing in the service, controller, schema or frontend
should need to change — if it does, the interface is wrong and should be
fixed rather than worked around.

## Which one is live

`PAYMENT_PROVIDER` selects it. Defaults to `manual`.

| Value | State |
|---|---|
| `manual` | Working. Buyer transfers money, admin confirms. **Keep permanently** as the fallback. |
| `mock` | Working, dev only. Full automated path against a fake provider. |
| `whish` | Stub. Throws `NotImplementedException`. |
| `omt` | Stub. Throws `NotImplementedException`. |

## Testing the automated path with `mock`

```
PAYMENT_PROVIDER=mock
MOCK_PAYMENT_SECRET=mock-secret
```

`createIntent` returns a `redirectUrl` pointing at a stub checkout page
served by the API. That page posts a correctly-signed webhook to
`POST /webhooks/payments/mock`, which runs the same code a real provider
would hit: signature check, idempotent lookup, amount comparison, status
transition, and minting through the same function the admin confirm button
uses.

The signature is a real HMAC-SHA256 over the raw body, compared in constant
time. That is deliberate — a mock that skipped verification would leave the
riskiest part of a payment integration unexercised until the day real
credentials arrive.

## What each real provider will need

Not blockers for anything above; this is the list for when credentials are
being requested.

### Whish Money
- Merchant account
- API key / secret for creating payment links
- Webhook signing secret, and the exact algorithm and header name
- Sandbox environment
- Callback URL allowlist entry for `POST /webhooks/payments/whish`
- Whether it supports recurring charges, or whether every renewal is a
  fresh one-off intent (we build for the latter — see below)

### OMT
- Merchant/agent account
- Whether there is an online payment API at all, or only branch payment
  with reference reconciliation
- If reconciliation: the reference format, and how statements are pulled
- If there is no webhook, `getStatus` becomes the primary path and the
  reconciliation cron is what drives it, not a fallback

## Renewals

Built as a fresh one-off intent the buyer approves each period, not an
auto-charge. Auto-charging needs stored credentials or a recurring mandate,
and neither Whish nor OMT is confirmed to support that. Fresh intents work
on every provider, and auto-charge can be added later without a schema
change.

## Things that will bite you

- **The raw body is required.** Signatures are an HMAC over the exact bytes
  sent. `main.ts` creates the app with `rawBody: true` for this reason; if
  that is ever removed, every signature check silently starts failing.
- **Webhooks answer 200 even when rejected.** A 4xx makes most providers
  retry for hours. Rejections are recorded in `payment_webhook_events` with
  `signature_ok = false` and answered 200.
- **Providers retry.** `idx_payments_provider_ref` is the idempotency key,
  and minting refuses to run twice for one payment. Both are load-bearing.
- **Amount is verified against the stored intent.** A webhook claiming a
  different amount or currency marks the payment `disputed` and mints
  nothing.
