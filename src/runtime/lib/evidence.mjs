import { CliError, EXIT } from './output.mjs';

export const DATA_SOURCES = ['unknown', 'real-service', 'synthetic', 'mocked', 'mixed'];
export const INTERACTIONS = ['element-tap', 'text-tap', 'input', 'direct-method', 'programmatic-scroll',
  'sdk-touch-events', 'external-gesture-observed', 'read-only', 'raw-sdk-untracked'];
export const DEVICE_TYPES = ['unknown', 'devtools-simulator', 'android-device', 'ios-device'];

/** Declarations are provenance, not automatic certification of real data or device coverage. */
export function createEvidence(initial = {}) {
  const report = { schemaVersion: 1, dataSource: 'unknown', deviceType: 'unknown', device: null,
    interactions: [], declarations: [], uncovered: ['physical-gesture', 'android-device', 'ios-device'],
    notes: [], recordedAt: new Date().toISOString() };
  function declare(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CliError('evidence must be an object', { exitCode: EXIT.CONFIG, code: 'bad-evidence' });
    const allowed = ['dataSource', 'deviceType', 'uncovered', 'notes'];
    for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new CliError(`unknown evidence field ${key}`, { exitCode: EXIT.CONFIG, code: 'bad-evidence' });
    if (value.dataSource !== undefined && !DATA_SOURCES.includes(value.dataSource)) throw new CliError('invalid evidence dataSource', { exitCode: EXIT.CONFIG, code: 'bad-evidence' });
    if (value.deviceType !== undefined && !DEVICE_TYPES.includes(value.deviceType)) throw new CliError('invalid evidence deviceType', { exitCode: EXIT.CONFIG, code: 'bad-evidence' });
    for (const key of ['uncovered', 'notes']) if (value[key] !== undefined && (!Array.isArray(value[key]) || !value[key].every(v => typeof v === 'string'))) throw new CliError(`evidence ${key} must be a string array`, { exitCode: EXIT.CONFIG, code: 'bad-evidence' });
    if (value.dataSource) report.dataSource = ['mocked','mixed'].includes(report.dataSource) && value.dataSource !== 'mocked' ? 'mixed' : value.dataSource;
    // Preserve observed SDK platform; declarations cannot turn a simulator
    // capture into a claimed Android/iOS device run.
    if (value.deviceType && !report.device) report.deviceType = value.deviceType;
    if (value.deviceType && report.device && value.deviceType !== report.deviceType) {
      report.notes.push(`declared deviceType ${value.deviceType} differs from observed ${report.deviceType}; observation retained`);
    }
    if (value.notes) report.notes.push(...value.notes);
    if (value.uncovered) report.uncovered = [...new Set([...report.uncovered, ...value.uncovered])];
    report.declarations.push({ source: 'script-declared', ...value });
    return report;
  }
  function record(interaction, detail = {}) {
    if (!INTERACTIONS.includes(interaction)) throw new CliError(`invalid interaction classification ${interaction}`, { exitCode: EXIT.CONFIG, code: 'bad-evidence' });
    report.interactions.push({ ...detail, interaction, at: new Date().toISOString() });
    return report;
  }
  if (Object.keys(initial).length) declare(initial);
  return { report, declare, record };
}
