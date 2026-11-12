import { useEffect, useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react';

// Spring motion, ported from the prototype (docs/design/QluePrint.dc.html, "physics"): named
// springs stepped by one shared requestAnimationFrame loop that stops when nothing is moving.
// Styles are written straight to elements, so a moving spring never re-renders React.

export type Motion = 'spring' | 'subtle' | 'off';
type Params = { k: number; c: number };
/** The default spring, a panel's content sliding in, and the Run button's pull toward the pointer */
type Variant = 'base' | 'enter' | 'magnetic';

/** Stiffness and damping per motion choice: 'spring' overshoots a little, 'subtle' is critically damped (c = 2√k) */
const params: Record<Exclude<Motion, 'off'>, Record<Variant, Params>> = {
    spring: { base: { k: 340, c: 24 }, enter: { k: 420, c: 26 }, magnetic: { k: 500, c: 20 } },
    subtle: { base: { k: 520, c: 46 }, enter: { k: 420, c: 41 }, magnetic: { k: 500, c: 45 } },
};

type Spring = {
    x: number;
    v: number;
    t: number;
    eps: number;
    variant: Variant;
    apply: (x: number, done: boolean) => void;
};

/** Semi-implicit Euler in 4 substeps; true once settled, with x snapped to the target */
function step(s: Spring, dt: number, { k, c }: Params): boolean {
    if (Math.abs(s.t - s.x) < s.eps && Math.abs(s.v) < s.eps) {
        s.x = s.t;
        s.v = 0;
        return true;
    }
    const h = dt / 4;
    for (let i = 0; i < 4; i++) {
        s.v += (-k * (s.x - s.t) - c * s.v) * h;
        s.x += s.v * h;
    }
    return false;
}

/** A CSS linear() easing that traces the same spring from 0 to 1, so CSS and JS motion feel alike */
function springEasing({ k, c }: Params, points = 40): string {
    const s: Spring = { x: 0, v: 0, t: 1, eps: 0.001, variant: 'base', apply: () => {} };
    const xs = [0];
    while (!step(s, 1 / 240, { k, c }) && xs.length < 2400) xs.push(s.x);
    xs.push(1);
    const stride = (xs.length - 1) / (points - 1);
    const out = Array.from({ length: points }, (_, i) => +xs[Math.round(i * stride)].toFixed(3));
    return `linear(${out.join(', ')})`;
}

const browser = typeof window !== 'undefined';
const reduced = browser ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
let preference: Motion = 'spring';

/** The motion in effect: the user's choice, or 'off' while the OS asks for reduced motion */
export function motion(): Motion {
    return reduced?.matches ? 'off' : preference;
}

/** Applies the motion choice: JS springs read it per frame, CSS reads data-motion and --spring-ease on <html> */
export function setMotion(choice: Motion) {
    preference = choice;
    const m = motion();
    document.documentElement.dataset.motion = m;
    if (m !== 'off') document.documentElement.style.setProperty('--spring-ease', springEasing(params[m].base));
}
reduced?.addEventListener('change', () => setMotion(preference));

const live = new Set<Spring>();
let raf = 0;

/** Snaps a spring to its target and stops stepping it */
function settle(s: Spring) {
    s.x = s.t;
    s.v = 0;
    live.delete(s);
}

export const clamp01 = (p: number) => Math.min(1, Math.max(0, p));

function kick() {
    if (raf) return;
    let last = performance.now();
    const frame = (now: number) => {
        // Capped so a stalled tab doesn't make a spring jump on its first frame back
        const dt = Math.min(0.034, (now - last) / 1000);
        last = now;
        const m = motion();
        for (const s of live) {
            const done = m === 'off' || step(s, dt, params[m][s.variant]);
            if (done) settle(s);
            s.apply(s.x, done);
        }
        raf = live.size ? requestAnimationFrame(frame) : 0;
    };
    raf = requestAnimationFrame(frame);
}

type Options = { from?: number; eps?: number; variant?: Variant };
/** A component's spring, made on the setter's first call */
type Box = { s: Spring | null; set: (target: number, v?: number) => void };

/**
 * A spring that calls `apply` each frame. Returns a stable setter: its first call snaps to the
 * target (unless `from` is given), later calls animate there. Stops with the component.
 */
export function useSpring(apply: (x: number, done: boolean) => void, { from, eps = 0.01, variant = 'base' }: Options = {}) {
    const ref = useRef<Box | null>(null);
    const latest = useRef(apply);
    useLayoutEffect(() => {
        latest.current = apply;
    });
    if (!ref.current) {
        const box: Box = {
            s: null,
            set: (target, v) => {
                let s = box.s;
                if (!s) {
                    s = box.s = {
                        x: from ?? target,
                        v: 0,
                        t: target,
                        eps,
                        variant,
                        apply: (x, done) => {
                            latest.current(x, done);
                        },
                    };
                    if (from === undefined) {
                        s.apply(target, true);
                        return;
                    }
                }
                if (v !== undefined) s.v = v;
                s.t = target;
                if (motion() === 'off') {
                    settle(s);
                    s.apply(target, true);
                    return;
                }
                live.add(s);
                kick();
            },
        };
        ref.current = box;
    }
    const box = ref.current;
    useEffect(
        () => () => {
            if (box.s) live.delete(box.s);
        },
        [box],
    );
    return box.set;
}

/**
 * Fades and slides an element in sideways on mount, then clears its styles so it holds no transform.
 * `skip` (read on mount) leaves it still, for content arriving inside something already moving
 */
export function useEnter(ref: RefObject<HTMLElement | null>, { x, skip = false }: { x: number; skip?: boolean }) {
    const enter = useSpring(
        (p, done) => {
            const el = ref.current;
            if (!el) return;
            el.style.opacity = done ? '' : String(clamp01(p));
            el.style.transform = done ? '' : `translateX(${(1 - p) * x}px)`;
        },
        { from: 0, eps: 0.001, variant: 'enter' },
    );
    useLayoutEffect(() => {
        if (!skip) enter(1);
    }, [enter]);
}

/** A div that slides in with `useEnter` on mount */
export function Enter({ x, skip, className, children }: { x: number; skip?: boolean; className?: string; children: ReactNode }) {
    const ref = useRef<HTMLDivElement>(null);
    useEnter(ref, { x, skip });
    return (
        <div ref={ref} className={className}>
            {children}
        </div>
    );
}

/** Two springs painted together (x and y, or position and width): `apply` gets both values each frame */
export function useSpring2(apply: (a: number, b: number) => void, options?: Options) {
    const at = useRef({ a: 0, b: 0 });
    const setA = useSpring((a) => {
        at.current.a = a;
        apply(a, at.current.b);
    }, options);
    const setB = useSpring((b) => {
        at.current.b = b;
        apply(at.current.a, b);
    }, options);
    return [setA, setB] as const;
}

/**
 * A sliding underline for a tab list: springs `indicator` under its parent list's active tab
 * ([data-state=active]). Re-measures when tabs switch, come, go or resize.
 */
export function useTabIndicator(indicator: RefObject<HTMLElement | null>, fill = false) {
    // A bar is 1px wide and scaled; a filled shape (a segmented control's knob) keeps its real width,
    // so its corners and shading don't stretch, and only slides
    const [setX, setW] = useSpring2((x, w) => {
        const el = indicator.current;
        if (!el) return;
        if (fill) {
            el.style.transform = `translateX(${x}px)`;
            el.style.width = `${Math.max(0, w)}px`;
        } else el.style.transform = `translateX(${x}px) scaleX(${Math.max(0, w)})`;
    });
    useLayoutEffect(() => {
        const el = indicator.current;
        const list = el?.parentElement;
        if (!el || !list) return;
        const measure = () => {
            const tab = list.querySelector<HTMLElement>('[role=tab][data-state=active]');
            el.style.opacity = tab ? '1' : '0';
            if (!tab) return;
            setX(tab.offsetLeft);
            setW(tab.offsetWidth);
        };
        measure();
        const resized = new ResizeObserver(measure);
        resized.observe(list);
        const changed = new MutationObserver(measure);
        changed.observe(list, { subtree: true, childList: true, characterData: true, attributeFilter: ['data-state'] });
        return () => {
            resized.disconnect();
            changed.disconnect();
        };
    }, [indicator, setX, setW]);
}
