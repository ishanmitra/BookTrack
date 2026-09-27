import { useLayoutEffect, useRef } from "react";

// Wrapper that animates its own height when the content inside it changes size —
// the jump you get when a skeleton is replaced by fetched rows.
//
// CSS can't do this on its own: `interpolate-size: allow-keywords` only
// interpolates between a <length-percentage> and an intrinsic keyword, never
// auto → auto, which is exactly what swapping a placeholder for real content is.
// So the natural height is measured and an explicit height is driven for the
// length of the transition. The whole dance runs in useLayoutEffect (before
// paint), so no intermediate state is ever painted — the box just starts at its
// old height and eases to the new one.
//
// The old height is NOT re-measured when the swap happens: by the time a layout
// effect runs, React has already committed the new children, so anything read off
// the element is the *new* height (from === to → instant snap, which is exactly
// what a naive version of this does). The start value therefore comes from the
// previous run's measurement, kept in a ref across renders.

const DURATION = 280;

const motionOff = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export function GrowBox({ children, className = "", duration = DURATION }) {
  const ref = useRef(null);
  const timer = useRef(0);
  const prev = useRef({ node: null, height: null, inFlight: false });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;

    const state = prev.current;
    // A remounted wrapper must not inherit the old node's height.
    if (state.node !== el) { state.node = el; state.height = null; state.inFlight = false; }

    // Start value: the previous content's height. Exception — if our own
    // transition is still running, the box sits somewhere between the two, and
    // that's the height to start from (read before touching `transition`, since
    // editing it cancels a running transition).
    const from = state.inFlight ? Math.round(el.getBoundingClientRect().height) : state.height;

    el.classList.add("grow-box-animating");
    el.style.transition = "none";
    el.style.height = "";
    const to = el.offsetHeight;

    const settle = () => {
      clearTimeout(timer.current);
      state.inFlight = false;
      el.style.height = "";
      el.style.transition = "";
      el.classList.remove("grow-box-animating");
    };

    state.height = to;

    // Nothing to animate: first paint, an unchanged size, or reduced motion.
    if (from == null || from === to || motionOff()) {
      settle();
      return () => clearTimeout(timer.current);
    }

    el.style.height = `${from}px`;
    void el.offsetHeight; // commit the start value before the transition goes on
    el.addEventListener("transitionend", settle, { once: true });
    el.style.transition = `height ${duration}ms ease-out`;
    el.style.height = `${to}px`;
    state.inFlight = true;
    timer.current = setTimeout(settle, duration + 80);

    return () => {
      clearTimeout(timer.current);
      el.removeEventListener("transitionend", settle);
    };
  });

  return <div ref={ref} className={`grow-box ${className}`.trim()}>{children}</div>;
}
