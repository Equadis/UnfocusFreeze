# UnfocusFreeze (Vencord userplugin, plugin name: FocusFreeze)

Freezes Discord's decorative animations on their current frame, either **always** or **only while Discord is unfocused / hidden**. Nothing is hidden or removed.

## Settings
| Setting | Default |
|---|---|
| Animation mode: Always disabled / Disabled when unfocused | Unfocused |
| Freeze animated avatars | On |
| Freeze avatar decorations | On |
| Freeze profile effects | On |
| Freeze nameplates and name styles | On |
| Freeze animated role colours | On |
| Freeze other UI animations | On |
| Experimental: halt JS animation loops (canvas / WebGL / Lottie), unfocused mode only | Off |
| Debug: log per-category freeze counts | Off |

"Enable FocusFreeze" is Vencord's own plugin toggle.

## How each type is frozen
- **CSS animations**: paused in place (`Animation.pause()`), so the current frame stays. Only *endless* loops are paused. Finite animations and transitions keep running so menus never stick half-open. Newly started loops are caught via `animationstart`.
- **Animated images** (GIF, animated WebP, animated APNG): the current frame is drawn into a same-size canvas that takes the image's place in the layout. The original `<img>` is hidden, then restored on resume.
- **Video** (nameplates, decorations, profile effects, muted looping videos): paused and resumed. Live streams, camera tiles and videos with player controls are never touched.
- **SVG SMIL**: `pauseAnimations()`.
- **Canvas / WebGL / Lottie** (experimental toggle): `requestAnimationFrame` callbacks are held back while unfocused and released on focus. Not offered in "Always" mode, because it would also stall animated UI such as popouts.

## Verified
Type-checks clean against stub Vencord types. Ran in headless Edge against a test page: CSS loop pause/resume, per-category toggles, late-added elements, GIF canvas swap and restore (radius, class and size copied), clean restore on stop, rAF hold and release.

## NOT verified
- Real Discord. Category matching uses Discord's hashed class-name prefixes (`avatarDecoration`, `nameplate`, `profileEffect`, ...) and CDN URL patterns, which are best guesses. Turn on **Debug** and check the console: if a cosmetic lands under "other", its selector needs adding in `SELECTOR_RULES` / `URL_RULES`.
- Video pausing and focus events (headless Edge has no real focus).
- Animations Discord drives from a `requestAnimationFrame` reference it captured before the plugin loaded, and CSS `background-image` GIFs, cannot be reached.

## Install
1. Follow [Vencord's source build guide](https://docs.vencord.dev/installing/) and [custom plugin guide](https://docs.vencord.dev/installing/custom-plugins/).
2. Copy `index.tsx` and `README.md` into `Vencord/src/userplugins/FocusFreeze/`.
3. Run `pnpm build`, inject your custom build, restart Discord, enable **FocusFreeze**.

A prebuilt Vencord cannot load source userplugins.

## Notes
- Client-side only. Other users' cosmetics are unchanged.
- If `AlwaysAnimate` or similar plugins are active, behaviour may conflict.
