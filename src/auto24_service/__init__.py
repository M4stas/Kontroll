"""Public types and URL validation for the Auto24 extraction service."""

from .contracts import JobError, JobResponse, ListingResult
from .urls import InvalidListingURL, canonical_listing_url

__all__ = [
    "InvalidListingURL",
    "JobError",
    "JobResponse",
    "ListingResult",
    "canonical_listing_url",
]
