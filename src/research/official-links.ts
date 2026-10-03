import type { NormalizedVehicle } from "@/analysis/normalize";
import type { VerificationState } from "@/domain/analysis";

export const TRANSPORT_ADMINISTRATION_CHECKER_URL =
  "https://eteenindus.mnt.ee/public/soidukTaustakontroll.jsf";

interface TransportAdministrationLink {
  label: string;
  url: string;
  verification: VerificationState;
  automation: "manual_only";
}

interface ManufacturerLink {
  label: string;
  url: string;
  verification: VerificationState;
  region?: string;
  regionalLimitation?: string;
}

export interface OfficialLinks {
  transportAdministration: TransportAdministrationLink;
  manufacturer?: ManufacturerLink;
}

const MANUFACTURER_LINKS: Record<string, ManufacturerLink> = {
  bmw: {
    label: "BMW Group recall information",
    url: "https://www.bmwgroup.com/en/general/regulations/recall/recall-english.html",
    verification: "not_checked",
  },
  volkswagen: {
    label: "Volkswagen recall information",
    url: "https://www.vw.com/en/owners-and-services/about-my-vehicle/recalls.html",
    verification: "not_checked",
    region: "US",
    regionalLimitation: "This is a US recall page; VIN applicability and local-market coverage require confirmation.",
  },
  volvo: {
    label: "Volvo recall information",
    url: "https://www.volvocars.com/us/l/recall/",
    verification: "not_checked",
    region: "US",
    regionalLimitation: "This is a US recall page; VIN applicability and local-market coverage require confirmation.",
  },
};

export function officialLinksFor(vehicle: NormalizedVehicle): OfficialLinks {
  const make = vehicle.make?.trim().toLocaleLowerCase("en");
  return {
    transportAdministration: {
      label: "Estonian Transport Administration vehicle background check",
      url: TRANSPORT_ADMINISTRATION_CHECKER_URL,
      verification: "not_checked",
      automation: "manual_only",
    },
    ...(make && MANUFACTURER_LINKS[make] ? { manufacturer: MANUFACTURER_LINKS[make] } : {}),
  };
}
