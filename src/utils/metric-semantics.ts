// Speed Index is a composite visual-progress score (area above the render curve,
// WebPageTest methodology), NOT elapsed time. A delta of N SI does NOT mean the
// screen rendered N ms sooner — it means cumulative rendering quality across the
// whole render window improved. Surface this everywhere the metric appears (v42).
export const SPEED_INDEX_SEMANTICS =
  'area above the visual-progress curve (WebPageTest methodology); a lower value means content was visible ' +
  'more completely earlier across the render window. A delta is NOT a shift in render-completion time.';
export const SPEED_INDEX_SEMANTICS_SHORT = 'area above the visual-progress curve; lower = content visible earlier';

/**
 * Attached to the JSON of every tool that returns Speed Index values. The meaning used to live only in the
 * compare tool's payload and in tool DESCRIPTIONS — so an agent reading list/summary/trend data (or seeing only a
 * placeholder description under MCP_TOOLSETS) had nothing in the data saying "not milliseconds". The fidelity eval
 * caught exactly that on 2026-10-09: in core mode an agent reported "Avg SI 4,450 ms … Over 2s".
 */
export const METRIC_SEMANTICS = {
  speedIndex: {
    isCompositeMetric: true,
    unit: 'SI',
    notADuration: true,
    meaning: SPEED_INDEX_SEMANTICS,
    reportAs: 'Report Speed Index values as "SI" (e.g. "1,240 SI"), never ms or seconds; a Speed Index target is a score, not a time.',
  },
  duration: { unit: 'ms', meaning: 'Wall-clock length of the transaction window.' },
} as const;
