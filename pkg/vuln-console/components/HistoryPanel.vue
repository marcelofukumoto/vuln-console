<script setup lang="ts">
// Dependabot alerts over time.
//
// The boards answer "what is actionable today". This answers "are we winning", which is a
// different question and needs a different shape: seven years of weekly buckets, stacked by
// severity, for one repository or the whole estate.
//
// Drawn as SVG rather than with a chart library. Four bands over ~360 points is arithmetic, and
// a library would add megabytes to a bundle the dashboard loads on every page - the same
// trade-off the pipeline drawing makes in the sibling console.
import { computed, onMounted, ref } from 'vue';
import Banner from '@components/Banner/Banner.vue';
import { SEVERITIES, peakOf, readHistory, seriesFor } from '../lib/history';
import type { History, Severity } from '../lib/history';

const history = ref<History | null>(null);
const loading = ref(true);
const repo = ref('all');
const hover = ref<number | null>(null);
const showTable = ref(false);

/** The x extent to draw. A seven-year default buries the last six months. */
const WINDOWS: { id: string; label: string; buckets: number }[] = [
  { id: '1y', label: '1 year', buckets: 52 },
  { id: '3y', label: '3 years', buckets: 156 },
  { id: 'all', label: 'All', buckets: 9999 },
];
const window_ = ref('1y');

onMounted(async() => {
  history.value = await readHistory().catch(() => null);
  loading.value = false;
});

const repos = computed(() => Object.keys(history.value?.repos || {}).sort());

/** Everything after this index is drawn; before it is out of the chosen window. */
const from = computed(() => {
  const total = history.value?.dates.length || 0;
  const want = WINDOWS.find((w) => w.id === window_.value)?.buckets || total;

  return Math.max(0, total - want);
});

const dates = computed(() => (history.value?.dates || []).slice(from.value));
const series = computed(() => {
  if (!history.value) {
    return null;
  }

  const full = seriesFor(history.value, repo.value);

  return Object.fromEntries(SEVERITIES.map((s) => [s, full[s].slice(from.value)])) as Record<Severity, number[]>;
});

// ── geometry ────────────────────────────────────────────────────────────────────────────────
const W = 760;
const H = 260;
const PAD = { l: 44, r: 12, t: 12, b: 26 };

const peak = computed(() => (series.value ? Math.max(1, peakOf(series.value, dates.value.length)) : 1));
const x = (i: number) => PAD.l + (i / Math.max(1, dates.value.length - 1)) * (W - PAD.l - PAD.r);
const y = (v: number) => H - PAD.b - (v / peak.value) * (H - PAD.t - PAD.b);

/**
 * The stack, most severe at the baseline.
 *
 * Critical sits on the axis because a band is read most accurately against the baseline, and
 * critical is the number anybody actually came here for.
 */
const bands = computed(() => {
  if (!series.value) {
    return [];
  }

  const running = dates.value.map(() => 0);

  return SEVERITIES.map((severity) => {
    const lower = [...running];

    dates.value.forEach((_, i) => {
      running[i] += series.value![severity][i] || 0;
    });

    const top = dates.value.map((_, i) => `${ x(i) },${ y(running[i]) }`);
    const bottom = lower.map((v, i) => `${ x(dates.value.length - 1 - i) },${ y(lower[dates.value.length - 1 - i]) }`);

    return { severity, points: [...top, ...bottom].join(' ') };
  });
});

/** Four ticks, on round numbers rather than on the peak. */
const yTicks = computed(() => {
  const step = Math.max(1, Math.ceil(peak.value / 4 / 10) * 10);

  return [0, step, step * 2, step * 3, step * 4].filter((v) => v <= peak.value * 1.15);
});

/**
 * Enough labels to place a point in time, never enough to smear.
 *
 * 360 dates would be grey mush, and a year of weekly buckets labelled only where the year
 * turns is two labels - so the unit follows the window: quarters when it is short, years when
 * it is long.
 */
const xTicks = computed(() => {
  const short = dates.value.length <= 80;
  const seen = new Set<string>();

  return dates.value.map((d, i) => ({ d, i })).filter(({ d }) => {
    const key = short ? `${ d.slice(0, 4) }-Q${ Math.floor(Number(d.slice(5, 7)) / 3.1) }` : d.slice(0, 4);

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);

    return true;
  }).map(({ d, i }) => ({ i, label: short ? `${ d.slice(0, 7) }` : d.slice(0, 4) }));
});

const totalAt = (i: number) => SEVERITIES.reduce((sum, s) => sum + (series.value?.[s][i] || 0), 0);
const latest = computed(() => (dates.value.length ? totalAt(dates.value.length - 1) : 0));

