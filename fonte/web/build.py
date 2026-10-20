#!/usr/bin/env python3
"""Monta o PWA Maré em dist/: index.html (núcleo embutido), manifest, service worker e ícones."""
import json, os, shutil
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC, DIST = os.path.join(ROOT, "src"), os.path.join(ROOT, "dist")
shutil.rmtree(DIST, ignore_errors=True)
os.makedirs(DIST)

core = open(os.path.join(SRC, "core.js"), encoding="utf-8").read()
core = core.replace("if (typeof module !== 'undefined') module.exports = Core;", "")
html = open(os.path.join(SRC, "app.html"), encoding="utf-8").read()
assert "/*CORE*/" in html
open(os.path.join(DIST, "index.html"), "w", encoding="utf-8").write(html.replace("/*CORE*/", core))

manifest = {
    "name": "Maré — despertador de ciclo",
    "short_name": "Maré",
    "description": "Acompanha o sono pelo acelerômetro e microfone e acorda você no sono leve.",
    "lang": "pt-BR",
    "start_url": "./",
    "scope": "./",
    "display": "standalone",
    "orientation": "portrait",
    "background_color": "#0b0d14",
    "theme_color": "#0b0d14",
    "icons": [
        {"src": "icon-192.png", "sizes": "192x192", "type": "image/png"},
        {"src": "icon-512.png", "sizes": "512x512", "type": "image/png"},
        {"src": "icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"},
    ],
}
json.dump(manifest, open(os.path.join(DIST, "manifest.webmanifest"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)

SW = """const V = 'mare-v5';
const CORE = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(V).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET') return;
  const u = new URL(r.url);
  const cacheable = u.origin === location.origin || /fonts\\.(googleapis|gstatic)\\.com$/.test(u.hostname);
  if (!cacheable) return;
  // cache primeiro (funciona offline à noite), atualiza em segundo plano
  e.respondWith(caches.open(V).then(c => c.match(r).then(hit => {
    const net = fetch(r).then(res => { if (res && (res.ok || res.type === 'opaque')) c.put(r, res.clone()); return res; }).catch(() => hit);
    return hit || net;
  })));
});
"""
open(os.path.join(DIST, "sw.js"), "w", encoding="utf-8").write(SW)

# ---------- ícones: lua crescente âmbar sobre azul-noite, com a "maré" (hipnograma) embaixo ----------
NIGHT, EMBER, BLUE = (11, 13, 20), (255, 157, 92), (97, 152, 234)

def icon(size, maskable=False, radius=True):
    S = size * 4
    img = Image.new("RGBA", (S, S), NIGHT + (255,) if maskable or not radius else (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if radius and not maskable:
        d.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.22), fill=NIGHT + (255,))
    k = 0.72 if maskable else 1.0          # zona segura do maskable
    c, r = S / 2, S * 0.27 * k
    cx, cy = c - S * 0.03 * k, c - S * 0.08 * k
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=EMBER + (255,))
    bg = NIGHT + (255,)
    off = r * 0.55
    d.ellipse([cx - r + off, cy - r - off * 0.45, cx + r + off, cy + r - off * 0.45], fill=bg)
    # hipnograma em degraus
    y0 = c + S * 0.24 * k
    xs = [c - S * 0.30 * k + i * (S * 0.60 * k / 8) for i in range(9)]
    lv = [0, 1, 2, 1, 0, 1, 2, 1, 0]
    h = S * 0.045 * k
    pts = []
    for i in range(8):
        y = y0 + (lv[i] - 1) * h
        pts += [(xs[i], y), (xs[i + 1], y)]
    d.line(pts, fill=BLUE + (255,), width=int(S * 0.028 * k), joint="curve")
    return img.resize((size, size), Image.LANCZOS)

icon(192).save(os.path.join(DIST, "icon-192.png"))
icon(512).save(os.path.join(DIST, "icon-512.png"))
icon(180, radius=False).save(os.path.join(DIST, "icon-180.png"))
icon(512, maskable=True).save(os.path.join(DIST, "icon-maskable-512.png"))

print("ok:", sorted(os.listdir(DIST)))
