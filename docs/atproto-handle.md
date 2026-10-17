# Use your store domain as your AT Protocol handle

An AT Protocol account (Bluesky, for example) can use a domain you own as its
handle — `@shop.example.com` instead of `@shop-example.bsky.social`. It tells
people, and directories that list your products, that the account really is
your shop's.

Your store proves the domain is yours by serving the account's DID at
`https://<your store domain>/.well-known/atproto-did`. Taberno does that for you
once you've told it the DID.

## 1. Create the account

Sign up for an account on any AT Protocol service, such as
[bsky.app](https://bsky.app). Any handle is fine to start with.

Find its DID (it starts `did:plc:`). In Bluesky, open **Settings → Handle →
I have my own domain → No DNS panel**: the file contents it asks you to upload
are the DID. If you've already connected the account under **Settings → AT
Protocol**, its DID is shown there too.

## 2. Paste the DID into Taberno

Go to **Settings → AT Protocol → Domain handle**, paste the DID and save. Your
store now serves it at `/.well-known/atproto-did`.

Then tell the account to use the domain. In Bluesky: **Settings → Handle →
I have my own domain**, enter your store's domain, choose **No DNS panel**, and
press **Verify**. Bluesky fetches the file from your store and switches the
handle over.

## What the check means

The **Check** button next to the handle looks up your account's public DID
document (from `plc.directory` for a `did:plc:`, or from the domain itself for a
`did:web:`) and reads the handle it claims.

- **All set** — the account claims your store domain as its handle. Done.
- **Doesn't list @your-domain yet** — Taberno is serving the DID, but the
  account hasn't been switched to the domain. Do the Bluesky step above.
- **An error** — the DID document couldn't be fetched (a mistyped DID, or the
  directory is unreachable). Check the DID and try again.

## Good to know

- The handle is your store's primary domain: the one in **Settings → Store URL**,
  or on Taberno Cloud, the domain your store is served on. If you move to a new
  domain, set the handle again on the account.
- A store on `localhost` can't be used as a handle; the domain has to be
  publicly reachable over https.
- Clearing the DID makes `/.well-known/atproto-did` return 404 again. The
  account then falls back to an invalid handle until you give it a new one.
