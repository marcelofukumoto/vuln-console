<script setup lang="ts">
// Dependabot alerts over time.
//
// The boards answer "what is actionable today". This answers "are we winning", which needs a
// different shape: seven years of weekly buckets, and enough control to ask it of one
// repository or of the estate.
//
// Drawn as SVG rather than with a chart library. Stacks, bars and lines over ~360 points are
// arithmetic, and a library would put megabytes into a bundle the dashboard loads on every
// page - the same trade-off the sibling console's pipeline drawing makes.
import { computed, onMounted, ref } from 'vue';
import Banner from '@components/Banner/Banner.vue';
import { SEVERITIES, readHistory } from '../lib/history';
import type { History, Severity } from '../lib/history';
import {
  MODES, RANGES, SEV_CHOICES, bucketsFor, linesFor,
} from '../lib/history-view';
import type { Mode, SevChoice } from '../lib/history-view';

const history = ref<History | null>(null);
const loading = ref(true);
const mode = ref<Mode>('area');
const range = ref<number>(365);
const sev = ref<SevChoice>('total');
const picked = ref<Set<string>>(new Set());
const hover = ref<number | null>(null);
const showTable = ref(false);

onMounted(async() => {
  history.value = await readHistory().catch(() => null);
  picked.value = new Set(Object.keys(history.value?.repos || {}));
  loading.value = false;
});

/** Every charted repository, in a stable order - which is also the colour order. */
const allRepos = computed(() => Object.keys(history.value?.repos || {}).sort());
const repos = computed(() => allRepos.value.filter((r) => picked.value.has(r)));

/** Repositories grouped the way the team lists them, so the picker is scannable. */
const grouped = computed(() => {
  const out: Record<string, string[]> = {};

  for (const r of allRepos.value) {
    const c = history.value!.repos[r].category || 'Other';

    (out[c] = out[c] || []).push(r);
  }

  return out;
});

function toggle(repo: string) {
  const next = new Set(picked.value);

  if (next.has(repo)) {
    next.delete(repo);
  } else {
    next.add(repo);
  }
  picked.value = next;
}

const from = computed(() => {
  const total = history.value?.dates.length || 0;

  return total - bucketsFor(range.value, history.value?.bucket_days || 7, total);
});

const dates = computed(() => (history.value?.dates || []).slice(from.value));

/** The severity bands to stack: all four, or the one asked for. */
const bands = computed<Severity[]>(() => (sev.value === 'total' ? [...SEVERITIES] : [sev.value as Severity]));

/** Stacked severity totals across the chosen repositories. */
const stacked = computed(() => {
  if (!history.value) {
    return {} as Record<Severity, number[]>;
  }

  const out = {} as Record<Severity, number[]>;

  for (const s of bands.value) {
    out[s] = dates.value.map((_, i) => repos.value.reduce(
      (sum, r) => sum + (history.value!.repos[r][s][from.value + i] || 0), 0,
    ));
  }

  return out;
});

const lines = computed(() => (history.value ? linesFor(history.value, repos.value, sev.value, from.value) : []));

// ── geometry ────────────────────────────────────────────────────────────────────────────────
const W = 720;
const H = 250;
const PAD = {
  l: 46, r: 14, t: 12, b: 26,
};

const peak = computed(() => {
  let top = 1;

  if (mode.value === 'lines') {
    for (const l of lines.value) {
      top = Math.max(top, ...l.values);
    }
  } else {
    dates.value.forEach((_, i) => {
      top = Math.max(top, bands.value.reduce((sum, s) => sum + (stacked.value[s]?.[i] || 0), 0));
    });
  }

  return top;
});

const x = (i: number) => PAD.l + (i / Math.max(1, dates.value.length - 1)) * (W - PAD.l - PAD.r);
const y = (v: number) => H - PAD.b - (v / peak.value) * (H - PAD.t - PAD.b);
const step = computed(() => (W - PAD.l - PAD.r) / Math.max(1, dates.value.length));

