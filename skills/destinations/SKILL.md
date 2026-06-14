# Destinations

Use this skill for place recommendations, destination comparisons, errands, restaurant/store choices, and ride helpers.

## Process

- Use `web_search` when current/local options matter.
- Rank by Jack's stated preference first, then proximity, quality, store size, and errand fit.
- Be explicit about the tradeoff.
- Return a concise recommendation plus alternatives only when useful.
- Include destination name and address.

For grocery requests in San Diego:

- Jack prefers Whole Foods.
- Same-quality closer options are acceptable.
- For a full food shop, avoid tiny/convenience-format stores unless clearly framed as quick-run options.

## Links

When coordinates or a precise address are available, include three links for the chosen destination.

Google Maps:

```text
https://www.google.com/maps/search/?api=1&query=<encoded address or place>
```

Uber web:

```text
https://m.uber.com/ul/?action=setPickup&pickup=my_location&dropoff[latitude]=<lat>&dropoff[longitude]=<lng>&dropoff[nickname]=<name>&dropoff[formatted_address]=<encoded address>
```

Lyft web:

```text
https://lyft.com/ride?id=lyft&destination[latitude]=<lat>&destination[longitude]=<lng>&destination[address]=<encoded address>
```

Prefer these web formats for Jack's phone. Do not use native `uber://` or `lyft://` links from Telegram unless Jack asks.

Do not claim live Uber/Lyft prices unless Jack provides screenshots or a working price source. Tell him to tap both links for live fares, or compare screenshots if he sends them.

## Response shape

```markdown
Best pick: **Whole Foods Hillcrest**
711 University Ave, San Diego, CA 92103

Closest proper Whole Foods-quality full grocery shop from downtown. If you only need a smaller organic run, Jimbo's downtown may be easier; for stocking up, I’d use Hillcrest.

Google Maps: <link>
Uber: <link>
Lyft: <link>

My call: Whole Foods Hillcrest for a real food shop; Jimbo's for a quick closer run.
```
