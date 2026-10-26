# Approve a new device from a signed-in one

This amends ADR 0020, which named two ways in, and ADR 0012, which had the TV type a Sign-in Code. The design and its threat model are in the spec, Linear PAL-1005.

The Host found the eight-character Sign-in Code too slow to type on the Siri Remote. ADR 0012 said it was short enough. It is not. The TV is the device that cannot type, so the new way in starts on the TV and asks nothing of its keyboard.

**Approval Request.** A signed-out device starts an Approval Request with its label and platform. The Group answers with a 6-digit Approval Code, a secret, and an expiry. The device shows the code, and a QR code for the same code, until a signed-in Person approves it or it expires. Then it starts a new one. This is the OAuth Device Authorization Grant (RFC 8628) with Orbis daily keys.

**Approve.** A Person with a daily key enters or scans the code. The Group shows the request's platform, label, and age, so the Person can match it to the device in front of them. Approving signs the device in as that Person, never as anyone else. The Host has no extra power here. A node key and a stream grant cannot approve. There is no decline: the request expires by itself.

**Links.** The QR code holds `https://orbis.p11a.xyz/pair#<Approval Code>`. The web Worker serves `apple-app-site-association` for the iOS app with the paths `/pair` and `/join`, so the iPhone Camera opens the link in Orbis. Without Orbis the link opens the web `/pair` page, which approves for a signed-in browser. The code rides in the fragment, so no browser sends it to a server, and the page removes it from the address bar. The app also opens `orbis://pair#<code>`, which the simulator journeys use because a simulator cannot verify the domain. A signed-out phone keeps the code until the Person signs in. A Person can also type the code in Settings › Add a Device.

**Collect.** The device holds a wait open for up to 25 seconds with its secret in the request body. The wait answers `pending`, or `approved` with a new daily key for the approver, labeled with the request's label. The Group makes the key only at that moment and delivers it once. The code alone never returns a key. Only the device that holds the secret receives one.

**Limits.** An Approval Code has 6 digits, lives 2 minutes, and works once. The Group never issues a code a live request holds. Starting a request and each unknown code count as failed sign-in attempts in the ADR 0020 limiter: 20 a minute per client and 100 a minute for the Group. A client over the limit is refused before the code is looked up. At most 3 requests are live per client and 20 in the Group. A wait with a valid secret does not count. Finding or approving needs a daily key, so a caller with no key cannot try a code at all.

**Memory only.** Approval Requests live in memory in the Group, beside the attempt limiter. They are not written to SQLite or the trust store. A deploy or restart drops them, and the device starts a new one. Because the key is made only when the device collects it, a lost approval leaves no unused key behind. The code and the secret never appear in logs. The Group keeps only the secret's SHA-256 digest.

The Group Passcode and the Sign-in Code stay. A Host still shows a Sign-in Code for a friend who lost every device, `bun run trust recover` still prints one, and a device that cannot reach a signed-in one can still type one. This design adds a faster path without a new way to get locked out, which is what ADR 0020 removed Device Links to prevent.

Rejected alternatives:

- **A long token in the QR code beside the short code.** The QR code and the digits sit side by side on the same screen, so the token would protect nothing. One code means one lookup.
- **Four digits.** With the same limits, a targeted guess succeeds 1 time in 250 and a mistyped digit reaches another live request 1 time in 526. Six digits cost two more taps and make both rare.
- **Storing requests in SQLite.** They live 2 minutes and a restart costs the device one new code. Storage would add a table and cleanup for nothing.
- **The phone pushes the key to the TV.** The TV would need an address the phone can reach. The open wait needs none.

Phishing remains. An attacker can start a request on their own device and send its link to a Person. If the Person approves, the attacker gets that Person's daily key. The 2-minute life, a sheet that names the platform, its age, and the account, and the new device at the top of the Person's device list limit the risk. ADR 0016 accepted the same risk for this small Group.