/** The stack as polygons, most severe on the baseline - a band is read best against the axis. */
const areas = computed(() => {
  const running = dates.value.map(() => 0);

  return bands.value.map((severity) => {
    const lower = [...running];

    dates.value.forEach((_, i) => {
      running[i] += stacked.value[severity]?.[i] || 0;
    });

    const top = dates.value.map((_, i) => `${ x(i) },${ y(running[i]) }`);
    const back = dates.value.map((_, i) => dates.value.length - 1 - i).map((i) => `${ x(i) },${ y(lower[i]) }`);

    return { severity, points: [...top, ...back].join(' ') };
  });
});

/** The same stack as columns. A 2px gap is dropped when a column is not 3px wide. */
const columns = computed(() => {
  const out: { severity: Severity; x: number; y: number; h: number; w: number }[] = [];
  const w = Math.max(1, step.value - (step.value > 3 ? 2 : 0));

  dates.value.forEach((_, i) => {
    let base = 0;

    for (const severity of bands.value) {
      const v = stacked.value[severity]?.[i] || 0;

      if (v > 0) {
        out.push({
          severity, x: x(i) - w / 2, y: y(base + v), h: Math.max(1, y(base) - y(base + v)), w,
        });
      }

      base += v;
    }
  });

  return out;
});

const polylines = computed(() => lines.value.map((l) => ({
  repo:   l.repo,
  slot:   allRepos.value.indexOf(l.repo),
  points: l.values.map((v, i) => `${ x(i) },${ y(v) }`).join(' '),
  end:    l.values.length ? { x: x(l.values.length - 1), y: y(l.values[l.values.length - 1]) } : null,
})));

const yTicks = computed(() => {
  const s = Math.max(1, Math.ceil(peak.value / 4 / 10) * 10);

  return [0, s, s * 2, s * 3, s * 4].filter((v) => v <= peak.value * 1.15);
});

const xTicks = computed(() => {
  const short = dates.value.length <= 80;
  const seen = new Set<string>();

  return dates.value.map((d, i) => ({ d, i })).filter(({ d }) => {
    const key = short ? d.slice(0, 7) : d.slice(0, 4);

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);

    return true;
  }).map(({ d, i }) => ({ i, label: short ? d.slice(5, 7) + '/' + d.slice(2, 4) : d.slice(0, 4) }));
});

const totalAt = (i: number) => bands.value.reduce((sum, s) => sum + (stacked.value[s]?.[i] || 0), 0);
const latest = computed(() => (dates.value.length ? totalAt(dates.value.length - 1) : 0));

function nearest(event: MouseEvent) {
  const box = (event.currentTarget as SVGElement).getBoundingClientRect();
  const px = ((event.clientX - box.left) / box.width) * W;
  const i = Math.round(((px - PAD.l) / (W - PAD.l - PAD.r)) * (dates.value.length - 1));

  hover.value = Math.min(dates.value.length - 1, Math.max(0, i));
}

/** What the tooltip lists: severities when stacked, the busiest repositories when lines. */
const hoverRows = computed(() => {
  if (hover.value === null) {
    return [];
  }

  if (mode.value === 'lines') {
    return [...lines.value]
      .map((l) => ({ key: l.repo, slot: allRepos.value.indexOf(l.repo), value: l.values[hover.value!] || 0 }))
      .sort((a, b) => b.value - a.value).slice(0, 6);
  }

  return bands.value.map((s) => ({ key: s, slot: -1, value: stacked.value[s]?.[hover.value!] || 0 }));
});

const tableRows = computed(() => dates.value.map((d, i) => ({
  d,
  cells: mode.value === 'lines'
    ? lines.value.map((l) => l.values[i] || 0)
    : bands.value.map((s) => stacked.value[s]?.[i] || 0),
  total: mode.value === 'lines' ? lines.value.reduce((s, l) => s + (l.values[i] || 0), 0) : totalAt(i),
})).slice(-12).reverse());

const tableHead = computed(() => (mode.value === 'lines' ? lines.value.map((l) => l.repo) : bands.value));
</script>

