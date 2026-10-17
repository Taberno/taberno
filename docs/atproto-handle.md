# Use your store domain as your AT Protocol handle

An AT Protocol account (Bluesky, for example) can use a domain you own as its
handle — `@shop.example.com` instead of `@shop-example.bsky.social`. It tells
people, and directories that list your products, that the account really is
your shop's. Directories show a verified badge for shops whose handle matches
their website.

Your store proves the domain is yours by serving the account's DID at
`https://<your store domain>/.well-known/atproto-did`. Taberno does that for
you.

Everything happens under **Settings → AT Protocol**, in four steps.

## 1. Create an account

Sign up for a free account at [bsky.app](https://bsky.app), or on any other AT
Protocol host. Use one that belongs to the shop, not your personal account. It
starts with a handle like `@yourshop.bsky.social`; that changes in step 3.

## 2. Connect it

Enter the account's handle and click **Connect**. You sign in on your
account's host and approve Taberno, which asks only to publish shop records and
update the handle. Connecting also saves the account's DID, so your store
starts serving it straight away.

## 3. Use your domain as the handle

Click **Use yourshop.com as handle**. Taberno checks that your domain is
serving the DID, asks your account's host to switch the handle, and waits for
the network to confirm it.

If it says Taberno needs permission, click **Reconnect to grant permission**
(accounts connected before this feature was added didn't grant it).

**Doing it by hand** works too: open **Do it by hand**, copy the DID, then in
Bluesky go to **Settings → Handle → I have my own domain**, enter your domain,
choose **No DNS panel** and press **Verify**.

## 4. Publish

Tick **Publish products to this account** and save.

## What the status line means

The line at the bottom of the page is worked out each time the page loads, or
when you click **Check again**:

- **✓ handle verified**: the account claims the handle shown, and that handle
  points back to the account's DID. If the handle is your store domain, step 3
  is done.
- **⚠ handle not verified**: the account has no handle yet, or its handle
  doesn't point back to it. Just after a change this is usually the network
  catching up; check again in a minute. Otherwise, run step 3 again.

## Good to know

- The handle is your store's primary domain: the one in **Settings → Store URL**,
  or on Taberno Cloud, the domain your store is served on. If you move to a new
  domain, run step 3 again.
- A store on `localhost` can't be used as a handle; the domain has to be
  publicly reachable over https.
- Hosts limit how often a handle can change. If you're told to wait, try again
  later.
- Clearing the DID (under **Do it by hand**) makes `/.well-known/atproto-did`
  return 404 again, and the account's handle stops verifying.
