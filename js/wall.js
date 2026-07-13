// ─────────── 3D climbing-wall backdrop: holds, volumes, routes, parallax ───────────
// Plain (non-module) script so the backdrop always renders even if the app modules fail.
(function () {
  'use strict';
  // Green-focused holds to match the white-wall theme (a couple of teal/mint accents).
  var PALETTE = ['#10b981', '#34d399', '#059669', '#22c55e', '#6ee7b7', '#16a34a', '#4ade80', '#047857', '#2dd4bf', '#a7f3d0'];

  function rand(a, b) { return a + Math.random() * (b - a); }
  function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
  function blobRadius() {
    function r() { return Math.round(rand(36, 64)); }
    return r() + '% ' + (100 - r()) + '% ' + r() + '% ' + (100 - r()) + '% / ' +
           r() + '% ' + r() + '% ' + (100 - r()) + '% ' + (100 - r()) + '%';
  }

  function makeHold(color, xPct, yPct, size) {
    var h = document.createElement('div');
    h.className = 'hold';
    h.style.width = size + 'px';
    h.style.height = size * rand(0.6, 1) + 'px';
    h.style.left = xPct + '%';
    h.style.top = yPct + '%';
    h.style.background = 'radial-gradient(circle at 30% 25%, rgba(255,255,255,.38), rgba(0,0,0,.28) 80%), ' + color;
    h.style.borderRadius = blobRadius();
    h.style.transform = 'rotate(' + rand(0, 360) + 'deg)';
    h.appendChild(document.createElement('i')); // bolt
    return h;
  }

  function decorate(wall, opts) {
    if (!wall) return;
    // volumes (big plywood features)
    for (var v = 0; v < (opts.volumes || 0); v++) {
      var vol = document.createElement('div');
      vol.className = 'volume';
      var vs = rand(90, 180);
      vol.style.width = vs + 'px';
      vol.style.height = vs * rand(0.5, 0.9) + 'px';
      vol.style.left = rand(5, 80) + '%';
      vol.style.top = rand(10, 75) + '%';
      vol.style.transform = 'rotate(' + rand(-30, 30) + 'deg)';
      wall.appendChild(vol);
    }
    // routes: same-colored holds in a wandering vertical line (like a set problem)
    for (var r = 0; r < (opts.routes || 0); r++) {
      var color = pick(PALETTE);
      var x = rand(12, 82);
      var n = Math.round(rand(6, 9));
      for (var i = 0; i < n; i++) {
        var y = 92 - (i / (n - 1)) * 84 + rand(-3, 3);
        x = Math.max(4, Math.min(90, x + rand(-9, 9)));
        wall.appendChild(makeHold(color, x, y, rand(18, 34)));
      }
    }
    // random scatter
    for (var s = 0; s < (opts.scatter || 0); s++) {
      wall.appendChild(makeHold(pick(PALETTE), rand(2, 93), rand(2, 92), rand(14, 46)));
    }
  }

  decorate(document.getElementById('wallMain'), { volumes: 3, routes: 3, scatter: 26 });
  decorate(document.getElementById('wallSide'), { volumes: 1, routes: 1, scatter: 10 });

  // Footer: both characters wave (on load, periodically, and on click); the chalk bag
  // wiggles and puffs white chalk when tapped.
  (function () {
    var scene = document.getElementById('counterScene');
    if (!scene) return;
    var arms = scene.querySelectorAll('.wave-a, .wave-b');
    function wave() {
      arms.forEach(function (a) {
        a.classList.remove('waving');
        void a.getBoundingClientRect();   // reflow so the animation restarts
        a.classList.add('waving');
      });
    }
    arms.forEach(function (a) {
      a.addEventListener('animationend', function () { a.classList.remove('waving'); });
    });
    scene.addEventListener('click', wave);
    scene.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); wave(); } });

    var chalk = document.getElementById('chalkBag');
    if (chalk) {
      var chalkBusy = false;
      function puff(e) {
        if (e) e.stopPropagation();        // chalk click shouldn't also wave
        if (chalkBusy) return;
        chalkBusy = true;
        chalk.classList.add('shaking', 'puffing');
        setTimeout(function () { chalk.classList.remove('shaking', 'puffing'); chalkBusy = false; }, 850);
      }
      chalk.addEventListener('click', puff);
      chalk.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); puff(e); } });
    }

    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setTimeout(wave, 1200);
      setInterval(wave, 6500);
    }
  })();

  // Pointer parallax via perspective-origin (doesn't fight the keyframe camera animation)
  var scene = document.getElementById('scene');
  var reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (scene && !reduced && matchMedia('(pointer: fine)').matches) {
    var tx = 50, ty = 45, cx = 50, cy = 45, raf = null;
    document.addEventListener('mousemove', function (e) {
      tx = 50 + (e.clientX / innerWidth - 0.5) * 10;
      ty = 45 + (e.clientY / innerHeight - 0.5) * 8;
      if (!raf) raf = requestAnimationFrame(step);
    }, { passive: true });
    function step() {
      cx += (tx - cx) * 0.06;
      cy += (ty - cy) * 0.06;
      scene.style.perspectiveOrigin = cx.toFixed(2) + '% ' + cy.toFixed(2) + '%';
      raf = (Math.abs(tx - cx) + Math.abs(ty - cy) > 0.05) ? requestAnimationFrame(step) : null;
    }
  }
})();
