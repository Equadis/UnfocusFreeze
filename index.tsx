/*
 * FocusFreeze - a custom Vencord userplugin
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Freezes Discord's decorative animations on their current frame, either
 * always or only while the window is unfocused / hidden.
 *
 * Design rules:
 *  - Only pause what we found running, and resume only what we paused.
 *  - Only pause endless decorative loops. Finite animations and transitions
 *    (menus opening, hover fades) are left alone so the UI never sticks
 *    half-way.
 *  - Nothing in the page is hidden or removed. Animated images are swapped
 *    for a same-size canvas holding the current frame, in the same place in
 *    the layout, and swapped back on resume.
 */
import { definePluginSettings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";

const logger = new Logger("FocusFreeze");

type Category = "avatars" | "decorations" | "profileEffects" | "nameplates" | "roleColours" | "other";

const settings = definePluginSettings({
    mode: {
        description: "When should animations be frozen?",
        type: OptionType.SELECT,
        options: [
            { label: "Always disabled", value: "always" },
            { label: "Disabled when Discord is unfocused", value: "unfocused", default: true }
        ],
        onChange: () => update(true)
    },
    freezeAvatars: {
        description: "Freeze animated avatars (GIF / animated WebP)",
        type: OptionType.BOOLEAN,
        default: true,
        onChange: () => update(true)
    },
    freezeDecorations: {
        description: "Freeze avatar decorations",
        type: OptionType.BOOLEAN,
        default: true,
        onChange: () => update(true)
    },
    freezeProfileEffects: {
        description: "Freeze profile effects",
        type: OptionType.BOOLEAN,
        default: true,
        onChange: () => update(true)
    },
    freezeNameplates: {
        description: "Freeze nameplates and name styles",
        type: OptionType.BOOLEAN,
        default: true,
        onChange: () => update(true)
    },
    freezeRoleColours: {
        description: "Freeze animated role colours",
        type: OptionType.BOOLEAN,
        default: true,
        onChange: () => update(true)
    },
    freezeOther: {
        description: "Freeze other UI animations (endless CSS loops, looping muted videos, SVG)",
        type: OptionType.BOOLEAN,
        default: true,
        onChange: () => update(true)
    },
    pauseFrameLoops: {
        description: "Experimental: while unfocused, also halt JavaScript animation loops (canvas, WebGL, Lottie). "
            + "Only applies in \"unfocused\" mode, because stalling them permanently would break animated UI.",
        type: OptionType.BOOLEAN,
        default: false,
        onChange: () => update(true)
    },
    debug: {
        description: "Log what was frozen, per category, to the console each time freezing starts",
        type: OptionType.BOOLEAN,
        default: false
    },
    dumpReport: {
        type: OptionType.COMPONENT,
        component: () => (
            <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                <button onClick={() => runDump(0)}>Save diagnostics now</button>
                <button onClick={() => runDump(6000)}>Save diagnostics in 6s (switch windows first)</button>
            </div>
        )
    }
});

const CATEGORY_SETTING = {
    avatars: "freezeAvatars",
    decorations: "freezeDecorations",
    profileEffects: "freezeProfileEffects",
    nameplates: "freezeNameplates",
    roleColours: "freezeRoleColours",
    other: "freezeOther"
} as const satisfies Record<Category, keyof typeof settings.store>;

const isOn = (cat: Category) => !!settings.store[CATEGORY_SETTING[cat]];

// ---------------------------------------------------------------------------
// Classification. Discord class names are hashed ("avatarDecoration_a1b2c3"),
// so match on the stable prefix. Image/video URLs are checked first because
// they are the most reliable signal.
// ---------------------------------------------------------------------------

const URL_RULES: [Category, RegExp][] = [
    ["decorations", /avatar-decoration/i],
    ["nameplates", /nameplate|collectibles-shop\/[^?#]*\/video(?:[?#]|$)/i],
    ["profileEffects", /profile-effect|\/effects\//i],
    ["avatars", /\/avatars\/|\/embed\/avatars\//i]
];

const SELECTOR_RULES: [Category, string][] = [
    ["decorations", '[class*="avatarDecoration"]'],
    ["profileEffects", '[class*="profileEffect"]'],
    ["nameplates", '[class*="nameplate"], [class*="nameStyle"], [class*="displayNameStyle"]'],
    ["roleColours", '[class*="roleGradient"], [class*="gradientRole"]'],
    ["avatars", '[class*="avatar"]']
];

const NAME_HINT_RULES: [Category, RegExp][] = [
    ["roleColours", /gradient|role|shimmer/i],
    ["nameplates", /nameplate|namestyle|name-style/i],
    ["profileEffects", /profile-?effect/i]
];

function classify(el: Element, urlOrName = ""): Category {
    if (urlOrName) {
        for (const [cat, re] of URL_RULES) if (re.test(urlOrName)) return cat;
    }
    for (const [cat, sel] of SELECTOR_RULES) if (el.closest(sel)) return cat;
    if (urlOrName) {
        for (const [cat, re] of NAME_HINT_RULES) if (re.test(urlOrName)) return cat;
    }
    return "other";
}

// GIF, animated WebP (?animated=true), animated APNG decorations (a_ hash or
// passthrough=true), and Discord's animated-hash convention.
const ANIMATED_URL = /\.gif(?:[?#]|$)|\/animated(?:[?#]|$)|[?&]animated=true|[?&]passthrough=true|\/a_[0-9a-f]{8,}/i;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const pausedAnimations = new Set<Animation>();
const pausedVideos = new Set<HTMLVideoElement>();
const pausedSvgs = new Set<SVGSVGElement>();
const waitingForLoad = new WeakSet<HTMLImageElement>();
const stats: Record<Category, number> = { avatars: 0, decorations: 0, profileEffects: 0, nameplates: 0, roleColours: 0, other: 0 };

interface Snapshot {
    canvas: HTMLCanvasElement;
    displayValue: string;
    displayPriority: string;
}
const snapshots = new Map<HTMLImageElement, Snapshot>();

let active = false;
let frozen = false;
let observer: MutationObserver | undefined;
let flushTimer: number | undefined;
let resizeTimer: number | undefined;
const pendingRoots = new Set<Element>();

function shouldFreeze() {
    return settings.store.mode === "always" || document.hidden || !document.hasFocus();
}

// ---------------------------------------------------------------------------
// CSS / Web Animations
// ---------------------------------------------------------------------------

function pauseAnimation(anim: Animation) {
    if (anim.playState !== "running") return;
    if (typeof CSSTransition !== "undefined" && anim instanceof CSSTransition) return;

    const effect = anim.effect;
    if (!effect || effect.getComputedTiming().iterations !== Infinity) return;

    const target = (effect as KeyframeEffect).target;
    if (!target) return;

    const cat = classify(target, (anim as CSSAnimation).animationName ?? "");
    if (!isOn(cat)) return;

    try {
        anim.pause();
        pausedAnimations.add(anim);
        stats[cat]++;
    } catch { /* not pausable */ }
}

function pauseAnimationsIn(root: Document | Element) {
    for (const anim of root.getAnimations({ subtree: true })) pauseAnimation(anim);
}

function onAnimationStart(e: AnimationEvent) {
    if (!frozen || !(e.target instanceof Element)) return;
    for (const anim of e.target.getAnimations()) pauseAnimation(anim);
}

// ---------------------------------------------------------------------------
// Video
// ---------------------------------------------------------------------------

function pauseVideo(video: HTMLVideoElement) {
    // Never touch live streams, camera tiles or videos with player controls.
    if (video.paused || video.srcObject || video.controls) return;

    const cat = classify(video, video.currentSrc || video.src);
    // Unclassified videos are only decorative if they are muted loops.
    if (cat === "other" && !(video.loop && video.muted)) return;
    if (!isOn(cat)) return;

    video.pause();
    pausedVideos.add(video);
    stats[cat]++;
}

function onPlay(e: Event) {
    if (frozen && e.target instanceof HTMLVideoElement) pauseVideo(e.target);
}

// ---------------------------------------------------------------------------
// SVG (SMIL)
// ---------------------------------------------------------------------------

function pauseSvg(svg: SVGSVGElement) {
    try {
        if (svg.animationsPaused()) return;
        const cat = classify(svg);
        if (!isOn(cat)) return;
        svg.pauseAnimations();
        pausedSvgs.add(svg);
        stats[cat]++;
    } catch { /* SMIL not supported on this element */ }
}

// ---------------------------------------------------------------------------
// Animated images -> canvas holding the current frame
// ---------------------------------------------------------------------------

const COPIED_STYLES = [
    "position", "top", "right", "bottom", "left", "inset", "zIndex", "transform", "margin",
    "borderRadius", "clipPath", "maskImage", "objectFit", "objectPosition", "flex", "alignSelf",
    "opacity", "filter"
] as const;

const imageErrors = new WeakMap<Element, string>();

// One bad element must never abort the whole scan.
// Discord serves a static twin of most animated images. Swapping the URL keeps
// layout, masks and clipping exactly as Discord draws them, and costs nothing
// to decode. It shows the first frame rather than the current one.
interface Swap { original: string; staticSrc: string }
const swapped = new Map<HTMLImageElement, Swap>();

function staticVariant(url: string) {
    if (/\/collectibles-shop\/[^?#]*\/animated(?=[?#]|$)/.test(url)) return url.replace(/\/animated(?=[?#]|$)/, "/static");
    if (/[?&]animated=true/.test(url)) return url.replace(/([?&]animated=)true/, "$1false");
    return null;
}

function freezeImage(img: HTMLImageElement) {
    try {
        freezeImageUnsafe(img);
    } catch (e) {
        imageErrors.set(img, String(e));
        if (settings.store.debug) logger.error("freezeImage failed", img, e);
    }
}

function freezeImageUnsafe(img: HTMLImageElement) {
    if (snapshots.has(img) || swapped.has(img) || !img.isConnected) return;

    const url = img.currentSrc || img.src;
    if (!url || !ANIMATED_URL.test(url)) return;

    const cat = classify(img, url);
    if (!isOn(cat)) return;

    const staticSrc = staticVariant(url);
    const attr = img.getAttribute("src");
    if (staticSrc && attr && !img.srcset) {
        swapped.set(img, { original: attr, staticSrc });
        img.setAttribute("src", staticSrc);
        stats[cat]++;
        return;
    }

    if (!img.complete || !img.naturalWidth) {
        if (!waitingForLoad.has(img)) {
            waitingForLoad.add(img);
            img.addEventListener("load", () => {
                waitingForLoad.delete(img);
                if (frozen) freezeImage(img);
            }, { once: true });
        }
        return;
    }

    const cs = getComputedStyle(img);
    const cssW = parseFloat(cs.width);
    const cssH = parseFloat(cs.height);
    if (!cssW || !cssH) return; // not rendered (display:none etc.)

    const dpr = window.devicePixelRatio || 1;
    const canvas = document.createElement("canvas");
    canvas.dataset.focusFreeze = "true";
    // Never allocate more than the image's own size, or more than it is drawn at.
    canvas.width = Math.max(1, Math.min(img.naturalWidth, Math.ceil(cssW * dpr)));
    canvas.height = Math.max(1, Math.min(img.naturalHeight, Math.ceil(cssH * dpr)));

    try {
        // The current frame is drawn. Pixels are never read back, so a
        // cross-origin image does not taint anything we need.
        canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
    } catch { return; }

    canvas.className = img.className;
    canvas.style.display = cs.display === "inline" ? "inline-block" : cs.display;
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    for (const prop of COPIED_STYLES) canvas.style[prop as any] = cs[prop as any];
    canvas.style.pointerEvents = "none";
    canvas.setAttribute("aria-hidden", "true");

    const snapshot: Snapshot = {
        canvas,
        displayValue: img.style.getPropertyValue("display"),
        displayPriority: img.style.getPropertyPriority("display")
    };
    img.after(canvas);
    img.style.setProperty("display", "none", "important");
    snapshots.set(img, snapshot);
    stats[cat]++;
}

function restoreSwap(img: HTMLImageElement) {
    const sw = swapped.get(img);
    if (!sw) return;
    swapped.delete(img);
    if (img.getAttribute("src") === sw.staticSrc) img.setAttribute("src", sw.original);
}

function restoreImage(img: HTMLImageElement) {
    restoreSwap(img);
    restoreSnapshot(img);
}

function restoreSnapshot(img: HTMLImageElement) {
    const snapshot = snapshots.get(img);
    if (!snapshot) return;
    snapshot.canvas.remove();
    if (snapshot.displayValue) img.style.setProperty("display", snapshot.displayValue, snapshot.displayPriority);
    else img.style.removeProperty("display");
    snapshots.delete(img);
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

function scan(root: Document | Element) {
    if (root instanceof Element) {
        if (root instanceof HTMLImageElement) freezeImage(root);
        else if (root instanceof HTMLVideoElement) pauseVideo(root);
    }
    root.querySelectorAll("img").forEach(freezeImage);
    root.querySelectorAll("video").forEach(pauseVideo);
    root.querySelectorAll("svg:has(animate, animateTransform, animateMotion, set)")
        .forEach(svg => pauseSvg(svg as SVGSVGElement));
}

function pruneDisconnected() {
    for (const [img, snap] of snapshots) {
        if (!img.isConnected) {
            snap.canvas.remove();
            snapshots.delete(img);
        }
    }
    for (const img of swapped.keys()) if (!img.isConnected) swapped.delete(img);
    for (const anim of pausedAnimations) {
        const target = (anim.effect as KeyframeEffect | null)?.target;
        if (!target?.isConnected) pausedAnimations.delete(anim);
    }
    for (const video of pausedVideos) if (!video.isConnected) pausedVideos.delete(video);
    for (const svg of pausedSvgs) if (!svg.isConnected) pausedSvgs.delete(svg);
}

function flush() {
    flushTimer = undefined;
    if (!frozen) return;
    const roots = [...pendingRoots];
    pendingRoots.clear();
    pruneDisconnected();
    for (const root of roots) {
        if (!root.isConnected) continue;
        // Backup for animations animationstart missed (class toggles, WAAPI).
        pauseAnimationsIn(root);
        scan(root);
    }
}

function queueFlush() {
    if (flushTimer === undefined) flushTimer = window.setTimeout(flush, 50);
}

function onMutations(records: MutationRecord[]) {
    for (const rec of records) {
        if (rec.type === "attributes") {
            const img = rec.target;
            if (img instanceof HTMLImageElement) {
                const sw = swapped.get(img);
                if (sw && img.getAttribute("src") === sw.staticSrc) continue; // our own write
                // Source changed (new avatar etc.): drop old state, re-evaluate.
                swapped.delete(img);
                restoreSnapshot(img);
                pendingRoots.add(img);
            }
            continue;
        }
        rec.addedNodes.forEach(node => {
            if (!(node instanceof Element) || (node as HTMLElement).dataset?.focusFreeze) return;
            pendingRoots.add(node);
        });
    }
    if (pendingRoots.size) queueFlush();
}

function onResize() {
    if (!frozen || !snapshots.size) return;
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
        // Canvas sizes were fixed in px; redo them at the new layout.
        for (const img of [...snapshots.keys()]) restoreSnapshot(img);
        if (frozen) scan(document);
    }, 250);
}

// ---------------------------------------------------------------------------
// Optional: halt requestAnimationFrame loops (canvas / WebGL / Lottie)
// ---------------------------------------------------------------------------

const origRaf = window.requestAnimationFrame;
const origCaf = window.cancelAnimationFrame;
const deferredFrames = new Map<number, FrameRequestCallback>();
let fakeFrameId = 0x40000000;
let rafPatched = false;

function patchRaf() {
    if (rafPatched) return;
    rafPatched = true;
    window.requestAnimationFrame = cb => {
        const id = ++fakeFrameId;
        deferredFrames.set(id, cb);
        return id;
    };
    window.cancelAnimationFrame = id => {
        if (!deferredFrames.delete(id)) origCaf.call(window, id);
    };
}

function unpatchRaf() {
    if (!rafPatched) return;
    rafPatched = false;
    window.requestAnimationFrame = origRaf;
    window.cancelAnimationFrame = origCaf;
    const callbacks = [...deferredFrames.values()];
    deferredFrames.clear();
    for (const cb of callbacks) origRaf.call(window, cb);
}

// ---------------------------------------------------------------------------
// Freeze / thaw
// ---------------------------------------------------------------------------

function freeze() {
    if (frozen) return;
    frozen = true;
    for (const key of Object.keys(stats) as Category[]) stats[key] = 0;

    pauseAnimationsIn(document);
    scan(document);

    window.addEventListener("animationstart", onAnimationStart, true);
    window.addEventListener("play", onPlay, true);
    observer = new MutationObserver(onMutations);
    observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["src"]
    });

    if (settings.store.pauseFrameLoops && settings.store.mode === "unfocused") patchRaf();
    if (settings.store.debug) logger.info("Frozen:", { ...stats });
}

function thaw() {
    if (!frozen) return;
    frozen = false;

    observer?.disconnect();
    observer = undefined;
    window.removeEventListener("animationstart", onAnimationStart, true);
    window.removeEventListener("play", onPlay, true);
    clearTimeout(flushTimer);
    clearTimeout(resizeTimer);
    flushTimer = resizeTimer = undefined;
    pendingRoots.clear();

    unpatchRaf();

    for (const anim of pausedAnimations) {
        try { if (anim.playState === "paused") anim.play(); } catch { /* gone */ }
    }
    pausedAnimations.clear();

    for (const video of pausedVideos) {
        if (video.isConnected && video.paused) video.play().catch(() => { });
    }
    pausedVideos.clear();

    for (const svg of pausedSvgs) {
        try { if (svg.isConnected && svg.animationsPaused()) svg.unpauseAnimations(); } catch { /* gone */ }
    }
    pausedSvgs.clear();

    for (const img of [...swapped.keys()]) restoreSwap(img);
    for (const img of [...snapshots.keys()]) restoreSnapshot(img);
}

function update(reapply = false) {
    if (!active) return;
    if (reapply) thaw();
    if (shouldFreeze()) freeze();
    else thaw();
}

// ---------------------------------------------------------------------------
// Diagnostics: writes a text report so mismatched selectors can be fixed.
// ---------------------------------------------------------------------------

function trimUrl(u: string) {
    return u.length > 220 ? u.slice(0, 220) + "..." : u;
}

function ancestry(el: Element, depth = 5) {
    const parts: string[] = [];
    let cur: Element | null = el;
    for (let i = 0; cur && i < depth; i++, cur = cur.parentElement) {
        parts.push(`${cur.tagName.toLowerCase()}.${(cur.getAttribute("class") ?? "").trim().split(/\s+/).join(".")}`);
    }
    return parts.join("  <  ");
}

function describeMedia(el: Element) {
    const isImg = el instanceof HTMLImageElement;
    const raw = isImg ? (el.currentSrc || el.src)
        : el instanceof HTMLVideoElement ? (el.currentSrc || el.src)
            : (el.getAttribute("href") ?? el.getAttribute("xlink:href") ?? "");
    const cat = classify(el, raw);
    const lines = [
        `<${el.tagName.toLowerCase()}> src=${trimUrl(raw)}`,
        `  category=${cat} (setting on: ${isOn(cat)})  animatedUrl=${ANIMATED_URL.test(raw)}`,
        `  chain: ${ancestry(el)}`
    ];
    if (isImg) {
        const cs = getComputedStyle(el);
        lines.push(`  error=${imageErrors.get(el) ?? "none"}  wouldFreeze: animatedUrl=${ANIMATED_URL.test(raw)} categoryOn=${isOn(cat)} complete=${el.complete && !!el.naturalWidth} rendered=${!!parseFloat(cs.width) && !!parseFloat(cs.height)}`);
        lines.push(`  complete=${el.complete} natural=${el.naturalWidth}x${el.naturalHeight} css=${cs.width}x${cs.height} display=${cs.display} snapshotted=${snapshots.has(el)} srcSwapped=${swapped.has(el)}`);
    } else if (el instanceof HTMLVideoElement) {
        lines.push(`  paused=${el.paused} loop=${el.loop} muted=${el.muted} controls=${el.controls} srcObject=${!!el.srcObject}`);
    }
    return lines.join("\n");
}

function buildReport() {
    const out: string[] = [];
    out.push(`FocusFreeze diagnostics  ${new Date().toISOString()}`);
    out.push(`frozen=${frozen} hasFocus=${document.hasFocus()} hidden=${document.hidden}`);
    out.push(`settings=${JSON.stringify(settings.store)}`);
    out.push(`stats at last freeze=${JSON.stringify(stats)}`);
    out.push(`paused animations=${pausedAnimations.size} videos=${pausedVideos.size} svgs=${pausedSvgs.size} image snapshots=${snapshots.size} src swaps=${swapped.size}`);

    const seen = new Set<string>();
    const media = [...document.querySelectorAll(
        'img, video, svg image, canvas, [class*="avatar"] svg, [class*="avatarDecoration"], [class*="nameplate"]'
    )].filter(el => {
        if ((el as HTMLElement).dataset?.focusFreeze) return false;
        const raw = el.getAttribute("src") ?? el.getAttribute("href") ?? "";
        const interesting = /discordapp|avatar|decoration|nameplate|effect/i.test(raw + (el.getAttribute("class") ?? ""))
            || !!el.closest('[class*="avatar"]');
        if (!interesting) return false;
        const key = el.tagName + raw + (el.getAttribute("class") ?? "");
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    }).slice(0, 80);

    out.push("", `=== MEDIA CANDIDATES (${media.length}, max 80) ===`);
    for (const el of media) out.push(describeMedia(el), "");

    const loops = document.getAnimations().filter(a => a.effect?.getComputedTiming().iterations === Infinity);
    out.push(`=== ENDLESS ANIMATIONS (${loops.length}) ===`);
    const counts = new Map<string, number>();
    for (const a of loops) {
        const t = (a.effect as KeyframeEffect | null)?.target;
        const key = `${a.playState} name=${(a as CSSAnimation).animationName ?? "waapi"} cat=${t ? classify(t, (a as CSSAnimation).animationName ?? "") : "?"} ${t ? ancestry(t, 3) : ""}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const [k, n] of [...counts].sort((a, b) => b[1] - a[1]).slice(0, 40)) out.push(`${n}x ${k}`);
    return out.join("\n");
}

function runDump(delayMs: number) {
    setTimeout(() => {
        const blob = new Blob([buildReport()], { type: "text/plain" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "FocusFreeze-diagnostics.txt";
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    }, delayMs);
}

const onFocusChange = () => update();

export default definePlugin({
    name: "FocusFreeze",
    description: "Freeze Discord animations always, or only when the window is unfocused.",
    authors: [{ name: "Equadis", id: 0n }],
    settings,

    start() {
        active = true;
        window.addEventListener("focus", onFocusChange);
        window.addEventListener("blur", onFocusChange);
        window.addEventListener("resize", onResize);
        document.addEventListener("visibilitychange", onFocusChange);
        update();
    },

    stop() {
        active = false;
        window.removeEventListener("focus", onFocusChange);
        window.removeEventListener("blur", onFocusChange);
        window.removeEventListener("resize", onResize);
        document.removeEventListener("visibilitychange", onFocusChange);
        thaw();
    }
});
