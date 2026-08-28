'use strict';

/**
 * Timing for the effects that cross more than one screen.
 *
 * Everything here produces a delay in milliseconds **relative to when the node receives
 * the command**, never an absolute timestamp. SPEC.md §24 proposes a server-issued
 * `startAt` that each client animates against, which requires the laptops to agree about
 * the time. They do not: JARVIS-NET has no internet, therefore no NTP, and consumer
 * laptop clocks drift seconds apart. A cascade computed that way would not read as
 * staggered, it would read as broken. See DEVIATIONS.md D2.
 *
 * Relative delays trade one error source for another — network jitter instead of clock
 * skew — but LAN jitter on a quiet AP is around ten milliseconds, which is an order of
 * magnitude below what an audience can see, and it does not accumulate over the evening.
 */

let layout = { order: [], stepMs: 180, takeoverStepMs: 180, homeNode: 'MAIN' };

function init(config) {
  layout = {
    order: Array.isArray(config.order) ? config.order : [],
    stepMs: Number(config.stepMs) || 180,
    takeoverStepMs: Number(config.takeoverStepMs) || Number(config.stepMs) || 180,
    homeNode: config.homeNode || 'MAIN',
  };
  return layout;
}

function homeNode() {
  return layout.homeNode;
}

/**
 * Physical position of a node, left to right as the audience sees it.
 *
 * Unlisted nodes sort last. A machine someone added to nodes.json without updating the
 * layout should still animate; it just brings up the rear.
 */
function position(nodeId) {
  const index = layout.order.indexOf(nodeId);
  return index === -1 ? layout.order.length : index;
}

/**
 * Order a set of nodes for a sweep across the room.
 *
 * `reverse` runs right to left, which is what "come back" wants when JARVIS is returning
 * to MAIN from a node further down the table.
 */
function sweepOrder(nodeIds, reverse = false) {
  const ordered = [...nodeIds].sort((a, b) => position(a) - position(b));
  return reverse ? ordered.reverse() : ordered;
}

/**
 * Stagger for takeover(ALL) — SPEC.md §17.
 *
 * The spec's own example starts at MAIN and works outward, which is the right instinct:
 * the audience is looking at the main display when the presenter triggers it, so MAIN
 * moving first is what makes the rest read as propagation rather than as a slow load.
 *
 * Returns a Map of nodeId to delay in milliseconds.
 */
function takeoverStagger(nodeIds) {
  const step = layout.takeoverStepMs;
  const home = layout.homeNode;

  // MAIN first if it is in the set, then the rest in physical order.
  const rest = sweepOrder(nodeIds.filter((id) => id !== home));
  const sequence = nodeIds.includes(home) ? [home, ...rest] : rest;

  const delays = new Map();
  sequence.forEach((id, index) => delays.set(id, index * step));
  return delays;
}

/**
 * Stagger for a cascade — SPEC.md §24.
 *
 * Unlike takeover, this one strictly follows physical order, because the whole point is
 * that a beam appears to travel along the row of laptops. Each node also learns its
 * position and the total, so the overlay can aim its animation: the first node throws the
 * beam right, the last catches it, the ones between pass it through.
 */
function cascadePlan(nodeIds, reverse = false) {
  const sequence = sweepOrder(nodeIds, reverse);
  const step = layout.stepMs;

  return sequence.map((id, index) => ({
    nodeId: id,
    delayMs: index * step,
    position: index,
    total: sequence.length,
    entering: index === 0 ? 'none' : reverse ? 'right' : 'left',
    leaving: index === sequence.length - 1 ? 'none' : reverse ? 'left' : 'right',
  }));
}

/**
 * Plan a move — SPEC.md §22.
 *
 * Two nodes, two cues, one handover. The source plays its departure immediately; the
 * destination's arrival is held back just long enough that the orb reads as travelling
 * rather than duplicating. Nothing migrates; this is entirely visual choreography, as
 * the spec is careful to say.
 *
 * The gap is deliberately shorter than the departure animation so the two overlap
 * slightly. A clean handoff with no overlap looks like a cut; a slight overlap looks like
 * motion.
 */
const MOVE_DEPART_MS = 900;
const MOVE_OVERLAP_MS = 250;

function movePlan(fromNodeId, toNodeId) {
  const direction = position(toNodeId) > position(fromNodeId) ? 'right' : 'left';

  return {
    from: {
      nodeId: fromNodeId,
      delayMs: 0,
      scene: 'jarvis',
      transition: 'depart',
      direction,
      durationMs: MOVE_DEPART_MS,
    },
    to: {
      nodeId: toNodeId,
      delayMs: MOVE_DEPART_MS - MOVE_OVERLAP_MS,
      scene: 'jarvis',
      transition: 'arrive',
      // The destination sees the orb coming from the opposite side to the one it left by.
      direction: direction === 'right' ? 'left' : 'right',
      durationMs: MOVE_DEPART_MS,
    },
  };
}

/**
 * Stagger for a broadcast — "split yourself", SPEC.md §23.
 *
 * Near-simultaneous on purpose. The moment should land as one event across the room, so
 * this uses a fraction of the normal step: enough that the screens do not all flicker on
 * the same video frame, not enough to read as a sequence.
 */
function broadcastStagger(nodeIds) {
  const step = Math.round(layout.stepMs / 6);
  const delays = new Map();
  sweepOrder(nodeIds).forEach((id, index) => delays.set(id, index * step));
  return delays;
}

module.exports = {
  init,
  homeNode,
  position,
  sweepOrder,
  takeoverStagger,
  cascadePlan,
  movePlan,
  broadcastStagger,
  MOVE_DEPART_MS,
};
