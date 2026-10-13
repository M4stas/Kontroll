import type { AnalysisReport } from '@/domain/analysis';

export function vehicleTitle(report: AnalysisReport): string {
  return report.vehicleFacts.find(fact => fact.key === 'make_model')?.value.trim() ||
    ['make', 'model'].flatMap(key => {
      const value = report.vehicleFacts.find(fact => fact.key === key)?.value.trim();
      return value ? [value] : [];
    }).join(' ');
}
