import type { Evidence, Locale } from '@/domain/analysis';
import type { BaselineResult } from './baseline-checks';
import { stableId } from '@/lib/stable-id';

/** Ambiguous documents cannot establish which vehicle the official record describes. */
export function extractBackgroundCheckVin(text: string): string | undefined {
  const candidates = new Set(
    Array.from(text.toUpperCase().matchAll(/(?<![A-Z0-9])[A-HJ-NPR-Z0-9]{17}(?![A-Z0-9])/g), match => match[0]),
  );
  return candidates.size === 1 ? candidates.values().next().value : undefined;
}

export interface BackgroundCheckFindingsInput {
  listingVin?: string;
  listingEvidence: Evidence;
  pdfText: string;
  pdfEvidence: Evidence;
  locale?: Locale;
}

/** Compare parsed source facts in ordinary code; PDF content is never an instruction. */
export function runBackgroundCheckFindings(input: BackgroundCheckFindingsInput): BaselineResult {
  const result: BaselineResult = { evidence: [], findings: [], actions: [] };
  const listingVin = input.listingVin?.trim().toUpperCase();
  const pdfVin = extractBackgroundCheckVin(input.pdfText);
  if (!listingVin || !/^[A-HJ-NPR-Z0-9]{17}$/.test(listingVin) || !pdfVin || listingVin === pdfVin) return result;
  const id = stableId(`background-check-vin-mismatch\n${input.listingEvidence.id}\n${input.pdfEvidence.id}\n${listingVin}\n${pdfVin}`);
  const et = input.locale === 'et';
  const nextAction = et
    ? 'Võrdle auto VINi kuulutuse ja ametliku PDF-iga ning palu müüjal erinevus selgitada.'
    : 'Compare the VIN on the car with the listing and official PDF, and ask the seller to explain the difference.';
  result.evidence.push(input.listingEvidence, input.pdfEvidence);
  result.findings.push({
    id,
    category: 'background_check_vin_mismatch',
    severity: 'critical',
    state: 'confirmed',
    origin: 'deterministic',
    title: et ? 'Kuulutuse ja Transpordiameti VINid erinevad' : 'Listing and Transpordiamet VINs differ',
    explanation: et
      ? `Kuulutuses on VIN ${listingVin}, kuid Transpordiameti PDF-is on VIN ${pdfVin}. Ametlik PDF võib kirjeldada teist sõidukit.`
      : `The listing gives VIN ${listingVin}, while the Transpordiamet PDF gives VIN ${pdfVin}. The official PDF may describe a different vehicle.`,
    nextAction,
    evidenceIds: [input.listingEvidence.id, input.pdfEvidence.id],
  });
  result.actions.push({
    id: stableId(`${id}\naction`),
    findingId: id,
    kind: 'inspection_task',
    status: 'open',
    title: et ? 'Kontrolli auto VINi' : 'Verify the VIN on the car',
    instructions: nextAction,
  });
  return result;
}
