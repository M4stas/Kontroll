# Auto24 Camoufox proof-of-concept report

Date: 2026-09-26
Status: Feasibility demonstrated on four active public listings from the local Docker environment; production reliability unproven.

## What was tested

The throwaway CLI in `scrape.py` opened Auto24 passenger-car URLs with Camoufox in a Linux Docker container and returned listing-specific JSON. It extracted the title, first registration, year, mileage, price, displayed fields, grouped equipment, technical specifications, seller description and name, listing notes, photo URLs, and UTC `parsed_at`. It did not interact with hidden contact controls. A direct HTTP request made earlier received a Cloudflare challenge; Camoufox loaded the four active pages below with HTTP 200.

## Checked URLs and captured data

| Auto24 URL | Parsed at (UTC) | Captured facts | Additional capture |
|---|---|---|---|
| [Skoda Enyaq](https://www.auto24.ee/soidukid/4344096) | 2026-09-26 19:16:30 | First registration 03/2022; 46,800 km; €41,500; seller Toni | Seller description; 86 equipment items in 7 groups; 16 technical fields; 19 photo URLs |
| [Peugeot 3008](https://www.auto24.ee/soidukid/4311841) | 2026-09-26 19:11:16 | First registration 08/2024; 63,150 km; €26,900; seller Moller Auto Viru | Seller description; 37 equipment items in 6 groups; 5 technical fields; 25 photo URLs |
| [Volkswagen Golf Plug-in](https://www.auto24.ee/soidukid/4309224) | 2026-09-26 19:21:07 | First registration 08/2022; 149,748 km; €18,500; seller Moller Auto Viru | Seller description; 28 equipment items in 7 groups; 5 technical fields; 23 photo URLs |
| [Honda Accord](https://www.auto24.ee/soidukid/4352718) | 2026-09-26 19:21:17 | First registration 01/2007; 110,000 km; €3,499; seller Balticar | Seller description; 39 equipment items in 7 groups; 21 technical fields; 7 photo URLs |
| [Inactive Audi A4](https://www.auto24.ee/soidukid/4348930) | Checked 2026-09-26 | No listing data emitted | CLI exited nonzero with `{"error": "Listing is inactive"}` |

**An inactive listing was correctly reported as inactive, despite Auto24 returning a page for it.**

The values above are snapshots. A live listing may change after its parse time.

## Verification performed

- Built the PoC Docker image and ran the documented command on the Skoda listing. The command exited 0 and emitted valid JSON with HTTP status 200, the expected title, 46,800 km, €41,500, 7 equipment groups, 5 technical groups, 19 photo URLs, and a seller description.
- Ran the same Camoufox CLI on the Peugeot, Golf, and Honda listings. All exited 0 and produced JSON with the values shown above.
- Ran the inactive Audi listing. The CLI exited 1 with the explicit inactive-listing error.
- Parsed saved Skoda HTML offline and asserted the key facts and group/photo counts.
- Rebuilt the final PoC image and reran the Skoda listing at `2026-09-26T19:37:45Z`. It exited 0 with HTTP 200 and the same year, mileage, price, equipment-group count, technical-group count, and photo count.

## Issues and limits discovered

1. **Access depends on browser behavior and network identity.** A direct request encountered a Cloudflare challenge, while these Camoufox runs succeeded. The target server IP and a 100-request/day pattern have not been tested.
2. **Inactive listings need content checks.** An inactive page can load without a 404 response and lacks the normal listing structure.
3. **Page sections must be scoped.** A first broad parser included navigation, financing widgets, and duplicate images. The PoC now selects the main data table, equipment, technical data, seller description, and listing gallery.
4. **The image is large.** `docker image inspect` reported 3,209,110,931 bytes (about 3.2 GB decimal, 3.0 GiB) for this uncompressed PoC image. This is image size, not memory per request or result size.
5. **This is a throwaway parser.** It covers the pages checked, not every Auto24 layout. Seller-written prose is returned without contact-specific processing.

## Reproduce

From the repository root:

```bash
docker build -t auto24-camoufox-poc ./poc/auto24-camoufox
docker run --rm --shm-size=1g auto24-camoufox-poc https://www.auto24.ee/soidukid/4344096
```

The next implementation gate should run this probe from the intended Linux server, then add fixture-based parser checks and repeated-request measurements before relying on Camoufox for the queued service.