<template>
  <div class="hist">
    <div v-if="loading" class="hist__empty">
      Loading the history…
    </div>

    <Banner v-else-if="!history" color="info">
      No history has been gathered yet. It is rebuilt daily from each repository's Dependabot
      alerts; until the first run there is nothing to plot.
    </Banner>

    <div v-else class="hist__layout">
      <div class="hist__main">
        <div class="hist__head">
          <span class="hist__now"><strong>{{ latest }}</strong> open now</span>
          <span class="hist__scope">
            {{ repos.length }} of {{ allRepos.length }} repositories ·
            {{ sev === 'total' ? 'all severities' : sev }}
          </span>
        </div>

        <svg
          class="hist__svg"
          :viewBox="`0 0 ${ W } ${ H }`"
          role="img"
          :aria-label="`Open Dependabot alerts over time, ${ mode }`"
          @mousemove="nearest"
          @mouseleave="hover = null"
        >
          <g class="hist__grid">
            <line v-for="t in yTicks" :key="`g${ t }`" :x1="PAD.l" :x2="W - PAD.r" :y1="y(t)" :y2="y(t)" />
          </g>
          <g class="hist__axis">
            <text v-for="t in yTicks" :key="`y${ t }`" class="is-y" :x="PAD.l - 6" :y="y(t) + 3">{{ t }}</text>
            <text v-for="t in xTicks" :key="`x${ t.i }`" class="is-x" :x="x(t.i)" :y="H - 8">{{ t.label }}</text>
          </g>

          <polygon
            v-for="a in (mode === 'area' ? areas : [])"
            :key="`a-${ a.severity }`"
            :points="a.points"
            :class="['hist__band', `is-${ a.severity }`]"
          />

          <rect
            v-for="(c, n) in (mode === 'bars' ? columns : [])"
            :key="`c${ n }`"
            :x="c.x" :y="c.y" :width="c.w" :height="c.h"
            :class="['hist__col', `is-${ c.severity }`]"
          />

          <template v-if="mode === 'lines'">
            <polyline
              v-for="l in polylines"
              :key="`l-${ l.repo }`"
              :points="l.points"
              class="hist__line"
              :style="{ stroke: `var(--series-${ Math.min(l.slot, 8) })` }"
            />
            <!-- Direct labels while they fit; past four the legend carries identity. -->
            <text
              v-for="l in (polylines.length <= 4 ? polylines : [])"
              :key="`t-${ l.repo }`"
              class="hist__line-label"
              :x="l.end.x - 4" :y="l.end.y - 5"
              :style="{ fill: `var(--series-${ Math.min(l.slot, 8) })` }"
            >{{ l.repo.split('/')[1] }}</text>
          </template>

          <g v-if="hover !== null && dates.length" class="hist__cross">
            <line :x1="x(hover)" :x2="x(hover)" :y1="PAD.t" :y2="H - PAD.b" />
          </g>
        </svg>

        <div class="hist__tip">
          <template v-if="hover !== null && dates.length">
            <strong>{{ dates[hover] }}</strong>
            <span v-for="r in hoverRows" :key="r.key" class="hist__tip-item">
              <i
                class="hist__swatch"
                :class="r.slot < 0 ? `is-${ r.key }` : ''"
                :style="r.slot >= 0 ? { background: `var(--series-${ Math.min(r.slot, 8) })` } : {}"
              />{{ r.slot >= 0 ? r.key.split('/')[1] : r.key }} {{ r.value }}
            </span>
            <span v-if="mode !== 'lines'" class="hist__tip-total">total {{ totalAt(hover) }}</span>
          </template>
          <span v-else class="hist__hint">Hover the chart for a week's numbers.</span>
        </div>

        <ul v-if="mode !== 'lines'" class="hist__legend">
          <li v-for="s in bands" :key="s">
            <i class="hist__swatch" :class="`is-${ s }`" />{{ s }}
          </li>
        </ul>
        <ul v-else class="hist__legend">
          <li v-for="l in polylines" :key="l.repo">
            <i class="hist__swatch" :style="{ background: `var(--series-${ Math.min(l.slot, 8) })` }" />{{ l.repo }}
          </li>
        </ul>

        <button type="button" class="hist__toggle" @click="showTable = !showTable">
          {{ showTable ? 'Hide' : 'Show' }} the numbers
        </button>

        <div v-if="showTable" class="hist__table-wrap">
          <table class="hist__table">
            <thead>
              <tr><th>week of</th><th v-for="h in tableHead" :key="h">{{ h }}</th><th>total</th></tr>
            </thead>
            <tbody>
              <tr v-for="row in tableRows" :key="row.d">
                <td>{{ row.d }}</td>
                <td v-for="(c, n) in row.cells" :key="n">{{ c }}</td>
                <td><strong>{{ row.total }}</strong></td>
              </tr>
            </tbody>
          </table>
        </div>

        <p class="hist__foot">
          Rebuilt daily from each alert's own lifecycle, so this is history rather than a log of
          snapshots. Gathered {{ history.generated_at.slice(0, 10) }}.
          <template v-if="history.skipped.length">
            {{ history.skipped.length }} repositories are not charted — the token cannot read
            their alerts.
          </template>
        </p>
      </div>

      <!-- Every option in one column, so the chart is never re-laid-out by a filter appearing. -->
      <aside class="hist__panel">
        <section>
          <h4>Chart</h4>
          <label v-for="m in MODES" :key="m.id" :title="m.hint">
            <input v-model="mode" type="radio" :value="m.id" >{{ m.label }}
          </label>
        </section>

        <section>
          <h4>Range</h4>
          <label v-for="r in RANGES" :key="r.id">
            <input v-model="range" type="radio" :value="r.id" >{{ r.label }}
          </label>
        </section>

        <section>
          <h4>Severity</h4>
          <label v-for="s in SEV_CHOICES" :key="s">
            <input v-model="sev" type="radio" :value="s" >{{ s }}
          </label>
        </section>

        <section>
          <h4>
            Repositories
            <span class="hist__bulk">
              <button type="button" @click="picked = new Set(allRepos)">all</button>
              <button type="button" @click="picked = new Set()">none</button>
            </span>
          </h4>
          <template v-for="(list, category) in grouped" :key="category">
            <p class="hist__cat">{{ category }}</p>
            <label v-for="r in list" :key="r" class="hist__repo" :title="r">
              <input type="checkbox" :checked="picked.has(r)" @change="toggle(r)" >
              <i class="hist__swatch" :style="{ background: `var(--series-${ Math.min(allRepos.indexOf(r), 8) })` }" />
              {{ r.split('/')[1] }}
            </label>
          </template>
        </section>
      </aside>
    </div>
  </div>
