# Auto24 Camoufox proof of concept

Throwaway feasibility probe. It accepts one public Auto24 passenger-car listing URL and prints listing-specific JSON. It has no API, queue, or database.

```bash
docker build -t auto24-camoufox-poc ./poc/auto24-camoufox
docker run --rm --shm-size=1g auto24-camoufox-poc https://www.auto24.ee/soidukid/4344096
```

Output includes the title, first-registration year, mileage, price, displayed specification fields, grouped equipment and technical data, seller description and name, listing notes, photo URLs, and UTC parse time. It excludes site navigation, financing widgets, related listings, and hidden contact controls. The command exits nonzero with a JSON error on stderr for inactive listings, blocked pages, or parse failures.

`--save-html /path/to/file.html` writes diagnostic HTML inside the container. Mount a directory if you need the file on the host. Diagnostic HTML may contain more page data than the JSON output and should not be treated as a sanitized artifact.
