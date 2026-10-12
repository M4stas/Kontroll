import { ArmchairIcon, CarProfileIcon, GaugeIcon, GearSixIcon, IdentificationCardIcon, ListChecksIcon, MagnifyingGlassIcon } from "@phosphor-icons/react/dist/ssr";
import type { FindingGroup } from "../primary-findings";

export function AreaIcon({ group }: { group: FindingGroup | null }) {
  const Icon = group ? { mileage: GaugeIcon, bodywork: CarProfileIcon, mechanical: GearSixIcon, interior: ArmchairIcon, identity: IdentificationCardIcon, equipment: ListChecksIcon }[group] : MagnifyingGlassIcon;
  return <Icon data-area-icon={group ?? "other"} className="report-area-icon" aria-hidden="true" weight="thin" />;
}