</template>

<style lang="scss" scoped>
/**
 * Two palettes, both from the documented set, both validated.
 *
 * SEVERITY is ordinal - one hue, light to dark, darkest most severe. The status palette was
 * tried first and failed: warning yellow against serious orange measures ΔE 13.6 for normal
 * vision, under the 15 floor, and they would have been adjacent bands.
 *
 * REPOSITORIES are categorical - eight slots in a fixed order, assigned by which repository it
 * is rather than by its position among the selected, so a filter never repaints the survivors.
 * A ninth repository takes the muted ink and is named in the legend: a generated ninth hue is
 * one nobody can name. Three light slots sit under 3:1, so the relief rule applies - hence the
 * direct labels and the table.
 *
 * Dark mode has its own steps for both, not a flip: the light severity ramp's darkest step
 * measures 1.50:1 on the dark surface and would vanish into it.
 */
.hist {
  --sev-low: #dd8b7c;
  --sev-medium: #c85a45;
  --sev-high: #a5301f;
  --sev-critical: #701608;
  --series-0: #2a78d6;
  --series-1: #eb6834;
  --series-2: #1baf7a;
  --series-3: #eda100;
  --series-4: #e87ba4;
  --series-5: #008300;
  --series-6: #4a3aa7;
  --series-7: #e34948;
  --series-8: var(--muted);
}