function nearest(event: MouseEvent) {
  const box = (event.currentTarget as SVGElement).getBoundingClientRect();
  const px = ((event.clientX - box.left) / box.width) * W;
  const i = Math.round(((px - PAD.l) / (W - PAD.l - PAD.r)) * (dates.value.length - 1));

  hover.value = Math.min(dates.value.length - 1, Math.max(0, i));
}

/** The last dozen buckets, for anybody who cannot read the chart. */
const tableRows = computed(() => dates.value
  .map((d, i) => ({
    d, i, total: totalAt(i), counts: SEVERITIES.map((s) => series.value?.[s][i] || 0),
  }))
  .slice(-12).reverse());
</script>

<template>
  <div class="hist">
    <div v-if="loading" class="hist__empty">
      Loading the history…
    </div>

    <Banner v-else-if="!history" color="info">
      No history has been gathered yet. It is rebuilt on a schedule from each repository's
      Dependabot alerts; until the first run there is nothing to plot.
    </Banner>

    <template v-else>
      <!-- Filters in one row above the chart. -->
      <div class="hist__filters">
        <label>
          <span class="hist__filter-label">Repository</span>
          <select v-model="repo" class="hist__select">
            <option value="all">All {{ repos.length }} repositories</option>
            <option v-for="r in repos" :key="r" :value="r">{{ r }}</option>
          </select>
        </label>
        <div class="hist__windows">
          <button
            v-for="w in WINDOWS"
            :key="w.id"
            type="button"
            :class="['hist__window', { 'is-on': window_ === w.id }]"
            @click="window_ = w.id"
          >{{ w.label }}</button>
        </div>
        <span class="hist__now">
          <strong>{{ latest }}</strong> open now
        </span>
      </div>

      <svg class="hist__svg" :viewBox="`0 0 ${ W } ${ H }`" role="img" aria-label="Open Dependabot alerts over time, stacked by severity" @mousemove="nearest" @mouseleave="hover = null">
        <!-- recessive grid -->
        <g class="hist__grid">
          <line v-for="t in yTicks" :key="`g${ t }`" :x1="PAD.l" :x2="W - PAD.r" :y1="y(t)" :y2="y(t)" />
        </g>
        <g class="hist__axis">
          <text v-for="t in yTicks" :key="`y${ t }`" class="is-y" :x="PAD.l - 6" :y="y(t) + 3">{{ t }}</text>
          <text v-for="t in xTicks" :key="`x${ t.i }`" class="is-x" :x="x(t.i)" :y="H - 8">{{ t.label }}</text>
        </g>

        <!-- The stack. A 2px surface-coloured stroke is the gap between bands. -->
        <polygon
          v-for="band in bands"
          :key="band.severity"
          :points="band.points"
          :class="['hist__band', `is-${ band.severity }`]"
        />

        <g v-if="hover !== null && dates.length" class="hist__cross">
          <line :x1="x(hover)" :x2="x(hover)" :y1="PAD.t" :y2="H - PAD.b" />
          <circle :cx="x(hover)" :cy="y(totalAt(hover))" r="3.5" />
        </g>
      </svg>

      <div v-if="hover !== null && dates.length" class="hist__tip">
        <strong>{{ dates[hover] }}</strong>
        <span v-for="s in SEVERITIES" :key="s" class="hist__tip-item">
          <i :class="['hist__swatch', `is-${ s }`]" />{{ s }} {{ series?.[s][hover] }}
        </span>
        <span class="hist__tip-total">total {{ totalAt(hover) }}</span>
      </div>
      <p v-else class="hist__hint">
        Hover the chart for a week's numbers.
      </p>

      <!-- Identity is never colour alone: a legend is always present. -->
      <ul class="hist__legend">
        <li v-for="s in SEVERITIES" :key="s">
          <i :class="['hist__swatch', `is-${ s }`]" />{{ s }}
        </li>
      </ul>

      <button type="button" class="hist__toggle" @click="showTable = !showTable">
        {{ showTable ? 'Hide' : 'Show' }} the numbers
      </button>

      <table v-if="showTable" class="hist__table">
        <thead>
          <tr>
            <th>week of</th><th v-for="s in SEVERITIES" :key="s">{{ s }}</th><th>total</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in tableRows" :key="row.d">
            <td>{{ row.d }}</td>
            <td v-for="(c, n) in row.counts" :key="n">{{ c }}</td>
            <td><strong>{{ row.total }}</strong></td>
          </tr>
        </tbody>
      </table>

      <p class="hist__foot">
        Rebuilt from each alert's own lifecycle, so the series is history rather than a log of
        snapshots. Gathered {{ history.generated_at.slice(0, 10) }}.
        <template v-if="history.skipped.length">
          {{ history.skipped.length }} repositories are not charted — the token cannot read their
          alerts.
        </template>
      </p>
    </template>
  </div>
