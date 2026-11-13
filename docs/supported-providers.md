# Supported sandbox providers

Set `SANDBOX_PROVIDER` and the selected provider’s API key in `.env`.
Only the selected provider requires its key. All sandboxes have a thirty-minute lifetime.

## Daytona (provider-managed default resources)

- Default provider: `SANDBOX_PROVIDER=daytona` with `DAYTONA_API_KEY`.
- Uses the default TypeScript sandbox without explicit CPU, memory, or disk overrides.
- Sandboxes are private and ephemeral, with a thirty-minute auto-stop interval and TTL.

## Freestyle (2 vCPU, 4 GiB RAM, 16 GB disk)

- Set `SANDBOX_PROVIDER=freestyle` and `FREESTYLE_API_KEY`. See [Freestyle setup](https://www.freestyle.sh/docs/quickstart).
- Uses the `freestyle/ubuntu-sm` snapshot with outbound public networking.
- The pinned SDK uses native-agent command execution for runs longer than five minutes; custom or older snapshots are not supported.
- Expired VMs are deleted asynchronously by Freestyle after the thirty-minute deletion deadline.

## E2B (default `base` template resources)

- Set `SANDBOX_PROVIDER=e2b` and `E2B_API_KEY`. See [E2B setup](https://docs.e2b.dev/quickstart).
- Uses the default `base` template without explicit CPU, memory, or disk overrides.
- Installs Node 24.22.3 for the required skills CLI.
- Runs with outbound Internet access, authenticated sandbox URLs, and a thirty-minute timeout.