@mixin dark-series {
  --sev-low: #f5c4b8;
  --sev-medium: #e8917d;
  --sev-high: #d15f48;
  --sev-critical: #ad4229;
  --series-0: #3987e5;
  --series-1: #d95926;
  --series-2: #199e70;
  --series-3: #c98500;
  --series-4: #d55181;
  --series-5: #008300;
  --series-6: #9085e9;
  --series-7: #e66767;
}

:root:not([data-theme="light"]) {
  @media (prefers-color-scheme: dark) {
    .hist { @include dark-series; }
  }
}

:root[data-theme="dark"] .hist { @include dark-series; }

.hist__layout {
  display: flex;
  gap: 20px;
  align-items: flex-start;
}

.hist__main {
  flex: 1;
  min-width: 0;
}

.hist__panel {
  flex: none;
  width: 212px;
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 10px 12px;
  font-size: 12px;
  max-height: 560px;
  overflow-y: auto;

  section + section {
    margin-top: 14px;
    border-top: 1px solid var(--border);
    padding-top: 10px;
  }

  h4 {
    margin: 0 0 6px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--muted);
    display: flex;
    justify-content: space-between;
  }

  label {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 1px 0;
    cursor: pointer;
    text-transform: capitalize;
  }
}

.hist__bulk button {
  border: none;
  background: none;
  padding: 0 0 0 8px;
  color: var(--link);
  cursor: pointer;
  font-size: 11px;
  text-transform: none;
}

.hist__cat {
  margin: 8px 0 2px;
  font-size: 10px;
  color: var(--muted);
}

.hist__repo {
  text-transform: none !important;
  overflow: hidden;
  white-space: nowrap;
}

.hist__head {
  display: flex;
  align-items: baseline;
  gap: 14px;
  margin-bottom: 4px;
}

.hist__now strong {
  font-size: 20px;
}

.hist__now,
.hist__scope {
  font-size: 12px;
  color: var(--muted);
}

.hist__svg {
  display: block;
  width: 100%;
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
.hist__axis .is-y { text-anchor: end; }
.hist__axis .is-x { text-anchor: middle; }

.hist__band,
.hist__col {
  stroke: var(--body-bg);
  stroke-width: 2;

  &.is-critical { fill: var(--sev-critical); }
  &.is-high { fill: var(--sev-high); }
  &.is-medium { fill: var(--sev-medium); }
  &.is-low { fill: var(--sev-low); }
}

.hist__col {
  stroke-width: 0;
}

.hist__line {
  fill: none;
  stroke-width: 2;
}

.hist__line-label {
  font-size: 9px;
  text-anchor: end;
}

.hist__cross line {
  stroke: var(--body-text);
  stroke-width: 1;
  opacity: 0.4;
}

.hist__tip {
  font-size: 12px;
  min-height: 22px;
  margin: 6px 0 0;
  display: flex;
  gap: 12px;
  align-items: center;
  flex-wrap: wrap;
}

.hist__hint,
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
  flex: none;

  &.is-critical { background: var(--sev-critical); }
  &.is-high { background: var(--sev-high); }
  &.is-medium { background: var(--sev-medium); }
  &.is-low { background: var(--sev-low); }
}

.hist__legend {
  list-style: none;
  display: flex;
  gap: 14px;
  padding: 0;
  margin: 8px 0 0;
  font-size: 12px;
  flex-wrap: wrap;
  text-transform: capitalize;
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

.hist__table-wrap {
  overflow-x: auto;
  max-width: 100%;
}

.hist__table {
  margin-top: 8px;
  font-size: 11px;
  border-collapse: collapse;
  white-space: nowrap;

  th,
  td { padding: 2px 10px 2px 0; text-align: left; }

  th { color: var(--muted); font-weight: 400; }
}

.hist__foot,
.hist__empty {
  font-size: 12px;
  color: var(--muted);
  margin-top: 12px;
}
</style>
