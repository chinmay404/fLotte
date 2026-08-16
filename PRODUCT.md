# Product

## Register

product

## Users

fLotte Berlin cargo-bike borrowers and volunteer repair mechanics. Mostly on a
phone, outdoors, mid-journey — one hand, bright light, low patience. A session
is seconds long: "where's my bike, how do I get there, what's next".

## Product Purpose

Give the user the optimal path: the fastest way to a free cargo bike right now
(walk / bike / transit compared honestly), and for mechanics, the best visiting
order over all flagged defective bikes ("Optimal path" round). Secondary:
show the public transport options that serve that path, with real departures.
Success = the user taps at most twice between opening the app and moving.

## Brand Personality

Easy, distraction-free, trustworthy. fLotte's own measured brand carries the
identity: green #7FC600, orange #EE7400, navy #004B7C, Inter, and the
dataset's 13 official district colours. The interface stays quiet so the map
and the route are the loudest things on screen.

## Anti-references

- Dashboard-y clutter: stat tiles, dense filter walls, always-visible chrome.
- Hobby-GIS maps: 250 loud markers at every zoom, popup soup, layer switchers.
- Fake certainty: placeholder shapes, beeline fallbacks, decayed cached times
  (absence is honest; estimates are labelled).

## Design Principles

1. Map first, list second — on mobile the map is the screen; results live in a
   sheet the thumb controls.
2. One obvious next action per state (Go, pick a start, drag up for more).
3. Everything ranked is comparable: same units, same base moment, waiting
   included.
4. Declutter by state: an active trip hides everything that is not the route,
   the candidates, or where you have been.
5. Earned familiarity: Google-Maps-shaped affordances, fLotte-skinned.

## Accessibility & Inclusion

WCAG AA contrast (fLotte's raw green fails on white; text-greens are darkened
to #3D6B00). Reduced-motion honoured everywhere including sheet snaps. Touch
targets ≥44px on mobile. Keyboard flow (1–9 / Enter / Esc) on desktop.
