import { Telemetry } from '/imports/ui/Types/meetingClientSettings';
import {
  clearActionTrail,
  ReproTrail,
  reproTrail,
  startActionTrail,
} from './actionTrail';
import { getConfig, isTelemetryActive, loadConfig } from './config';
import startMainThreadObservers from './observers/mainThreadObserver';
import startResourceObserver from './observers/resourceObserver';
import { startPluginErrorCounter, startPluginOperationAttribution } from './plugins';
import {
  clearStore,
  configureStore,
  counterSnapshot,
  kindStats,
  seriesSnapshot,
  topSlowest,
} from './store';
import {
  CounterSnapshot,
  KindStats,
  SeriesSnapshot,
  TelemetryEntry,
  TelemetryKind,
} from './types';

// Client performance telemetry, configured by public.app.telemetry in settings.yml

const SLOWEST_PER_KIND = 20;

export interface TelemetryDump {
  enabled: boolean;
  config: Telemetry;
  stats: Record<TelemetryKind, KindStats>;
  slowest: Record<TelemetryKind, TelemetryEntry[]>;
  series: SeriesSnapshot[];
  counters: CounterSnapshot[];
}

const byKind = <T>(read: (kind: TelemetryKind) => T): Record<TelemetryKind, T> => ({
  render: read('render'),
  request: read('request'),
  graphql: read('graphql'),
  longtask: read('longtask'),
  interaction: read('interaction'),
  plugin: read('plugin'),
});

export const telemetryDump = (): TelemetryDump => ({
  enabled: isTelemetryActive(),
  config: getConfig(),
  stats: byKind(kindStats),
  slowest: byKind((kind) => topSlowest(kind, SLOWEST_PER_KIND)),
  series: seriesSnapshot(),
  counters: counterSnapshot(),
});

declare global {
  interface Window {
    bbbTelemetry?: {
      dump: () => TelemetryDump;
      stats: () => Record<TelemetryKind, KindStats>;
      trail: () => ReproTrail;
      clear: () => void;
    };
  }
}

let started = false;

// Discards measurements and the repro trail
export const clearTelemetry = (): void => {
  clearStore();
  clearActionTrail();
};

// Called once by settings-loader, right after window.meetingClientSettings is filled
export const startTelemetry = (): void => {
  if (started) return;
  started = true;

  const config = loadConfig();
  if (!isTelemetryActive()) return;

  // Only with telemetry on: any script on the page, plugins included, can read this global
  window.bbbTelemetry = {
    dump: telemetryDump,
    stats: () => byKind(kindStats),
    trail: reproTrail,
    clear: clearTelemetry,
  };
  configureStore(config.bufferSize);
  startResourceObserver();
  startMainThreadObservers();
  startActionTrail();
  startPluginErrorCounter();
  startPluginOperationAttribution();
  if (config.exporter === 'otlp') {
    // import() keeps the sink out of the startup path and becomes a real chunk if the build ever
    // allows more than one; today webpack inlines it (maxChunks: 1)
    import('./sinks/otlp')
      .then(({ default: startOtlpSink }) => startOtlpSink())
      .catch(() => {
        // Without the sink the data stays in the browser (debug window and console)
      });
  }
};

export { isTelemetryActive, reproTrail };