</template>

<style lang="scss" scoped>
/**
 * The severity ramp is ORDINAL - one hue, light to dark, darkest most severe - not four
 * categorical hues. The status palette was tried first and failed validation: warning yellow
 * and serious orange measure ΔE 13.6 for normal vision, below the 15 floor, and they would
 * have been adjacent bands.
 *
 * Dark mode has its own steps rather than a flip: the light ramp's darkest step measures
 * 1.50:1 against the dark surface and would disappear into it.
 */
.hist {
  --sev-low: #dd8b7c;
  --sev-medium: #c85a45;
  --sev-high: #a5301f;
  --sev-critical: #701608;
}

:root:not([data-theme="light"]) {
  @media (prefers-color-scheme: dark) {
    .hist {
      --sev-low: #f5c4b8;
      --sev-medium: #e8917d;
      --sev-high: #d15f48;
      --sev-critical: #ad4229;
    }
  }
}

:root[data-theme="dark"] .hist {
  --sev-low: #f5c4b8;
  --sev-medium: #e8917d;
  --sev-high: #d15f48;
  --sev-critical: #ad4229;
}

.hist__filters {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}

.hist__filter-label {
  font-size: 11px;
  color: var(--muted);
  margin-right: 6px;
}

.hist__select {
  max-width: 320px;
}

.hist__windows {
  display: flex;
  gap: 4px;
}

.hist__window {
  border: 1px solid var(--border);
  background: none;
  border-radius: 4px;
  padding: 2px 10px;
  font-size: 12px;
  cursor: pointer;
  color: var(--body-text);

  &.is-on {
    border-color: var(--link);
    color: var(--link);
  }
}

.hist__now {
  margin-left: auto;
  font-size: 12px;
  color: var(--muted);

  strong {
    font-size: 18px;
    color: var(--body-text);
  }
}

.hist__svg {
  display: block;
  width: 100%;
  max-width: 900px;
}

.hist__grid line {
  stroke: var(--border);
  stroke-width: 1;
  opacity: 0.5;
}

.hist__axis text {
  font-size: 9px;
  fill: var(--muted);
}

/* Explicit, because `:first-of-type` anchored exactly one label and left the rest to collide. */
.hist__axis .is-y {
  text-anchor: end;
}

.hist__axis .is-x {
  text-anchor: middle;
}

.hist__band {
  stroke: var(--body-bg);
  stroke-width: 2;

  &.is-critical { fill: var(--sev-critical); }
  &.is-high { fill: var(--sev-high); }
  &.is-medium { fill: var(--sev-medium); }
  &.is-low { fill: var(--sev-low); }
}

.hist__cross line {
  stroke: var(--body-text);
  stroke-width: 1;
  opacity: 0.4;
}

.hist__cross circle {
  fill: var(--body-text);
}

.hist__tip,
.hist__hint {
  font-size: 12px;
  min-height: 20px;
  margin: 6px 0 0;
  display: flex;
  gap: 14px;
  align-items: center;
  flex-wrap: wrap;
}

.hist__hint {
  color: var(--muted);
}

.hist__tip-total {
  color: var(--muted);
}

.hist__swatch {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 2px;
  margin-right: 5px;
  vertical-align: -1px;

  &.is-critical { background: var(--sev-critical); }
  &.is-high { background: var(--sev-high); }
  &.is-medium { background: var(--sev-medium); }
  &.is-low { background: var(--sev-low); }
}

.hist__legend {
  list-style: none;
  display: flex;
  gap: 16px;
  padding: 0;
  margin: 10px 0 0;
  font-size: 12px;
}

.hist__toggle {
  border: none;
  background: none;
  padding: 0;
  margin-top: 10px;
  color: var(--link);
  cursor: pointer;
  font-size: 12px;
}

.hist__table {
  margin-top: 10px;
  font-size: 12px;
  border-collapse: collapse;

  th,
  td {
    padding: 2px 12px 2px 0;
    text-align: left;
  }

  th {
    color: var(--muted);
    font-weight: 400;
  }
}

.hist__foot,
.hist__empty {
  font-size: 12px;
  color: var(--muted);
  margin-top: 12px;
}
</style>
