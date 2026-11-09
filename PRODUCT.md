# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Private used-car buyers in Estonia. They find a car on Auto24, use Kontroll to decide whether it is worth going to see, and bring the report to the viewing on their phone.

## Product Purpose

Kontroll turns an Auto24 listing into a private inspection report before the buyer goes to see the car. It reads the listing details and photos, then updates the report when the buyer adds notes, seller answers, screenshots, photos, or a taustakontroll PDF. Success means the buyer arrives at the viewing knowing what to check and what to ask the seller.

## Positioning

An evidence-led review. Kontroll reads the listing text, photos, seller answers, and the taustakontroll PDF, then writes a verdict and questions for the seller based on that evidence. A plain listing summary or a VIN check does neither.

## Operating Context

- The buyer submits an Auto24 link or enters details manually, and the app captures details and photos.
- The listing dashboard (`/[locale]/a/[jobId]`) shows capture and review progress. The report (`/[locale]/r/[publicId]`) is what the buyer reads.
- Supplements such as notes, seller answers, screenshots, photos, and PDFs start a new run at the same report URL.
- A report is used at home before the viewing and on a phone during it. See [saved reports offline](docs/how-it-works.md#saved-reports-offline) for offline access.

## Capabilities and Constraints

- Report access comes from a private token exchanged for an HttpOnly cookie. Shared caching is disabled.
- See [background check PDFs](docs/how-it-works.md#background-check-pdfs) for PDF limits and how fetched and manually uploaded PDFs count as evidence.
- Stack: Next.js 16 with next-intl, Supabase, a separate worker, and an extraction service.

## Brand Commitments

- The product name is Kontroll.
- Every surface ships in Estonian and English. Estonian is primary.

## Evidence on Hand

- Real reports exist, such as the October 3 Passat report in the checkpoint 2 analysis.
- Humans have not yet validated model quality. Reviewer grading so far is AI-only and used synthetic listings. Do not claim accuracy, benchmarks, or user testimonials.

## Product Principles

1. Base conclusions on the evidence provided, and say where each one comes from.
2. Help the buyer decide whether a car is worth a trip and what to ask at the viewing.
3. Make each update a fresh run on the same report, so the buyer keeps one place to look.
4. Treat Estonian and English as equal deliverables, never as an afterthought.
